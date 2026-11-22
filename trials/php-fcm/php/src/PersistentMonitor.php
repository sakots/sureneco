<?php

declare(strict_types=1);

namespace Sureneco\FcmTrial;

use Closure;
use PDO;

final class PersistentMonitor
{
    public const MAX_DEVICE_THREADS = 3;
    private const BUDGET_NS = 90_000_000_000;
    private const STALE_MS = 180_000;
    private const MAX_CANDIDATES = 1000;
    private const STATUS_THREADS = 32;
    private const SELECTION_TOKEN = '/secrets/selection-auth.json';
    private const ERRORS = [
        'list_failed', 'thread_failed', 'delivery_failed', 'invalid_candidates', 'budget_exhausted',
        'invalid_resource', 'fetch_failed', 'decoding_failed', 'invalid_request', 'invalid_dat',
        'invalid_subject', 'execution_failed', 'execution_limit', 'dat_regressed', 'monitor_busy',
        'invalid_state_path', 'state_unavailable', 'invalid_config', 'invalid_state_file',
        'input_file_unavailable', 'input_file_not_regular', 'input_file_permissions', 'input_too_large',
        'invalid_input_json', 'invalid_credentials', 'project_mismatch', 'invalid_client_config',
        'trial_client_missing', 'registration_token_required', 'invalid_registration_token',
        'invalid_operation', 'invalid_oauth_endpoint', 'oauth_authentication_failed',
        'invalid_provider_response', 'oauth_network_failed', 'fcm_network_failed',
        'oauth_rejected', 'fcm_rejected', 'provider_response_too_large', 'invalid_recruitment',
    ];

    private readonly string $root;
    private readonly RecruitmentMonitor $monitor;

    public function __construct(
        string $root,
        ?RecruitmentMonitor $monitor = null,
        private readonly ?Closure $send = null,
        private readonly bool $publicDevice = false,
    ) {
        if (!str_starts_with($root, '/') || str_contains($root, "\0") || $root === '/') {
            throw new SafeFailure('invalid_state_path');
        }
        $root = rtrim($root, '/');
        foreach (explode('/', substr($root, 1)) as $part) {
            if ($part === '' || $part === '.' || $part === '..') {
                throw new SafeFailure('invalid_state_path');
            }
        }
        $this->root = $root;
        $this->monitor = $monitor ?? new RecruitmentMonitor();
        $this->checkDirectories();
    }

    public function tick(int|float|null $cycleDeadline = null): array
    {
        $this->checkDirectories();
        $lock = $this->openLock();
        if (!flock($lock, LOCK_EX | LOCK_NB)) {
            fclose($lock);
            return $this->status();
        }
        $mask = umask(0077);
        try {
            $deadline = $cycleDeadline ?? hrtime(true) + self::BUDGET_NS;
            $config = $this->configuration();
            $this->normalizeConfiguration($config);
            $runtime = $this->runtime();
            $status = $this->savedStatus();
            $status['startedAt'] = self::now();
            $status['completedAt'] = null;
            $status['status'] = $config['enabled'] ? 'running' : 'paused';
            $status['counts'] = self::emptyCounts();
            $status['errors'] = [];
            $this->saveStatus($status, $runtime, $config);
            if ($config['enabled']) {
                $this->runTick($runtime, $status, $config, $deadline);
            }
            $status['completedAt'] = self::now();
            $status['status'] = !$config['enabled'] ? 'paused' : ($status['errors'] === [] ? 'idle' : 'degraded');
            if ($status['status'] === 'idle') {
                $status['lastSuccessAt'] = $status['completedAt'];
            }
            $this->saveStatus($status, $runtime, $config);
        } finally {
            umask($mask);
            fclose($lock);
        }
        return $this->status();
    }

    public function status(): array
    {
        $this->checkDirectories();
        $config = $this->configuration();
        $status = $this->savedStatus();
        $status['enabled'] = $config['enabled'];
        $status['filter'] = $config['filter'];
        $status['threadRefreshSec'] = $config['thread_refresh_sec'];
        if (!$config['enabled']) {
            $status['status'] = 'paused';
        } elseif ($this->isRunning()) {
            $status['status'] = $status['startedAt'] !== null && self::now() - $status['startedAt'] <= self::STALE_MS
                ? 'running' : 'stale';
        } elseif ($status['status'] === 'running' || $status['completedAt'] === null
            || self::now() - $status['completedAt'] > self::STALE_MS) {
            $status['status'] = 'stale';
        }
        $status['ok'] = in_array($status['status'], ['idle', 'running', 'paused'], true);
        unset($status['version']);
        return $status;
    }

