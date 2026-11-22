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
                return $this->scanLocked($threadId, $path, $filter, $now);
            } finally {
                fclose($lock);
            }
        } finally {
            umask($mask);
        }
    }

    private function scanLocked(string $threadId, string $path, string $filter, ?int $now): array
    {
        $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_TIMEOUT => 1]);
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
        $detected = MonitorIo::detect([
            'operation' => 'scan', 'text' => $text, 'threadId' => $threadId,
            'after' => $after, 'filter' => $filter, 'now' => $now,
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
        return ['threadId' => $threadId, 'baseline' => $after === null] + $detected;
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
