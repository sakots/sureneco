<?php

declare(strict_types=1);

namespace Sureneco;

use InvalidArgumentException;
use PDO;
use stdClass;
use Throwable;

const SUBSCRIPTION_MAX_BODY_BYTES = 262144;
const SUBSCRIPTION_MAX_WATCHED = 100;

/** Schema is shared by the API and cron; authentication is deliberately outside this module. */
function initializeSubscriptionSchema(PDO $database): void
{
    $database->exec('PRAGMA foreign_keys = ON');
    $database->exec('PRAGMA busy_timeout = 5000');
    $database->exec('
        CREATE TABLE IF NOT EXISTS subscriptions (
            uid TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            active INTEGER NOT NULL CHECK (active IN (0, 1)),
            settings_json TEXT NOT NULL,
            watched_json TEXT NOT NULL,
            fcm_token TEXT NOT NULL UNIQUE,
            consented_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_fetch_success_at INTEGER,
            error_code TEXT
        );
        CREATE TABLE IF NOT EXISTS subscription_cursors (
            uid TEXT NOT NULL REFERENCES subscriptions(uid) ON DELETE CASCADE,
            board_url TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            last_post INTEGER NOT NULL DEFAULT 0,
            needs_baseline INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (uid, board_url, thread_id)
        );
        CREATE TABLE IF NOT EXISTS notification_events (
            event_id TEXT PRIMARY KEY,
            uid TEXT NOT NULL REFERENCES subscriptions(uid) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS notification_events_owner ON notification_events(uid);
        CREATE INDEX IF NOT EXISTS notification_events_expiry ON notification_events(expires_at);
        CREATE TABLE IF NOT EXISTS notification_outbox (
            event_id TEXT PRIMARY KEY REFERENCES notification_events(event_id) ON DELETE CASCADE,
            uid TEXT NOT NULL REFERENCES subscriptions(uid) ON DELETE CASCADE,
            revision INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS notification_outbox_owner ON notification_outbox(uid);
        CREATE TABLE IF NOT EXISTS subscription_rate_limits (
            scope TEXT NOT NULL,
            identity_hash TEXT NOT NULL,
            window_started_at INTEGER NOT NULL,
            request_count INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (scope, identity_hash)
        );
        CREATE INDEX IF NOT EXISTS subscription_rate_expiry ON subscription_rate_limits(expires_at);
    ');
}

/** Atomic, persistent rolling fixed-window counter. Store hashes, not IPs, UIDs or credentials. */
function rateLimitSubscriptionRequest(PDO $database, string $scope, string $identity, int $limit, int $windowSeconds = 60): bool
{
    if ($limit < 1 || $windowSeconds < 1) {
        throw new InvalidArgumentException('Invalid rate limit.');
    }
    $now = time();
    $database->prepare('DELETE FROM subscription_rate_limits WHERE expires_at <= ?')->execute([$now]);
    $statement = $database->prepare('
        INSERT INTO subscription_rate_limits (scope, identity_hash, window_started_at, request_count, expires_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT (scope, identity_hash) DO UPDATE SET request_count = request_count + 1
        RETURNING request_count
    ');
    $statement->execute([$scope, hash('sha256', $identity), $now, $now + $windowSeconds]);
    $count = (int) $statement->fetchColumn();
    $statement->closeCursor();
    return $count <= $limit;
}

function subscriptionError(int $status, string $code): array
{
    return ['status' => $status, 'body' => ['error' => $code]];
}

/** Length follows JavaScript string.length (UTF-16 code units), without requiring mbstring. */
function subscriptionTextLength(string $text): int
{
    if (preg_match_all('/[\s\S]/u', $text, $characters) === false) {
        throw new InvalidArgumentException('Invalid UTF-8.');
    }
    $length = count($characters[0]);
    foreach ($characters[0] as $character) {
        if (strlen($character) === 4) {
            ++$length;
        }
    }
    return $length;
}

function subscriptionTrim(string $text): string
{
    return preg_replace('/^[\s\x{FEFF}]+|[\s\x{FEFF}]+$/u', '', $text) ?? '';
}

function validateSubscriptionSettings(mixed $input): array
{
    if (!$input instanceof stdClass) {
        throw new InvalidArgumentException('Invalid settings.');
    }
    $value = get_object_vars($input);
    $keys = ['update_sec', 'thread_update_sec', 'elapsed_days', 'emphasis_sec', 'thread_title_regex', 'ng_thread_title_regex', 'yujinsen_regex', 'closed_yujinsen_regex', 'url', 'ng_words', 'ng_ids', 'ng_watchois', 'allowed_watchois'];
    if (array_diff(array_keys($value), $keys) !== []) {
        throw new InvalidArgumentException('Unknown settings.');
    }
    $result = [];
    foreach (['update_sec' => 60, 'thread_update_sec' => 300, 'elapsed_days' => null, 'emphasis_sec' => null] as $key => $default) {
        $number = array_key_exists($key, $value) ? $value[$key] : $default;
        $minimum = in_array($key, ['update_sec', 'thread_update_sec'], true) ? 60 : 1;
        if (!is_int($number) || $number < $minimum || $number > 2147483) {
            throw new InvalidArgumentException('Invalid interval.');
        }
        $result[$key] = $number;
    }
    // Preserve JavaScript patterns verbatim. Syntax/semantic compatibility requires the
    // isolated ECMAScript evaluation work; PCRE compilation is not an equivalent check.
    foreach (['thread_title_regex', 'ng_thread_title_regex', 'yujinsen_regex', 'closed_yujinsen_regex'] as $key) {
        $pattern = $value[$key] ?? null;
        if (!is_string($pattern) || subscriptionTextLength($pattern) > 1000 || ($key !== 'ng_thread_title_regex' && subscriptionTrim($pattern) === '')) {
            throw new InvalidArgumentException('Invalid pattern.');
        }
        $result[$key] = $pattern;
    }
    $url = $value['url'] ?? null;
    if (!is_string($url) || !preg_match('~^https://((?:[a-z0-9-]+\.)*5ch\.(?:io|net))/([a-zA-Z0-9_]+)/?$~iD', $url, $match)) {
        throw new InvalidArgumentException('Invalid board URL.');
    }
    $result['url'] = 'https://' . strtolower($match[1]) . '/' . $match[2] . '/';
    foreach (['ng_words', 'ng_ids', 'ng_watchois', 'allowed_watchois'] as $key) {
        $list = array_key_exists($key, $value) ? $value[$key] : ($key === 'allowed_watchois' ? [] : null);
        if (!is_array($list) || !array_is_list($list) || count($list) > 1000) {
            throw new InvalidArgumentException('Invalid list.');
        }
        $normalized = [];
        foreach ($list as $item) {
            if (!is_string($item) || subscriptionTextLength($item) > 500) {
                throw new InvalidArgumentException('Invalid list item.');
            }
            $item = subscriptionTrim($item);
            if ($item !== '' && !in_array($item, $normalized, true)) {
                $normalized[] = $item;
            }
        }
        $result[$key] = $normalized;
    }
    return $result;
}

function subscriptionResponse(array|false $subscription): array
{
    if ($subscription === false) {
        return ['status' => 200, 'body' => ['subscription' => null]];
    }
    return ['status' => 200, 'body' => ['subscription' => [
        'revision' => (int) $subscription['revision'],
        'active' => (bool) $subscription['active'],
        'settings' => json_decode($subscription['settings_json'], true, 64, JSON_THROW_ON_ERROR),
        'watched' => json_decode($subscription['watched_json'], true, 64, JSON_THROW_ON_ERROR),
        'lastFetchSuccessAt' => $subscription['last_fetch_success_at'] === null ? null : (int) $subscription['last_fetch_success_at'],
        'error' => $subscription['error_code'],
        'monitoringReady' => false,
    ]]];
}

/** The UID MUST come from the verified Firebase ID token, never the request body or FCM. */
function subscriptionRequest(PDO $database, string $verifiedUid, string $method, string $path, mixed $input): array
{
    if ($verifiedUid === '' || subscriptionTextLength($verifiedUid) > 128 || preg_match('/[\x00-\x1f\x7f]/', $verifiedUid)) {
        return subscriptionError(401, 'unauthorized');
    }
    $allowed = match ($path) {
        '/v1/subscription' => ['GET', 'PUT', 'DELETE'],
        '/v1/subscription/stop' => ['POST'],
        default => null,
    };
    if ($allowed === null) {
        return subscriptionError(404, 'not_found');
    }
    if (!in_array($method, $allowed, true)) {
        return subscriptionError(405, 'method_not_allowed');
    }
    if (strlen(json_encode($input, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) > SUBSCRIPTION_MAX_BODY_BYTES) {
        return subscriptionError(413, 'payload_too_large');
    }
    if (!rateLimitSubscriptionRequest($database, 'uid', $verifiedUid, 60) || ($method === 'PUT' && !rateLimitSubscriptionRequest($database, 'registration', $verifiedUid, 10))) {
        return subscriptionError(429, 'rate_limited');
    }
    try {
        if ($method === 'PUT') {
            if (!$input instanceof stdClass || array_diff(array_keys(get_object_vars($input)), ['settings', 'watched', 'fcmToken', 'consent']) !== [] || ($input->consent ?? null) !== true) {
                throw new InvalidArgumentException('Invalid registration.');
            }
            $settings = validateSubscriptionSettings($input->settings ?? null);
            $watched = $input->watched ?? null;
            if (!is_array($watched) || !array_is_list($watched) || count($watched) > SUBSCRIPTION_MAX_WATCHED) {
                throw new InvalidArgumentException('Invalid watched threads.');
            }
            foreach ($watched as $thread) {
                if (!is_string($thread) || !preg_match('/^\d{9,11}$/D', $thread)) {
                    throw new InvalidArgumentException('Invalid thread.');
                }
            }
            $watched = array_values(array_unique($watched));
            sort($watched, SORT_STRING);
            $token = $input->fcmToken ?? null;
            if (!is_string($token) || !preg_match('/^[\x21-\x7e]{1,4096}$/D', $token)) {
                throw new InvalidArgumentException('Invalid token.');
            }
            $settingsJson = json_encode($settings, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            $watchedJson = json_encode($watched, JSON_THROW_ON_ERROR);
        } elseif ($input !== null && (!$input instanceof stdClass || get_object_vars($input) !== [])) {
            throw new InvalidArgumentException('Unexpected body.');
        }
    } catch (InvalidArgumentException) {
        return subscriptionError(400, 'invalid_subscription');
    }

    // Acquire the write lock before reading revision/state, including across PHP processes.
    $database->exec('BEGIN IMMEDIATE');
    try {
        // Event retention follows its original expiry, not API activity or configuration changes.
        $database->prepare('DELETE FROM notification_outbox WHERE expires_at <= ?')->execute([time()]);
        $database->prepare('DELETE FROM notification_events WHERE expires_at <= ?')->execute([time()]);
        $select = $database->prepare('SELECT * FROM subscriptions WHERE uid = ?');
        $select->execute([$verifiedUid]);
        $current = $select->fetch(PDO::FETCH_ASSOC);
        $select->closeCursor();
        if ($method === 'DELETE') {
            $database->prepare('DELETE FROM subscriptions WHERE uid = ?')->execute([$verifiedUid]);
            $current = false;
        } elseif ($method === 'POST') {
            if ($current !== false) {
                $database->prepare('DELETE FROM notification_outbox WHERE uid = ?')->execute([$verifiedUid]);
                if ((bool) $current['active']) {
                    $revision = max((int) floor(microtime(true) * 1000000), (int) $current['revision'] + 1);
                    $database->prepare('UPDATE subscriptions SET active = 0, revision = ?, updated_at = ? WHERE uid = ?')->execute([$revision, time(), $verifiedUid]);
                }
            }
        } elseif ($method === 'PUT') {
            $changed = $current === false || !(bool) $current['active'] || $current['settings_json'] !== $settingsJson || $current['watched_json'] !== $watchedJson || $current['fcm_token'] !== $token;
            if ($changed) {
                $conflict = $database->prepare('SELECT 1 FROM subscriptions WHERE fcm_token = ? AND uid <> ?');
                $conflict->execute([$token, $verifiedUid]);
                $tokenInUse = $conflict->fetchColumn() !== false;
                $conflict->closeCursor();
                if ($tokenInUse) {
                    $database->exec('ROLLBACK');
                    return subscriptionError(409, 'token_in_use');
                }
                $revision = max((int) floor(microtime(true) * 1000000), $current === false ? 1 : (int) $current['revision'] + 1);
                $now = time();
                $database->prepare('
                    INSERT INTO subscriptions (uid, revision, active, settings_json, watched_json, fcm_token, consented_at, created_at, updated_at)
                    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (uid) DO UPDATE SET revision = excluded.revision, active = 1, settings_json = excluded.settings_json,
                        watched_json = excluded.watched_json, fcm_token = excluded.fcm_token, updated_at = excluded.updated_at
                ')->execute([$verifiedUid, $revision, $settingsJson, $watchedJson, $token, $now, $now, $now]);
                $database->prepare('DELETE FROM notification_outbox WHERE uid = ?')->execute([$verifiedUid]);
                if ($current !== false && !(bool) $current['active']) {
                    $database->prepare('UPDATE subscription_cursors SET needs_baseline = 1 WHERE uid = ?')->execute([$verifiedUid]);
                }
            }
        }
        if ($method !== 'GET' && $method !== 'DELETE') {
            $select->execute([$verifiedUid]);
            $current = $select->fetch(PDO::FETCH_ASSOC);
            $select->closeCursor();
        }
        $response = subscriptionResponse($current);
        $database->exec('COMMIT');
        return $response;
    } catch (Throwable $error) {
        $database->exec('ROLLBACK');
        throw $error;
    }
}