    public function setEnabled(bool $enabled): array
    {
        $this->checkDirectories();
        $lock = $this->openLock();
        try {
            if (!flock($lock, LOCK_EX)) {
                throw new SafeFailure('state_unavailable');
            }
            $config = $this->configuration();
            $config['enabled'] = $enabled;
            $this->atomicJson($this->root . '/config.json', $config);
            $status = $this->savedStatus();
            $status['status'] = $enabled ? 'stale' : 'paused';
            $this->saveStatus($status, $this->runtime(), $config);
        } finally {
            fclose($lock);
        }
        return $this->status();
    }

    public function provisionSelection(): array
    {
        $lock = $this->openLock();
        try {
            if (!flock($lock, LOCK_EX)) {
                throw new SafeFailure('state_unavailable');
            }
            $this->configuration();
            $runtime = $this->runtime();
            if ($this->selectionToken() === null) {
                $this->atomicJson($this->root . self::SELECTION_TOKEN, ['token' => bin2hex(random_bytes(32))]);
            }
            if (!isset($runtime['selected'])) {
                $runtime['selected'] = array_column($runtime['candidates'], 'id');
                // Snapshot the running set before making a fresh list eligible for polling.
                $runtime['list']['attemptedAt'] = null;
                $this->atomicJson($this->root . '/state/runtime.json', $runtime);
            }
            return ['status' => 'provisioned'];
        } finally {
            fclose($lock);
        }
    }

