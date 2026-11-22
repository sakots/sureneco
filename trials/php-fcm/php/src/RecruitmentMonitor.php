<?php

declare(strict_types=1);

namespace Sureneco\FcmTrial;

use Closure;
use PDO;

final class RecruitmentMonitor
{
    private readonly Closure $fetch;

    public function __construct(?Closure $fetch = null)
    {
        $this->fetch = $fetch ?? MonitorIo::fetch(...);
    }

    public function listThreads(?int $now = null): array
    {
        $text = ($this->fetch)('subject.txt');
        return MonitorIo::detect(['operation' => 'list', 'text' => $text, 'now' => $now ?? self::now()]);
    }

    public function scan(string $threadId, string $path, string $filter = 'regex', ?int $now = null): array
    {
        return $this->run($threadId, $path, $filter, $now, null);
    }

    /** $send returns an FCM acceptance receipt or throws, leaving the recruitment queued. */
    public function deliver(string $threadId, string $path, string $filter, Closure $send, ?int $now = null): array
    {
        return $this->run($threadId, $path, $filter, $now, $send);
    }

    private function run(string $threadId, string $path, string $filter, ?int $now, ?Closure $send): array
    {
        if (preg_match('/\A[0-9]{9,11}\z/', $threadId) !== 1 || !in_array($filter, ['regex', 'loose'], true)) {
            throw new SafeFailure('invalid_arguments');
        }
        if (!str_starts_with($path, '/') || str_contains($path, "\0") || !str_ends_with($path, '.sqlite')) {
            throw new SafeFailure('invalid_state_path');
        }
        $directory = realpath(dirname($path));
        $permissions = $directory === false ? false : fileperms($directory);
        if ($permissions === false || !is_dir($directory) || ($permissions & 0777) !== 0700) {
            throw new SafeFailure('invalid_state_path');
        }
        $path = $directory . '/' . basename($path);
        $lockPath = $path . '.lock';
        self::requirePrivateFileIfPresent($lockPath);
        $mask = umask(0077);
        try {
            $lock = @fopen($lockPath, 'c+b');
            if ($lock === false) {
                throw new SafeFailure('state_unavailable');
            }
            try {
                if (!flock($lock, LOCK_EX | LOCK_NB)) {
                    throw new SafeFailure('monitor_busy');
                }
                self::requirePrivateFileIfPresent($path);
                $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_TIMEOUT => 1]);
                $scan = $this->scanLocked($threadId, $db, $filter, $now);
                if ($send !== null) {
                    unset($scan['recruitments']);
                    $scan['delivery'] = $this->deliverLocked($db, $threadId, $now ?? self::now(), $send);
                }
                return $scan;
            } finally {
                fclose($lock);
            }
        } finally {
            umask($mask);
        }
    }

    private function scanLocked(string $threadId, PDO $db, string $filter, ?int $now): array
    {
        $db->exec('CREATE TABLE IF NOT EXISTS cursors (thread_id TEXT PRIMARY KEY, last_post INTEGER NOT NULL)');
        $db->exec('CREATE TABLE IF NOT EXISTS detected_recruitments (
            thread_id TEXT NOT NULL, post_number INTEGER NOT NULL, expires_at INTEGER NOT NULL,
            payload_json TEXT NOT NULL, PRIMARY KEY (thread_id, post_number))');
        $read = $db->prepare('SELECT last_post FROM cursors WHERE thread_id = ?');
        $read->execute([$threadId]);
        $last = $read->fetchColumn();
        $read->closeCursor();
        $after = $last === false ? null : (int) $last;
        $text = ($this->fetch)("dat/$threadId.dat");
        $now ??= self::now();
        $saved = $db->prepare('SELECT payload_json, expires_at FROM detected_recruitments WHERE thread_id = ? AND expires_at > ?');
        $saved->execute([$threadId, $now]);
        $previous = [];
        while (($row = $saved->fetch(PDO::FETCH_ASSOC)) !== false) {
            $item = json_decode($row['payload_json'], true, 64, JSON_THROW_ON_ERROR);
            $item['expiresAt'] = (int) $row['expires_at'];
            $previous[] = $item;
        }
        $saved->closeCursor();
        $detected = MonitorIo::detect([
            'operation' => 'scan', 'text' => $text, 'threadId' => $threadId,
            'after' => $after, 'filter' => $filter, 'now' => $now,
            'previous' => $previous,
        ]);
        if ($after !== null && $detected['lastPost'] < $after) {
            throw new SafeFailure('dat_regressed');
        }
        $db->beginTransaction();
        try {
            $write = $db->prepare('INSERT INTO cursors (thread_id, last_post) VALUES (?, ?)
                ON CONFLICT(thread_id) DO UPDATE SET last_post = excluded.last_post');
            $write->execute([$threadId, $detected['lastPost']]);
            $db->prepare('DELETE FROM detected_recruitments WHERE expires_at <= ?')->execute([$now]);
            $remove = $db->prepare('DELETE FROM detected_recruitments WHERE thread_id = ? AND post_number = ?');
            foreach ($detected['closed'] as $number) {
                $remove->execute([$threadId, $number]);
            }
            $shorten = $db->prepare('UPDATE detected_recruitments SET expires_at = ?
                WHERE thread_id = ? AND post_number = ? AND expires_at > ?');
            foreach ($detected['shortened'] as [$number, $expiresAt]) {
                $shorten->execute([$expiresAt, $threadId, $number, $expiresAt]);
            }
            $insert = $db->prepare('INSERT INTO detected_recruitments
                (thread_id, post_number, expires_at, payload_json) VALUES (?, ?, ?, ?)
                ON CONFLICT(thread_id, post_number) DO NOTHING');
            foreach ($detected['recruitments'] as $item) {
                if ($item['expiresAt'] > $now) {
                    $insert->execute([$threadId, $item['number'], $item['expiresAt'], json_encode($item, JSON_THROW_ON_ERROR)]);
                }
            }
            $db->commit();
        } catch (\Throwable $failure) {
            $db->rollBack();
            throw $failure;
        }
        unset($detected['closed'], $detected['shortened']);
        return ['threadId' => $threadId, 'baseline' => $after === null] + $detected;
    }

    private function deliverLocked(PDO $db, string $threadId, int $now, Closure $send): array
    {
        $select = $db->prepare('SELECT post_number, expires_at, payload_json FROM detected_recruitments
            WHERE thread_id = ? AND expires_at > ? ORDER BY post_number LIMIT 1');
        $select->execute([$threadId, $now]);
        $row = $select->fetch(PDO::FETCH_ASSOC);
        $select->closeCursor();
        if ($row === false) {
            return ['status' => 'idle'];
        }
        $payload = json_decode($row['payload_json'], true, 64, JSON_THROW_ON_ERROR);
        // Keep retries within the original notification window, even after an ambiguous FCM response.
        $expiresAt = min((int) $row['expires_at'], (intdiv($now, 1000) + 300) * 1000);
        if ($expiresAt < (int) $row['expires_at']) {
            $db->prepare('UPDATE detected_recruitments SET expires_at = ? WHERE thread_id = ? AND post_number = ?')
                ->execute([$expiresAt, $threadId, $row['post_number']]);
        }
        $receipt = $send($threadId, (int) $row['post_number'], $payload['roomIds'], $expiresAt);
        $db->prepare('DELETE FROM detected_recruitments WHERE thread_id = ? AND post_number = ?')
            ->execute([$threadId, $row['post_number']]);
        return $receipt;
    }

    private static function requirePrivateFileIfPresent(string $path): void
    {
        clearstatcache(true, $path);
        if (is_link($path) || (file_exists($path) && (!is_file($path) || (fileperms($path) & 0777) !== 0600))) {
            throw new SafeFailure('invalid_state_path');
        }
    }

    private static function now(): int
    {
        return (int) floor(microtime(true) * 1000);
    }
}
