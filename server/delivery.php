<?php

declare(strict_types=1);

namespace Sureneco;

use PDO;
use Throwable;

require_once __DIR__ . '/subscriptions.php';
require_once __DIR__ . '/fcm.php';

const DELIVERY_MAX_ATTEMPTS = 5;

function initializeDeliverySchema(PDO $database): void
{
    initializeSubscriptionSchema($database);
    $database->exec('CREATE TABLE IF NOT EXISTS notification_delivery_state (
        uid TEXT PRIMARY KEY REFERENCES subscriptions(uid) ON DELETE CASCADE,
        last_attempt_at INTEGER NOT NULL,
        last_success_at INTEGER,
        error_code TEXT
    )');
}

function deliveryDelay(int $attempt, int $retryAfter = 0): int
{
    return max(min(900, 60 * (2 ** min(4, max(0, $attempt - 1)))) + random_int(0, 15), $retryAfter);
}

/** Called under the cron lock. HTTP runs outside the write lock so API stop/update remains available. */
function runDeliveryBatch(PDO $database, callable $send, ?int $now = null, int $budgetMs = 15000): array
{
    initializeDeliverySchema($database);
    $now ??= time();
    $started = hrtime(true);
    $deadline = $started + max(0, min(50000, $budgetMs)) * 1000000;
    $clock = static fn (): int => $now + (int) ((hrtime(true) - $started) / 1000000000);
    $statistics = ['sent' => 0, 'retried' => 0, 'discarded' => 0, 'invalidTokens' => 0, 'deferred' => false];
    $database->prepare('DELETE FROM notification_events WHERE expires_at <= ?')->execute([$clock()]);
    $database->prepare('DELETE FROM notification_outbox WHERE expires_at <= ? OR attempts >= ?')->execute([$clock(), DELIVERY_MAX_ATTEMPTS]);
    $select = $database->prepare('SELECT event_id FROM notification_outbox WHERE next_attempt_at <= ? ORDER BY expires_at, next_attempt_at, event_id LIMIT 100');
    $select->execute([$clock()]);
    $ids = $select->fetchAll(PDO::FETCH_COLUMN);
    $select->closeCursor();
    foreach ($ids as $id) {
        $remaining = (int) (($deadline - hrtime(true)) / 1000000);
        if ($remaining < 100) {
            $statistics['deferred'] = true;
            break;
        }
        $at = $clock();
        $database->exec('BEGIN IMMEDIATE');
        try {
            $select = $database->prepare('SELECT o.*, s.active, s.revision AS current_revision, s.fcm_token FROM notification_outbox o JOIN subscriptions s ON s.uid = o.uid WHERE o.event_id = ? AND o.next_attempt_at <= ?');
            $select->execute([$id, $at]);
            $row = $select->fetch();
            $select->closeCursor();
            if ($row === false) {
                $database->exec('COMMIT');
                continue;
            }
            if (!(bool) $row['active'] || (int) $row['revision'] !== (int) $row['current_revision'] || (int) $row['expires_at'] <= $at) {
                $database->prepare('DELETE FROM notification_outbox WHERE event_id = ?')->execute([$id]);
                $database->exec('COMMIT');
                ++$statistics['discarded'];
                continue;
            }
            $attempt = (int) $row['attempts'] + 1;
            $database->prepare('UPDATE notification_outbox SET attempts = ?, next_attempt_at = ? WHERE event_id = ?')->execute([$attempt, $at + deliveryDelay($attempt), $id]);
            $database->prepare('INSERT INTO notification_delivery_state (uid, last_attempt_at) VALUES (?, ?)
                ON CONFLICT (uid) DO UPDATE SET last_attempt_at = excluded.last_attempt_at')->execute([$row['uid'], $at]);
            $database->exec('COMMIT');
        } catch (Throwable $error) {
            $database->exec('ROLLBACK');
            throw $error;
        }
        $failure = null;
        try {
            $payload = json_decode($row['payload_json'], true, 64, JSON_THROW_ON_ERROR);
            if (!is_array($payload) || ($payload['eventId'] ?? null) !== $id || ($payload['revision'] ?? null) !== (int) $row['revision'] || ($payload['expiresAt'] ?? null) !== (int) $row['expires_at']) {
                throw new FcmDeliveryException('invalid_payload', false);
            }
            $remaining = (int) (($deadline - hrtime(true)) / 1000000);
            if ($remaining < 100 || (int) $row['expires_at'] <= $clock()) {
                // No HTTP was started; leave the candidate for the next pass if it is still valid.
                $database->prepare('UPDATE notification_outbox SET attempts = attempts - 1, next_attempt_at = 0 WHERE event_id = ? AND revision = ?')->execute([$id, $row['revision']]);
                $statistics['deferred'] = true;
                break;
            }
            $send($row['fcm_token'], $payload, min(5000, $remaining));
        } catch (FcmDeliveryException $error) {
            $failure = $error;
        } catch (Throwable) {
            $failure = new FcmDeliveryException('delivery_unavailable');
        }
        $at = $clock();
        $database->exec('BEGIN IMMEDIATE');
        try {
            // An in-flight rejection for an old token must not delete a replacement subscription.
            $select = $database->prepare('SELECT 1 FROM subscriptions WHERE uid = ? AND revision = ? AND fcm_token = ? AND active = 1');
            $select->execute([$row['uid'], $row['revision'], $row['fcm_token']]);
            $current = $select->fetchColumn() !== false;
            $select->closeCursor();
            if ($current) {
                if ($failure?->errorCode === 'unregistered') {
                    $database->prepare('DELETE FROM subscriptions WHERE uid = ?')->execute([$row['uid']]);
                    ++$statistics['invalidTokens'];
                } else {
                    $next = $at + deliveryDelay($attempt, $failure?->retryAfter ?? 0);
                    $discard = $failure === null || !$failure->retryable || $attempt >= DELIVERY_MAX_ATTEMPTS || $next >= (int) $row['expires_at'];
                    if ($discard) {
                        $database->prepare('DELETE FROM notification_outbox WHERE event_id = ? AND revision = ?')->execute([$id, $row['revision']]);
                        ++$statistics[$failure === null ? 'sent' : 'discarded'];
                    } else {
                        $database->prepare('UPDATE notification_outbox SET next_attempt_at = ? WHERE event_id = ? AND revision = ?')->execute([$next, $id, $row['revision']]);
                        ++$statistics['retried'];
                    }
                    $database->prepare('UPDATE notification_delivery_state SET error_code = ?, last_success_at = CASE WHEN ? IS NULL THEN ? ELSE last_success_at END WHERE uid = ?')
                        ->execute([$failure?->errorCode, $failure?->errorCode, $at, $row['uid']]);
                }
            }
            $database->exec('COMMIT');
        } catch (Throwable $error) {
            $database->exec('ROLLBACK');
            throw $error;
        }
    }
    return $statistics;
}
