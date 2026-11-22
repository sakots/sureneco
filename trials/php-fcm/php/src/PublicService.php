<?php

declare(strict_types=1);

namespace Sureneco\FcmTrial;

use Closure;
use PDO;

final class PublicService
{
    private const MAX_DEVICES = 16;
    private const MAX_PROOF_SENDERS = 3;
    private const CHALLENGE_TTL = 120;
    private const MAX_WRONG_CODES = 5;
    private const RATE_WINDOW = 300;
    private const CYCLE_BUDGET_NS = 35_000_000_000;
    private const CYCLE_CACHE_BYTES = 24 * 1024 * 1024;
    private const DEFAULT_CONFIG = '{"enabled":true,"filter":"loose","thread_refresh_sec":300}';

    private readonly string $state;
    private readonly Closure $challenge;
    private readonly Closure $deliver;
    private readonly Closure $fetch;
    private readonly Closure $now;
    private ?Configuration $fcm = null;
    private ?Sender $sender = null;
    private ?PDO $db = null;

    public function __construct(
        private readonly string $root,
        ?Closure $challenge = null,
        ?Closure $deliver = null,
        ?Closure $fetch = null,
        ?Closure $now = null,
    ) {
        if ($root === '/' || !str_starts_with($root, '/') || str_contains($root, "\0") || realpath($root) !== $root) {
            throw new SafeFailure('invalid_state_path');
        }
        $this->state = "$root/state";
        self::privatePath($root, 0040700, false);
        self::privatePath($this->state, 0040700, false);
        $this->challenge = $challenge ?? function (#[\SensitiveParameter] string $token, #[\SensitiveParameter] array $data): void {
            $config = $this->fcm();
            $this->sender->sendPublicChallenge($config, $token, $data['challengeId'], $data['code'], (int) $data['expiresAt']);
        };
        $this->deliver = $deliver ?? function (
            #[\SensitiveParameter] string $token, string $id, int $number, array $rooms, int $expiry,
        ): array {
            $config = $this->fcm();
            return $this->sender->sendPublicRecruitment($config, $token, $id, $number, $rooms, $expiry);
        };
        $this->fetch = $fetch ?? MonitorIo::fetch(...);
        $this->now = $now ?? time(...);
    }

    public function begin(
        #[\SensitiveParameter] string $token,
        #[\SensitiveParameter] string $bearer,
        string $address,
    ): array {
        $address = self::addressKey($address);
        for ($slot = 1; $slot <= self::MAX_PROOF_SENDERS; ++$slot) {
            $sender = $this->lock("proof-send-$slot.lock");
            if ($sender === null) {
                continue;
            }
            try {
                return $this->sendProof($token, $bearer, $address);
            } finally {
                fclose($sender);
            }
        }
        throw new SafeFailure('monitor_busy');
    }