    public function exchangeSelectionToken(#[\SensitiveParameter] string $registrationProof): string
    {
        $this->checkDirectories();
        $this->privateDirectory($this->root . '/secrets');
        $text = $this->readPrivateText($this->root . '/secrets/registration-token.txt', 8192);
        if ($text === null) {
            throw new SafeFailure('selection_unauthorized');
        }
        $registration = rtrim($text, "\r\n");
        if (preg_match('/\A[a-zA-Z0-9_:\-]+\z/', $registration) !== 1) {
            throw new SafeFailure('invalid_registration_token');
        }
        if (!hash_equals(hash('sha256', 'sureneco-php-selection-v1:' . $registration), $registrationProof)) {
            throw new SafeFailure('selection_unauthorized');
        }

        $this->configuration();
        $runtime = $this->runtime();
        if (!isset($runtime['selected'])) {
            throw new SafeFailure('selection_unavailable');
        }
        return $this->selectionToken() ?? throw new SafeFailure('selection_unavailable');
    }

    public function threadSelection(
        #[\SensitiveParameter] string $token,
        ?string $id = null,
        ?bool $enabled = null,
        ?array $settings = null,
    ): array {
        $expected = $this->selectionToken() ?? throw new SafeFailure('selection_unavailable');
        if (!hash_equals($expected, $token)) {
            throw new SafeFailure('selection_unauthorized');
        }
        return $this->selection($id, $enabled, $settings);
    }

    /** The public service calls this only while holding the authenticated device slot. */
    public function deviceSelection(?string $id = null, ?bool $enabled = null, ?array $settings = null): array
    {
        if (!$this->publicDevice) {
            throw new SafeFailure('selection_unavailable');
        }
        return $this->selection($id, $enabled, $settings);
    }

    private function selection(?string $id, ?bool $enabled, ?array $settings): array
    {
        $lock = $this->openLock();
        try {
            if (!flock($lock, LOCK_EX | LOCK_NB)) {
                throw new SafeFailure('monitor_busy');
            }
            $runtime = $this->runtime();
            if (!isset($runtime['selected'])) {
                throw new SafeFailure('selection_unavailable');
            }
            $config = $this->configuration();
            if ($settings !== null) {
                $refresh = $settings['thread_refresh_sec'] ?? null;
                $filter = $settings['recruitment_filter'] ?? null;
                if (count($settings) !== 2 || !self::validSettings($refresh, $filter)) {
                    throw new SafeFailure('invalid_request');
                }
                $config['thread_refresh_sec'] = $refresh;
                $config['filter'] = $filter;
            }
            $selected = array_fill_keys($runtime['selected'], true);
            if ($id !== null && $enabled !== null) {
                if (!in_array($id, array_column($runtime['candidates'], 'id'), true)) {
                    throw new SafeFailure('unknown_thread');
                }
                if ($enabled !== isset($selected[$id])) {
                    if ($enabled) {
                        if ($this->publicDevice) {
                            if (count($selected) >= self::MAX_DEVICE_THREADS) {
                                throw new SafeFailure('selection_limit');
                            }
                            // The next successful cron scan takes a fresh baseline without doing board IO in the API.
                            $this->pruneDeviceDatabase($runtime['selected']);
                        } else {
                            // Commit the fresh cursor and discard its queue before cron can see the thread enabled.
                            $this->checkDatabaseFiles();
                            $this->monitor->baseline($id, $this->root . '/state/monitor.sqlite', $config['filter']);
                        }
                        $selected[$id] = true;
                    } else {
                        if (!$this->publicDevice) {
                            $db = $this->historyDatabase();
                            $db?->prepare('DELETE FROM recruitment_history WHERE thread_id = ?')->execute([$id]);
                        }
                        unset($selected[$id]);
                    }
                    $runtime['selected'] = array_map(strval(...), array_keys($selected));
                    $this->atomicJson($this->root . '/state/runtime.json', $runtime);
                    if ($this->publicDevice && !$enabled) {
                        $this->pruneDeviceDatabase($runtime['selected']);
                    }
                }
            }
            $threads = [];
            foreach ($runtime['candidates'] as $candidate) {
                $threads[] = ['id' => $candidate['id'], 'title' => $candidate['title'] ?? $candidate['id'],
                    'enabled' => isset($selected[$candidate['id']])];
            }
            $recruitments = $this->recruitmentSnapshot($selected);
            if ($settings !== null) {
                $this->atomicJson($this->root . '/config.json', $config);
            }
            $snapshot = ['threads' => $threads, 'recruitments' => $recruitments,
                'settings' => ['thread_refresh_sec' => $config['thread_refresh_sec'], 'recruitment_filter' => $config['filter']]];
            if ($this->publicDevice) {
                $snapshot['enabled'] = $config['enabled'];
            }
            return $snapshot;
        } finally {
            fclose($lock);
        }
    }

    private function recruitmentSnapshot(array $selected): array
    {
        $db = $selected === [] ? null : $this->historyDatabase();
        if ($db === null) {
            return [];
        }
        $read = $db->prepare('SELECT thread_id, post_number, posted_at, expires_at, payload_json FROM recruitment_history
            WHERE expires_at > ? ORDER BY posted_at DESC, thread_id DESC, post_number DESC');
        $read->execute([self::now()]);
        $recruitments = [];
        while (($row = $read->fetch(PDO::FETCH_ASSOC)) !== false) {
            if (isset($selected[$row['thread_id']])) {
                $item = json_decode($row['payload_json'], true, 64, JSON_THROW_ON_ERROR);
                $recruitments[] = ['threadId' => $row['thread_id'], 'number' => (int) $row['post_number'],
                    'body' => $item['body'], 'roomIds' => $item['roomIds'],
                    'postedAt' => (int) $row['posted_at'], 'expiresAt' => (int) $row['expires_at']];
            }
        }
        return $recruitments;
    }

    private function pruneRecruitmentHistory(array $active): void
    {
        $db = $this->historyDatabase();
        if ($db === null) {
            return;
        }
        $now = self::now();
        $read = $db->query('SELECT DISTINCT thread_id FROM recruitment_history');
        $removed = array_values(array_diff($read->fetchAll(PDO::FETCH_COLUMN), $active));
        $inactive = $removed === [] ? '' : ' OR thread_id IN (' . implode(', ', array_fill(0, count($removed), '?')) . ')';
        $db->prepare('DELETE FROM recruitment_history WHERE expires_at <= ?' . $inactive)->execute([$now, ...$removed]);
    }

    private function pruneDeviceDatabase(array $active): void
    {
        // All three tables are initialized together before a public device can have persisted scan rows.
        $db = $this->historyDatabase();
        if ($db === null) {
            return;
        }
        $where = $active === [] ? '' : ' WHERE thread_id NOT IN (' . implode(', ', array_fill(0, count($active), '?')) . ')';
        $db->beginTransaction();
        try {
            foreach (['cursors', 'detected_recruitments', 'recruitment_history'] as $table) {
                $db->prepare("DELETE FROM $table$where")->execute($active);
            }
            $db->commit();
        } catch (\Throwable $error) {
            $db->rollBack();
            throw $error;
        }
    }

    private function selectionToken(): ?string
    {
        $this->privateDirectory($this->root . '/secrets');
        $auth = $this->readJson($this->root . self::SELECTION_TOKEN, 256);
        if ($auth === null) {
            return null;
        }
        if (!is_string($auth['token'] ?? null) || preg_match('/\A[a-f0-9]{64}\z/', $auth['token']) !== 1) {
            throw new SafeFailure('invalid_state_file');
        }
        return $auth['token'];
    }

    private function runTick(array &$runtime, array &$status, array $config, int|float $deadline): void
    {
        $now = self::now();
        if ($runtime['list']['attemptedAt'] === null
            || $now - $runtime['list']['attemptedAt'] >= $config['thread_refresh_sec'] * 1000) {
            $runtime['list']['attemptedAt'] = $now;
            // Checkpoint the attempt before external IO, including a hung or killed request.
            $this->atomicJson($this->root . '/state/runtime.json', $runtime);
            try {
                $threads = $this->monitor->listThreads()['threads'] ?? null;
                if (!is_array($threads) || !array_is_list($threads) || count($threads) > self::MAX_CANDIDATES) {
                    throw new SafeFailure('invalid_candidates');
                }
                $previous = array_column($runtime['candidates'], null, 'id');
                $candidates = [];
                foreach ($threads as $thread) {
                    if (!is_array($thread) || !self::validId($thread['id'] ?? null)
                        || !is_int($thread['count'] ?? null) || $thread['count'] < 0) {
                        throw new SafeFailure('invalid_candidates');
                    }
                    if ($thread['count'] < 1000) {
                        $candidate = $previous[$thread['id']] ?? self::candidate($thread['id'], $thread['count']);
                        $candidate['count'] = $thread['count'];
                        $candidate['title'] = self::candidateTitle($thread['title'] ?? null);
                        $candidates[$thread['id']] = $candidate;
                    }
                }
                $candidateIds = array_column($candidates, 'id');
                $active = isset($runtime['selected']) ? array_values(array_intersect($runtime['selected'], $candidateIds)) : $candidateIds;
                $this->pruneRecruitmentHistory($active);
                if ($this->publicDevice) {
                    $this->pruneDeviceDatabase($active);
                }
                $runtime['candidates'] = array_values($candidates);
                if (isset($runtime['selected'])) {
                    $runtime['selected'] = $active;
                }
                $runtime['list']['succeededAt'] = self::now();
                $runtime['list']['error'] = null;
            } catch (\Throwable $error) {
                $runtime['list']['error'] = self::safeError($error, 'list_failed');
            }
            $this->atomicJson($this->root . '/state/runtime.json', $runtime);
        }
        $selected = isset($runtime['selected']) ? array_fill_keys($runtime['selected'], true) : null;
        $ids = $indexes = [];
        foreach ($runtime['candidates'] as $index => $candidate) {
            if ($selected === null || isset($selected[$candidate['id']])) {
                $indexes[] = $index;
                $ids[] = $candidate['id'];
            }
        }
        $count = count($indexes);
        $status['counts']['remaining'] = $count;
        $start = array_search($runtime['nextThreadId'], $ids, true);
        $start = $start === false ? 0 : $start;
        $configuration = null;
        $sender = null;
        $send = $this->send ?? function (string $id, int $number, array $rooms, int $expiry) use (&$configuration, &$sender): array {
            if ($configuration === null) {
                $this->privateDirectory($this->root . '/secrets');
                foreach (['service-account.json', 'google-services.json', 'registration-token.txt'] as $name) {
                    $this->privateFile($this->root . '/secrets/' . $name, false);
                }
                $configuration = Configuration::load('send', $this->root . '/secrets/service-account.json',
                    $this->root . '/secrets/google-services.json', $this->root . '/secrets/registration-token.txt');
                $sender = new Sender();
            }
            return $sender->sendRecruitment($configuration, $id, $number, $rooms, $expiry);
        };
        for ($offset = 0; $offset < $count; ++$offset) {
            if (hrtime(true) >= $deadline) {
                $status['errors'][] = 'budget_exhausted';
                break;
            }
            $position = ($start + $offset) % $count;
            $candidate = &$runtime['candidates'][$indexes[$position]];
            $candidate['fetch'] = 'running';
            $candidate['delivery'] = 'not_attempted';
            $candidate['error'] = null;
            $candidate['updatedAt'] = self::now();
            // Advance before IO: a hard timeout must not repeatedly starve the tail.
            $runtime['nextThreadId'] = $ids[($position + 1) % $count];
            $this->atomicJson($this->root . '/state/runtime.json', $runtime);
            $this->saveStatus($status, $runtime, $config);
            ++$status['counts']['attempted'];
            --$status['counts']['remaining'];
            $sending = false;
            $accepted = false;
            try {
                $this->checkDatabaseFiles();
                $result = $this->monitor->deliver($candidate['id'], $this->root . '/state/monitor.sqlite', $config['filter'],
                    static function (string $id, int $number, array $rooms, int $expiry) use ($send, &$sending, &$accepted): array {
                        $sending = true;
                        $receipt = $send($id, $number, $rooms, $expiry);
                        $accepted = true;
                        return $receipt;
                    });
                $candidate['lastPost'] = $result['lastPost'];
                $candidate['baseline'] = $result['baseline'];
                $candidate['fetch'] = 'ok';
                $candidate['delivery'] = $accepted ? 'accepted' : 'idle';
                ++$status['counts']['succeeded'];
            } catch (\Throwable $error) {
                $candidate['fetch'] = $sending ? 'ok' : 'error';
                $candidate['delivery'] = $sending ? 'error' : 'not_attempted';
                $candidate['error'] = self::safeError($error, $sending ? 'delivery_failed' : 'thread_failed');
                ++$status['counts']['failed'];
                // Delivery can fail after the existing monitor has durably advanced its cursor.
                if ($sending) {
                    try {
                        $db = $this->database();
                        if ($db !== null) {
                            $read = $db->prepare('SELECT last_post FROM cursors WHERE thread_id = ?');
                            $read->execute([$candidate['id']]);
                            $cursor = $read->fetchColumn();
                            $read->closeCursor();
                            $candidate['lastPost'] = $cursor === false ? null : (int) $cursor;
                            $candidate['baseline'] = false;
                        }
                    } catch (\Throwable) {
                        $candidate['error'] = 'state_unavailable';
                    }
                }
            }
            if ($accepted) {
                ++$status['counts']['sent'];
            }
            $candidate['updatedAt'] = self::now();
            unset($candidate);
            $this->atomicJson($this->root . '/state/runtime.json', $runtime);
            $this->saveStatus($status, $runtime, $config);
        }
        if ($count === 0) {
            $runtime['nextThreadId'] = null;
        }
        try {
            $db = $this->database();
            if ($db !== null) {
                $read = $db->prepare('SELECT COUNT(*) FROM detected_recruitments WHERE expires_at > ?');
                $read->execute([self::now()]);
                $status['counts']['pending'] = (int) $read->fetchColumn();
                $read->closeCursor();
            }
        } catch (\Throwable $error) {
            $status['errors'][] = self::safeError($error, 'state_unavailable');
        }
        if ($runtime['list']['error'] !== null) {
            $status['errors'][] = $runtime['list']['error'];
        }
        foreach ($indexes as $index) {
            $error = $runtime['candidates'][$index]['error'];
            if ($error !== null) {
                $status['errors'][] = $error;
            }
        }
        $status['errors'] = array_values(array_unique($status['errors']));
        $this->atomicJson($this->root . '/state/runtime.json', $runtime);
    }

    private function configuration(): array
    {
        $raw = $this->readJson($this->root . '/config.json', 8192, false);
        $filter = $raw['filter'] ?? 'loose';
        $filter = is_string($filter) ? strtolower(trim($filter)) : null;
        $refresh = $raw['thread_refresh_sec'] ?? 300;
        if (!is_bool($raw['enabled'] ?? null) || !self::validSettings($refresh, $filter)) {
            throw new SafeFailure('invalid_config');
        }
        return ['enabled' => $raw['enabled'], 'filter' => $filter, 'thread_refresh_sec' => $refresh];
    }

    private static function validSettings(mixed $refresh, mixed $filter): bool
    {
        return is_int($refresh) && $refresh >= 60 && $refresh <= 86400 && in_array($filter, ['regex', 'loose'], true);
    }

    private function normalizeConfiguration(array $config): void
    {
        if ($this->readJson($this->root . '/config.json', 8192, false) !== $config) {
            $this->atomicJson($this->root . '/config.json', $config);
        }
    }

    private function runtime(): array
    {
        $runtime = $this->readJson($this->root . '/state/runtime.json', 1024 * 1024);
        if ($runtime === null) {
            $default = ['version' => 1, 'candidates' => [], 'nextThreadId' => null,
                'list' => ['attemptedAt' => null, 'succeededAt' => null, 'error' => null]];
            return $this->publicDevice ? $default + ['selected' => []] : $default;
        }
        if (($runtime['version'] ?? null) !== 1 || !is_array($runtime['candidates'] ?? null)
            || !array_is_list($runtime['candidates']) || count($runtime['candidates']) > self::MAX_CANDIDATES
            || !array_key_exists('nextThreadId', $runtime)
            || ($runtime['nextThreadId'] !== null && !self::validId($runtime['nextThreadId']))) {
            throw new SafeFailure('invalid_state_file');
        }
        self::validateList($runtime['list'] ?? null);
        $seen = [];
        foreach ($runtime['candidates'] as $candidate) {
            self::validateCandidate($candidate);
            if (isset($seen[$candidate['id']])) {
                throw new SafeFailure('invalid_state_file');
            }
            $seen[$candidate['id']] = true;
        }
        if (array_key_exists('selected', $runtime)) {
            $selected = $runtime['selected'];
            if (!is_array($selected) || !array_is_list($selected) || count($selected) > count($seen)
                || ($this->publicDevice && count($selected) > self::MAX_DEVICE_THREADS)) {
                throw new SafeFailure('invalid_state_file');
            }
            foreach ($selected as $id) {
                if (!self::validId($id) || !isset($seen[$id])) {
                    throw new SafeFailure('invalid_state_file');
                }
                unset($seen[$id]);
            }
        }
        if ($this->publicDevice && !isset($runtime['selected'])) {
            throw new SafeFailure('invalid_state_file');
        }
        return $runtime;
    }

    private function savedStatus(): array
    {
        $status = $this->readJson($this->root . '/state/status.json', 65536);
        if ($status === null) {
            return ['version' => 1, 'status' => 'stale', 'startedAt' => null, 'completedAt' => null, 'lastSuccessAt' => null,
                'list' => ['attemptedAt' => null, 'succeededAt' => null, 'error' => null],
                'counts' => self::emptyCounts(), 'threads' => [], 'errors' => [], 'nextThreadId' => null];
        }
        if (($status['version'] ?? null) !== 1 || !in_array($status['status'] ?? null, ['paused', 'running', 'idle', 'degraded', 'stale'], true)) {
            throw new SafeFailure('invalid_state_file');
        }
        foreach (['startedAt', 'completedAt', 'lastSuccessAt'] as $key) {
            if (!array_key_exists($key, $status) || !self::timestamp($status[$key])) {
                throw new SafeFailure('invalid_state_file');
            }
        }
        self::validateList($status['list'] ?? null);
        foreach (self::emptyCounts() as $key => $_) {
            if (!is_int($status['counts'][$key] ?? null) || $status['counts'][$key] < 0) {
                throw new SafeFailure('invalid_state_file');
            }
        }
        if (!is_array($status['threads'] ?? null) || !array_is_list($status['threads']) || count($status['threads']) > self::STATUS_THREADS
            || !is_array($status['errors'] ?? null) || !array_is_list($status['errors']) || count($status['errors']) > count(self::ERRORS)
            || !array_key_exists('nextThreadId', $status)
            || ($status['nextThreadId'] !== null && !self::validId($status['nextThreadId']))) {
            throw new SafeFailure('invalid_state_file');
        }
        foreach ($status['threads'] as $candidate) {
            self::validateCandidate($candidate);
        }
        foreach ($status['errors'] as $error) {
            if (!in_array($error, self::ERRORS, true)) {
                throw new SafeFailure('invalid_state_file');
            }
        }
        // Only the documented projection can leave this class, never arbitrary saved fields.
        $status['counts'] = array_intersect_key($status['counts'], self::emptyCounts());
        return array_intersect_key($status, array_flip(['version', 'status', 'startedAt', 'completedAt', 'lastSuccessAt',
            'list', 'counts', 'threads', 'errors', 'nextThreadId']));
    }

    private function saveStatus(array $status, array $runtime, array $config): void
    {
        $status['enabled'] = $config['enabled'];
        $status['filter'] = $config['filter'];
        $status['threadRefreshSec'] = $config['thread_refresh_sec'];
        $status['list'] = $runtime['list'];
        $status['counts']['candidates'] = count($runtime['candidates']);
        $status['threads'] = [];
        foreach (array_slice($runtime['candidates'], 0, self::STATUS_THREADS) as $candidate) {
            unset($candidate['title']);
            $status['threads'][] = $candidate;
        }
        $status['nextThreadId'] = $runtime['nextThreadId'];
        $this->atomicJson($this->root . '/state/status.json', $status);
    }

    private static function candidate(string $id, int $count): array
    {
        return ['id' => $id, 'count' => $count, 'lastPost' => null, 'baseline' => null,
            'fetch' => 'pending', 'delivery' => 'not_attempted', 'error' => null, 'updatedAt' => null];
    }

    private static function candidateTitle(mixed $title): string
    {
        if (!is_string($title) || preg_match('/\A.{1,160}/us', $title, $match) !== 1) {
            throw new SafeFailure('invalid_candidates');
        }
        return preg_replace('/[\x00-\x1f\x7f\x{2028}\x{2029}]/u', ' ', $match[0]);
    }

    private static function validateCandidate(mixed $candidate): void
    {
        $keys = array_keys(self::candidate('', 0));
        if (!is_array($candidate)
            || (array_keys($candidate) !== $keys && array_keys($candidate) !== [...$keys, 'title'])
            || (array_key_exists('title', $candidate) && (!is_string($candidate['title'])
                || preg_match('/\A[^\x00-\x1f\x7f\x{2028}\x{2029}]{1,160}\z/u', $candidate['title']) !== 1))
            || !self::validId($candidate['id']) || !is_int($candidate['count']) || $candidate['count'] < 0 || $candidate['count'] >= 1000
            || ($candidate['lastPost'] !== null && (!is_int($candidate['lastPost']) || $candidate['lastPost'] < 0))
            || ($candidate['baseline'] !== null && !is_bool($candidate['baseline']))
            || !in_array($candidate['fetch'], ['pending', 'running', 'ok', 'error'], true)
            || !in_array($candidate['delivery'], ['not_attempted', 'idle', 'accepted', 'error'], true)
            || ($candidate['error'] !== null && !in_array($candidate['error'], self::ERRORS, true))
            || !self::timestamp($candidate['updatedAt'])) {
            throw new SafeFailure('invalid_state_file');
        }
    }

    private static function validateList(mixed $list): void
    {
        if (!is_array($list) || array_keys($list) !== ['attemptedAt', 'succeededAt', 'error']
            || !self::timestamp($list['attemptedAt']) || !self::timestamp($list['succeededAt'])
            || ($list['error'] !== null && !in_array($list['error'], self::ERRORS, true))) {
            throw new SafeFailure('invalid_state_file');
        }
    }

    private static function emptyCounts(): array
    {
        return ['candidates' => 0, 'attempted' => 0, 'succeeded' => 0, 'failed' => 0, 'sent' => 0, 'pending' => 0, 'remaining' => 0];
    }

    private static function validId(mixed $id): bool
    {
        return is_string($id) && preg_match('/\A[0-9]{9,11}\z/', $id) === 1;
    }

    private static function timestamp(mixed $value): bool
    {
        return $value === null || (is_int($value) && $value >= 0);
    }

    private static function safeError(\Throwable $error, string $fallback): string
    {
        return $error instanceof SafeFailure && in_array($error->reason, self::ERRORS, true) ? $error->reason : $fallback;
    }

    private function checkDirectories(): void
    {
        $path = '';
        foreach (explode('/', substr($this->root, 1)) as $part) {
            $path .= '/' . $part;
            clearstatcache(true, $path);
            $stat = @lstat($path);
            if ($stat === false || ($stat['mode'] & 0170000) !== 0040000) {
                throw new SafeFailure('invalid_state_path');
            }
        }
        $this->privateDirectory($this->root);
        $this->privateDirectory($this->root . '/state');
    }

    private function privateDirectory(string $path): void
    {
        clearstatcache(true, $path);
        $stat = @lstat($path);
        if ($stat === false || ($stat['mode'] & 0170000) !== 0040000 || ($stat['mode'] & 07777) !== 0700 || !self::owned($stat)) {
            throw new SafeFailure('invalid_state_path');
        }
    }

    private function privateFile(string $path, bool $optional = true): ?array
    {
        clearstatcache(true, $path);
        $stat = @lstat($path);
        if ($stat === false && $optional) {
            return null;
        }
        if ($stat === false || ($stat['mode'] & 0170000) !== 0100000 || ($stat['mode'] & 07777) !== 0600
            || $stat['nlink'] !== 1 || !self::owned($stat)) {
            throw new SafeFailure('invalid_state_path');
        }
        return $stat;
    }

    private static function owned(array $stat): bool
    {
        return !function_exists('posix_geteuid') || $stat['uid'] === posix_geteuid();
    }

    private function openLock()
    {
        $path = $this->root . '/state/run.lock';
        $this->privateFile($path);
        $mask = umask(0077);
        try {
            $lock = @fopen($path, 'c+b');
        } finally {
            umask($mask);
        }
        if ($lock === false) {
            throw new SafeFailure('state_unavailable');
        }
        try {
            $this->checkOpened($lock, $this->privateFile($path, false));
        } catch (\Throwable $error) {
            fclose($lock);
            throw $error;
        }
        return $lock;
    }

    private function isRunning(): bool
    {
        $path = $this->root . '/state/run.lock';
        $stat = $this->privateFile($path);
        if ($stat === null) {
            return false;
        }
        $lock = @fopen($path, 'r+b');
        if ($lock === false) {
            throw new SafeFailure('state_unavailable');
        }
        try {
            $this->checkOpened($lock, $stat);
            return !flock($lock, LOCK_EX | LOCK_NB);
        } finally {
            fclose($lock);
        }
    }

    private function checkOpened($stream, array $stat): void
    {
        $opened = fstat($stream);
        if ($opened === false || $opened['dev'] !== $stat['dev'] || $opened['ino'] !== $stat['ino']
            || ($opened['mode'] & 0177777) !== 0100600 || $opened['nlink'] !== 1 || !self::owned($opened)) {
            throw new SafeFailure('invalid_state_path');
        }
    }

    private function checkDatabaseFiles(): void
    {
        foreach (['', '.lock', '-journal', '-wal', '-shm'] as $suffix) {
            $this->privateFile($this->root . '/state/monitor.sqlite' . $suffix);
        }
    }

    private function database(): ?PDO
    {
        $this->checkDatabaseFiles();
        if ($this->privateFile($this->root . '/state/monitor.sqlite') === null) {
            return null;
        }
        return new PDO('sqlite:' . $this->root . '/state/monitor.sqlite', null, null, [PDO::ATTR_TIMEOUT => 1]);
    }

    private function historyDatabase(): ?PDO
    {
        $db = $this->database();
        return $db !== null && $db->query("SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'recruitment_history'")->fetchColumn() !== false ? $db : null;
    }

    private function readPrivateText(string $path, int $limit, bool $optional = true): ?string
    {
        $stat = $this->privateFile($path, $optional);
        if ($stat === null) {
            return null;
        }
        if ($stat['size'] > $limit) {
            throw new SafeFailure('invalid_state_file');
        }
        $stream = @fopen($path, 'rb');
        if ($stream === false) {
            throw new SafeFailure('state_unavailable');
        }
        try {
            $this->checkOpened($stream, $stat);
            $text = stream_get_contents($stream, $limit + 1);
            if ($text === false || strlen($text) > $limit) {
                throw new SafeFailure('invalid_state_file');
            }
            return $text;
        } finally {
            fclose($stream);
        }
    }

    private function readJson(string $path, int $limit, bool $optional = true): ?array
    {
        $text = $this->readPrivateText($path, $limit, $optional);
        if ($text === null) {
            return null;
        }
        try {
            $value = json_decode($text, true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new SafeFailure('invalid_state_file');
        }
        if (!is_array($value) || array_is_list($value)) {
            throw new SafeFailure('invalid_state_file');
        }
        return $value;
    }

    private function atomicJson(string $path, array $value): void
    {
        $this->privateFile($path);
        // A fixed, private temporary file bounds leftovers after a hard process stop.
        $temporary = $path . '.tmp';
        $mask = umask(0077);
        $stream = null;
        $created = false;
        try {
            if ($this->privateFile($temporary) !== null && !@unlink($temporary)) {
                throw new SafeFailure('state_unavailable');
            }
            $stream = @fopen($temporary, 'x+b');
            if ($stream === false) {
                throw new SafeFailure('state_unavailable');
            }
            $created = true;
            $json = json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
            for ($offset = 0, $length = strlen($json); $offset < $length; $offset += $written) {
                $written = fwrite($stream, substr($json, $offset));
                if ($written === false || $written === 0) {
                    throw new SafeFailure('state_unavailable');
                }
            }
            if (!fflush($stream) || (function_exists('fsync') && !fsync($stream))) {
                throw new SafeFailure('state_unavailable');
            }
            fclose($stream);
            $stream = null;
            $this->privateFile($path);
            if (!@rename($temporary, $path)) {
                throw new SafeFailure('state_unavailable');
            }
        } finally {
            if (is_resource($stream)) {
                fclose($stream);
            }
            if ($created && file_exists($temporary)) {
                @unlink($temporary);
            }
            umask($mask);
        }
    }

    private static function now(): int
    {
        return (int) floor(microtime(true) * 1000);
    }
}