    private function sendProof(
        #[\SensitiveParameter] string $token,
        #[\SensitiveParameter] string $bearer,
        string $address,
    ): array {
        $bearerHash = hash('sha256', $bearer);
        $tokenHash = hash('sha256', $token);
        $id = bin2hex(random_bytes(16));
        $code = bin2hex(random_bytes(32));
        $expires = $this->write(function (PDO $db) use ($address, $bearerHash, $tokenHash, $token, $id, $code): int {
            $now = ($this->now)();
            self::expire($db, $now);
            if (self::device($db, $bearerHash) === null && self::deviceCount($db) >= self::MAX_DEVICES) {
                throw new SafeFailure('capacity');
            }
            $query = $db->prepare('SELECT COUNT(*) AS total, SUM(address = ?) AS source,
                SUM(token_hash = ?) AS destination, SUM(bearer_hash = ?) AS bearer FROM attempts');
            $query->execute([$address, $tokenHash, $bearerHash]);
            $counts = $query->fetch();
            $query->closeCursor();
            if ($counts['total'] >= 24 || $counts['source'] >= 6 || $counts['destination'] >= 3 || $counts['bearer'] >= 3) {
                throw new SafeFailure('rate_limited');
            }
            $expires = $now + self::CHALLENGE_TTL;
            $db->prepare('INSERT INTO attempts (issued_at, address, token_hash, bearer_hash) VALUES (?, ?, ?, ?)')
                ->execute([$now, $address, $tokenHash, $bearerHash]);
            $db->prepare('INSERT INTO challenges (id, bearer_hash, token_hash, token, code_hash, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)')->execute([$id, $bearerHash, $tokenHash, $token, hash('sha256', $code), $expires]);
            return $expires;
        });
        // Commit before network IO; an ambiguous response consumes allowance and may still reach the device.
        ($this->challenge)($token, ['type' => 'registration_challenge', 'challengeId' => $id,
            'code' => $code, 'expiresAt' => (string) $expires]);
        return ['challengeId' => $id];
    }

    public function finish(
        string $id,
        #[\SensitiveParameter] string $code,
        #[\SensitiveParameter] string $bearer,
    ): array {
        $bearerHash = hash('sha256', $bearer);
        // Unknown IDs and wrong bearers do not contend for the registry write lock.
        if ($this->pendingProof($this->db(), $id, $bearerHash) === null) {
            throw new SafeFailure('invalid_challenge');
        }
        $lock = null;
        try {
            $verified = $this->write(function (PDO $db) use ($id, $code, $bearerHash, &$lock): bool {
                $proof = $this->pendingProof($db, $id, $bearerHash);
                if ($proof === null) {
                    return false;
                }
                if (!hash_equals($proof['code_hash'], hash('sha256', $code))) {
                    if ($proof['completed'] === 0) {
                        $db->prepare('UPDATE challenges SET wrong_codes = wrong_codes + 1 WHERE id = ?')->execute([$id]);
                    }
                    return false;
                }
                $device = self::device($db, $bearerHash);
                if ($proof['completed'] !== 0) {
                    return $device !== null && hash_equals($proof['token_hash'], hash('sha256', $device['registration_token']));
                }
                $query = $db->prepare('SELECT bearer_hash FROM devices WHERE registration_token = ?');
                $query->execute([$proof['token']]);
                $owner = $query->fetchColumn();
                $query->closeCursor();
                if ($owner !== false && !hash_equals($owner, $bearerHash)) {
                    return false;
                }
                $slot = $device['slot'] ?? self::freeSlot($db);
                $lock = $this->lock("device-$slot.lock");
                if ($lock === null) {
                    throw new SafeFailure('monitor_busy');
                }
                if ($device === null) {
                    $this->resetSlot($slot, true);
                    $db->prepare('INSERT INTO devices (slot, bearer_hash, registration_token) VALUES (?, ?, ?)')
                        ->execute([$slot, $bearerHash, $proof['token']]);
                    $db->prepare('DELETE FROM retired WHERE slot = ?')->execute([$slot]);
                } else {
                    $db->prepare('UPDATE devices SET registration_token = ? WHERE slot = ?')->execute([$proof['token'], $slot]);
                }
                // Other outstanding proofs cannot roll back this binding, even if their delivery was delayed.
                $db->prepare('DELETE FROM challenges WHERE bearer_hash = ? AND id != ?')->execute([$bearerHash, $id]);
                $db->prepare('UPDATE challenges SET token = NULL, completed = 1 WHERE id = ?')->execute([$id]);
                return true;
            });
        } finally {
            if ($lock !== null) {
                fclose($lock);
            }
        }
        if (!$verified) {
            throw new SafeFailure('invalid_challenge');
        }
        return ['registered' => true];
    }

    public function selection(
        #[\SensitiveParameter] string $bearer, ?string $id = null, ?bool $enabled = null, ?array $settings = null,
    ): array {
        return $this->withDevice($bearer, fn (array $device): array =>
            $this->monitor($device['slot'])->deviceSelection($id, $enabled, $settings));
    }

    public function setEnabled(#[\SensitiveParameter] string $bearer, bool $enabled): array
    {
        return $this->withDevice($bearer, function (array $device) use ($enabled): array {
            $status = $this->monitor($device['slot'])->setEnabled($enabled);
            return ['enabled' => $status['enabled']];
        });
    }

    public function delete(#[\SensitiveParameter] string $bearer): array
    {
        return $this->withDevice($bearer, function (array $device): array {
            $slot = $device['slot'];
            $this->write(static function (PDO $db) use ($device, $slot): void {
                $db->prepare('DELETE FROM challenges WHERE bearer_hash = ? OR token_hash = ?')
                    ->execute([$device['bearer_hash'], hash('sha256', $device['registration_token'])]);
                $db->prepare('INSERT INTO retired (slot) VALUES (?)')->execute([$slot]);
                $db->prepare('DELETE FROM devices WHERE slot = ?')->execute([$slot]);
            });
            // If the process stops after revocation, cron or subsequent reuse completes the bounded cleanup.
            $this->resetSlot($slot, false);
            $this->db()->prepare('DELETE FROM retired WHERE slot = ?')->execute([$slot]);
            return ['deleted' => true];
        });
    }

    public function tick(): array
    {
        $run = $this->lock('public-run.lock');
        if ($run === null) {
            return ['status' => 'busy'];
        }
        $deadline = hrtime(true) + self::CYCLE_BUDGET_NS;
        try {
            $this->write(fn (PDO $db) => self::expire($db, ($this->now)()));
            $db = $this->db();
            $errors = false;
            foreach ($db->query('SELECT slot FROM retired')->fetchAll(PDO::FETCH_COLUMN) as $slot) {
                $lock = $this->lock("device-$slot.lock");
                if ($lock === null) {
                    continue;
                }
                try {
                    $retired = $db->prepare('SELECT 1 FROM retired WHERE slot = ?');
                    $retired->execute([$slot]);
                    $cleanup = $retired->fetchColumn() !== false;
                    $retired->closeCursor();
                    if ($cleanup) {
                        $this->resetSlot($slot, false);
                        $db->prepare('DELETE FROM retired WHERE slot = ?')->execute([$slot]);
                    }
                } catch (\Throwable) {
                    $errors = true;
                } finally {
                    fclose($lock);
                }
            }
            $start = (int) $db->query('SELECT next_slot FROM scheduler')->fetchColumn();
            $slots = $db->query('SELECT slot FROM devices ORDER BY slot')->fetchAll(PDO::FETCH_COLUMN);
            $slots = [...array_filter($slots, static fn (int $slot): bool => $slot >= $start),
                ...array_filter($slots, static fn (int $slot): bool => $slot < $start)];
            $cache = [];
            $bytes = 0;
            $stop = false;
            $monitor = new RecruitmentMonitor(function (string $resource) use (&$cache, &$bytes, &$stop, $deadline): string {
                if (isset($cache[$resource])) {
                    if ($cache[$resource] === false) {
                        throw new SafeFailure('fetch_failed');
                    }
                    return $cache[$resource];
                }
                if ($stop || hrtime(true) >= $deadline) {
                    throw new SafeFailure('budget_exhausted');
                }
                // Cache failures as well, so a down upstream is never retried within the same cycle.
                $cache[$resource] = false;
                $text = ($this->fetch)($resource);
                $length = strlen($text);
                if ($length > self::CYCLE_CACHE_BYTES - $bytes) {
                    $stop = true;
                    throw new SafeFailure('budget_exhausted');
                }
                $bytes += $length;
                return $cache[$resource] = $text;
            });
            $processed = $busy = 0;
            $remaining = count($slots);
            foreach ($slots as $slot) {
                if ($stop || hrtime(true) >= $deadline) {
                    break;
                }
                // Persist before any potentially slow work; a forcibly killed cycle resumes fairly.
                $db->prepare('UPDATE scheduler SET next_slot = ?')->execute([$slot % self::MAX_DEVICES + 1]);
                --$remaining;
                $lock = $this->lock("device-$slot.lock");
                if ($lock === null) {
                    ++$busy;
                    continue;
                }
                try {
                    $read = $db->prepare('SELECT registration_token FROM devices WHERE slot = ?');
                    $read->execute([$slot]);
                    $token = $read->fetchColumn();
                    $read->closeCursor();
                    if ($token === false) {
                        continue;
                    }
                    ++$processed;
                    $result = $this->monitor($slot, $monitor,
                        function (string $id, int $number, array $rooms, int $expiry) use ($token, $deadline): array {
                            if (hrtime(true) >= $deadline) {
                                throw new SafeFailure('budget_exhausted');
                            }
                            return ($this->deliver)($token, $id, $number, $rooms, $expiry);
                        })->tick($deadline);
                    $errors = $errors || $result['ok'] !== true;
                } catch (\Throwable) {
                    $errors = true;
                } finally {
                    fclose($lock);
                }
            }
            return ['status' => $errors || $remaining > 0 ? 'degraded' : 'idle',
                'processed' => $processed, 'busy' => $busy, 'remaining' => $remaining];
        } finally {
            fclose($run);
        }
    }

    private function monitor(int $slot, ?RecruitmentMonitor $monitor = null, ?Closure $send = null): PersistentMonitor
    {
        return new PersistentMonitor("$this->state/device-$slot", $monitor, $send, publicDevice: true);
    }

    private function withDevice(#[\SensitiveParameter] string $bearer, Closure $operation): array
    {
        $db = $this->db();
        $hash = hash('sha256', $bearer);
        $device = self::device($db, $hash) ?? throw new SafeFailure('unauthorized');
        $lock = $this->lock('device-' . $device['slot'] . '.lock') ?? throw new SafeFailure('monitor_busy');
        try {
            // The slot could have been revoked and reused between lookup and lock acquisition.
            $current = self::device($db, $hash);
            if ($current === null || $current['slot'] !== $device['slot']) {
                throw new SafeFailure('unauthorized');
            }
            return $operation($current);
        } finally {
            fclose($lock);
        }
    }

    private function pendingProof(PDO $db, string $id, string $bearerHash): ?array
    {
        $query = $db->prepare('SELECT * FROM challenges WHERE id = ? AND expires_at > ?');
        $query->execute([$id, ($this->now)()]);
        $proof = $query->fetch();
        if ($proof === false || !hash_equals($proof['bearer_hash'], $bearerHash) || $proof['wrong_codes'] >= self::MAX_WRONG_CODES) {
            return null;
        }
        return $proof;
    }

    private static function device(PDO $db, string $hash): ?array
    {
        $query = $db->prepare('SELECT * FROM devices WHERE bearer_hash = ?');
        $query->execute([$hash]);
        return $query->fetch() ?: null;
    }

    private static function deviceCount(PDO $db): int
    {
        return (int) $db->query('SELECT COUNT(*) FROM devices')->fetchColumn();
    }

    private static function freeSlot(PDO $db): int
    {
        $used = array_fill_keys($db->query('SELECT slot FROM devices')->fetchAll(PDO::FETCH_COLUMN), true);
        for ($slot = 1; $slot <= self::MAX_DEVICES; ++$slot) {
            if (!isset($used[$slot])) {
                return $slot;
            }
        }
        throw new SafeFailure('capacity');
    }

    private static function expire(PDO $db, int $now): void
    {
        $db->prepare('DELETE FROM challenges WHERE expires_at <= ?')->execute([$now]);
        $db->prepare('DELETE FROM attempts WHERE issued_at <= ?')->execute([$now - self::RATE_WINDOW]);
    }

    private static function addressKey(string $address): string
    {
        $raw = @inet_pton($address);
        if ($raw === false) {
            throw new SafeFailure('invalid_request');
        }
        if (strlen($raw) === 4) {
            return bin2hex($raw);
        }
        // Normalize mapped IPv4 addresses; account for clients rotating IPv6 host bits within their /64.
        return bin2hex(str_starts_with($raw, str_repeat("\0", 10) . "\xff\xff") ? substr($raw, 12) : substr($raw, 0, 8));
    }

    private function db(): PDO
    {
        if ($this->db !== null) {
            return $this->db;
        }
        $path = "$this->state/registry.sqlite";
        $file = self::openPrivate($path);
        fclose($file);
        $mask = umask(0077);
        try {
            foreach (['-journal', '-wal', '-shm'] as $suffix) {
                self::privatePath($path . $suffix, 0100600);
            }
            $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_TIMEOUT => 1, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
            $db->exec('PRAGMA secure_delete = ON');
            if ((int) $db->query('PRAGMA user_version')->fetchColumn() === 0) {
                self::transaction($db, static function (PDO $db): void {
                    $db->exec('CREATE TABLE IF NOT EXISTS devices (slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND ' . self::MAX_DEVICES . '),
                        bearer_hash TEXT NOT NULL UNIQUE, registration_token TEXT NOT NULL UNIQUE);
                        CREATE TABLE IF NOT EXISTS attempts (issued_at INTEGER NOT NULL, address TEXT NOT NULL,
                        token_hash TEXT NOT NULL, bearer_hash TEXT NOT NULL);
                        CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, bearer_hash TEXT NOT NULL, token_hash TEXT NOT NULL,
                        token TEXT, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
                        wrong_codes INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0);
                        CREATE TABLE IF NOT EXISTS retired (slot INTEGER PRIMARY KEY);
                        CREATE TABLE IF NOT EXISTS scheduler (id INTEGER PRIMARY KEY CHECK(id = 1), next_slot INTEGER NOT NULL);
                        INSERT OR IGNORE INTO scheduler (id, next_slot) VALUES (1, 1);
                        PRAGMA user_version = 1');
                });
            }
            if ((int) $db->query('PRAGMA user_version')->fetchColumn() !== 1) {
                throw new SafeFailure('invalid_state_file');
            }
            return $this->db = $db;
        } finally {
            umask($mask);
        }
    }

    private function write(Closure $operation): mixed
    {
        $mask = umask(0077);
        try {
            return self::transaction($this->db(), $operation);
        } finally {
            umask($mask);
        }
    }

    private static function transaction(PDO $db, Closure $operation): mixed
    {
        $db->exec('BEGIN IMMEDIATE');
        try {
            $result = $operation($db);
            $db->exec('COMMIT');
            return $result;
        } catch (\Throwable $error) {
            $db->exec('ROLLBACK');
            throw $error;
        }
    }

    private function fcm(): Configuration
    {
        if ($this->fcm === null) {
            $directory = "$this->root/secrets";
            self::privatePath($directory, 0040700, false);
            foreach (['service-account.json', 'google-services.json'] as $file) {
                self::privatePath("$directory/$file", 0100600, false);
            }
            $this->fcm = Configuration::loadPublic("$directory/service-account.json", "$directory/google-services.json");
            $this->sender = new Sender();
        }
        return $this->fcm;
    }

    private function resetSlot(int $slot, bool $initialize): void
    {
        $root = "$this->state/device-$slot";
        foreach ([$root, "$root/state"] as $directory) {
            if (self::privatePath($directory, 0040700) === null && $initialize && !@mkdir($directory, 0700)) {
                throw new SafeFailure('state_unavailable');
            }
        }
        foreach (['config.json', 'config.json.tmp', 'state/run.lock', 'state/runtime.json', 'state/runtime.json.tmp',
            'state/status.json', 'state/status.json.tmp', 'state/monitor.sqlite', 'state/monitor.sqlite.lock',
            'state/monitor.sqlite-journal', 'state/monitor.sqlite-wal', 'state/monitor.sqlite-shm'] as $file) {
            $path = "$root/$file";
            if (self::privatePath($path, 0100600) !== null && !@unlink($path)) {
                throw new SafeFailure('state_unavailable');
            }
        }
        if ($initialize) {
            $file = self::openPrivate("$root/config.json");
            try {
                if (fwrite($file, self::DEFAULT_CONFIG) !== strlen(self::DEFAULT_CONFIG) || !fflush($file)
                    || (function_exists('fsync') && !fsync($file))) {
                    throw new SafeFailure('state_unavailable');
                }
            } finally {
                fclose($file);
            }
        }
    }

    /** @return resource|null */
    private function lock(string $name)
    {
        $stream = self::openPrivate("$this->state/$name");
        if (!flock($stream, LOCK_EX | LOCK_NB)) {
            fclose($stream);
            return null;
        }
        return $stream;
    }

    /** @return resource */
    private static function openPrivate(string $path)
    {
        self::privatePath($path, 0100600);
        $mask = umask(0077);
        try {
            $file = @fopen($path, 'c+b');
        } finally {
            umask($mask);
        }
        if ($file === false) {
            throw new SafeFailure('state_unavailable');
        }
        try {
            $opened = fstat($file);
            $stat = self::privatePath($path, 0100600, false);
            if ($opened === false || $opened['dev'] !== $stat['dev'] || $opened['ino'] !== $stat['ino']) {
                throw new SafeFailure('invalid_state_path');
            }
            return $file;
        } catch (\Throwable $error) {
            fclose($file);
            throw $error;
        }
    }

    private static function privatePath(string $path, int $mode, bool $optional = true): ?array
    {
        clearstatcache(true, $path);
        $stat = @lstat($path);
        if ($stat === false && $optional) {
            return null;
        }
        if ($stat === false || ($stat['mode'] & 0177777) !== $mode || ($mode === 0100600 && $stat['nlink'] !== 1)
            || (function_exists('posix_geteuid') && $stat['uid'] !== posix_geteuid())) {
            throw new SafeFailure('invalid_state_path');
        }
        return $stat;
    }
}
