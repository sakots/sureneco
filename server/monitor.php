<?php

declare(strict_types=1);

namespace Sureneco;

use PDO;
use RuntimeException;
use Throwable;

require_once __DIR__ . '/subscriptions.php';
require_once __DIR__ . '/http.php';

/** A batch may defer work, but must not consume its cursor or polling deadline. */
final class MonitoringBudgetException extends RuntimeException
{
}

function notificationEventId(string $uid, string $board, string $thread, int $number): string
{
    return hash('sha256', json_encode([$uid, $board, $thread, $number], JSON_THROW_ON_ERROR));
}

/** Commit only while the subscription still has the revision that was fetched. */
function commitMonitoringResource(PDO $database, array $subscription, string $board, string $resource, int $now, ?string $error, ?array $threads, ?array $cursor, ?array $detected): bool
{
    $uid = $subscription['uid'];
    $database->exec('BEGIN IMMEDIATE');
    try {
        $select = $database->prepare('SELECT revision, active FROM subscriptions WHERE uid = ?');
        $select->execute([$uid]);
        $current = $select->fetch();
        $select->closeCursor();
        if ($current === false || !(bool) $current['active'] || (int) $current['revision'] !== (int) $subscription['revision']) {
            $database->exec('ROLLBACK');
            return false;
        }
        $database->prepare('
            INSERT INTO subscription_fetch_state (uid, board_url, resource, last_attempt_at, last_success_at, threads_json, error_code)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (uid, board_url, resource) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
                last_success_at = COALESCE(excluded.last_success_at, last_success_at),
                threads_json = COALESCE(excluded.threads_json, threads_json), error_code = excluded.error_code
        ')->execute([$uid, $board, $resource, $now, $error === null ? $now : null,
            $threads === null ? null : json_encode($threads, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), $error]);
        if ($cursor !== null) {
            $database->prepare('
                INSERT INTO subscription_cursors (uid, board_url, thread_id, last_post, needs_baseline) VALUES (?, ?, ?, ?, 0)
                ON CONFLICT (uid, board_url, thread_id) DO UPDATE SET last_post = MAX(last_post, excluded.last_post), needs_baseline = 0
            ')->execute([$uid, $board, $cursor['thread'], $cursor['lastPost']]);
        }
        if ($detected !== null && $cursor !== null) {
            // Closing a known pending recruitment cancels delivery, not its deduplication record.
            foreach ($detected['closedPrevious'] as $number) {
                $database->prepare('DELETE FROM notification_outbox WHERE event_id = ? AND uid = ?')
                    ->execute([notificationEventId($uid, $board, $cursor['thread'], $number), $uid]);
            }
            foreach ($detected['notifications'] as $item) {
                $expiresAt = (int) floor($item['postedAt'] / 1000) + $cursor['emphasisSec'];
                if ($expiresAt <= $now) {
                    continue;
                }
                $eventId = notificationEventId($uid, $board, $cursor['thread'], $item['number']);
                $event = $database->prepare('INSERT OR IGNORE INTO notification_events (event_id, uid, expires_at) VALUES (?, ?, ?)');
                $event->execute([$eventId, $uid, $expiresAt]);
                if ($event->rowCount() !== 1) {
                    continue;
                }
                $payload = [
                    'eventId' => $eventId,
                    'revision' => (int) $subscription['revision'],
                    'boardUrl' => $board,
                    'threadId' => $cursor['thread'],
                    'threadTitle' => $cursor['title'],
                    'recruitment' => $item,
                    'expiresAt' => $expiresAt,
                ];
                $database->prepare('INSERT INTO notification_outbox (event_id, uid, revision, expires_at, payload_json) VALUES (?, ?, ?, ?, ?)')
                    ->execute([$eventId, $uid, $subscription['revision'], $expiresAt, json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)]);
            }
        }
        $database->prepare('UPDATE subscriptions SET
            last_fetch_success_at = CASE WHEN ? IS NULL THEN ? ELSE last_fetch_success_at END,
            error_code = (SELECT error_code FROM subscription_fetch_state WHERE uid = ? AND error_code IS NOT NULL ORDER BY resource LIMIT 1)
            WHERE uid = ?')->execute([$error, $now, $uid, $uid]);
        $database->exec('COMMIT');
        return true;
    } catch (Throwable $failure) {
        $database->exec('ROLLBACK');
        throw $failure;
    }
}

/** One pass only. The optional transport is an in-process dependency, never API/user configuration. */
function runMonitoringBatch(PDO $database, ?int $now = null, ?callable $fetch = null, int $budgetMs = 50000): array
{
    initializeSubscriptionSchema($database);
    $now ??= time();
    $fetch ??= fetchBoardData(...);
    $deadline = hrtime(true) + max(0, min(50000, $budgetMs)) * 1000000;
    $statistics = ['fetched' => 0, 'processed' => 0, 'errors' => 0, 'deferred' => false];
    $database->prepare('DELETE FROM notification_outbox WHERE expires_at <= ?')->execute([$now]);
    $database->prepare('DELETE FROM notification_events WHERE expires_at <= ?')->execute([$now]);
    // Oldest work goes first after a budget-limited pass, rather than always starting with one UID.
    $subscriptions = $database->query('SELECT s.* FROM subscriptions s WHERE active = 1 ORDER BY
        COALESCE((SELECT MAX(last_attempt_at) FROM subscription_fetch_state f WHERE f.uid = s.uid), 0), s.uid')->fetchAll();
    $cache = [];
    foreach ($subscriptions as $subscription) {
        $settings = json_decode($subscription['settings_json'], true, 64, JSON_THROW_ON_ERROR);
        $watched = json_decode($subscription['watched_json'], true, 64, JSON_THROW_ON_ERROR);
        $board = $settings['url'];
        $select = $database->prepare('SELECT * FROM subscription_fetch_state WHERE uid = ? AND board_url = ?');
        $select->execute([$subscription['uid'], $board]);
        $states = [];
        foreach ($select->fetchAll() as $state) {
            $states[$state['resource']] = $state;
        }
        $select->closeCursor();
        $threads = isset($states['subject.txt']['threads_json'])
            ? json_decode($states['subject.txt']['threads_json'], true, 64, JSON_THROW_ON_ERROR) : [];
        $resources = ['subject.txt' => null];
        foreach ($watched as $thread) {
            $resources['dat/' . $thread . '.dat'] = $thread;
        }
        // Avoid starving the tail of a subscription with many watched threads.
        uksort($resources, static function (string $a, string $b) use ($states): int {
            return (($states[$a]['last_attempt_at'] ?? 0) <=> ($states[$b]['last_attempt_at'] ?? 0))
                ?: (($a === 'subject.txt' ? 0 : 1) <=> ($b === 'subject.txt' ? 0 : 1));
        });
        foreach ($resources as $resource => $thread) {
            $interval = $thread === null ? $settings['thread_update_sec'] : $settings['update_sec'];
            if (isset($states[$resource]) && $now - (int) $states[$resource]['last_attempt_at'] < $interval) {
                continue;
            }
            // Leave room for dat parsing and isolated regex execution after HTTP completes.
            $remainingMs = (int) (($deadline - hrtime(true)) / 1000000) - 2200;
            if ($remainingMs <= 0) {
                $statistics['deferred'] = true;
                return $statistics;
            }
            $url = $board . $resource;
            $nextThreads = null;
            $nextCursor = null;
            $detected = null;
            $errorCode = null;
            try {
                if (!array_key_exists($url, $cache)) {
                    ++$statistics['fetched'];
                    try {
                        $cache[$url] = ['text' => $fetch($url, min(15000, $remainingMs))];
                    } catch (BoardFetchException $error) {
                        $cache[$url] = ['error' => $error];
                    }
                }
                if (isset($cache[$url]['error'])) {
                    throw $cache[$url]['error'];
                }
                if ($thread === null) {
                    $nextThreads = runDetectionWorker([
                        'operation' => 'subject', 'subject' => $cache[$url]['text'],
                        'settings' => $settings, 'watched' => $watched, 'now' => $now * 1000,
                    ]);
                } else {
                    if (!isset($cache[$url]['posts'])) {
                        try {
                            $cache[$url]['posts'] = runDetectionWorker(['operation' => 'dat', 'dat' => $cache[$url]['text']]);
                            unset($cache[$url]['text']);
                        } catch (DetectionWorkerException $error) {
                            $cache[$url] = ['error' => $error];
                            throw $error;
                        }
                    }
                    $posts = $cache[$url]['posts'];
                    $select = $database->prepare('SELECT last_post, needs_baseline FROM subscription_cursors WHERE uid = ? AND board_url = ? AND thread_id = ?');
                    $select->execute([$subscription['uid'], $board, $thread]);
                    $cursor = $select->fetch();
                    $select->closeCursor();
                    $title = $thread;
                    foreach ($threads as $candidate) {
                        if ($candidate['id'] === $thread) {
                            $title = $candidate['title'];
                            break;
                        }
                    }
                    $nextCursor = ['thread' => $thread, 'lastPost' => count($posts), 'title' => $title, 'emphasisSec' => $settings['emphasis_sec']];
                    if ($cursor !== false && !(bool) $cursor['needs_baseline']) {
                        $select = $database->prepare('SELECT payload_json FROM notification_outbox WHERE uid = ? AND revision = ?');
                        $select->execute([$subscription['uid'], $subscription['revision']]);
                        $previous = [];
                        foreach ($select->fetchAll() as $queued) {
                            $payload = json_decode($queued['payload_json'], true, 64, JSON_THROW_ON_ERROR);
                            if ($payload['boardUrl'] === $board && $payload['threadId'] === $thread) {
                                $previous[] = $payload['recruitment'];
                            }
                        }
                        $select->closeCursor();
                        if (hrtime(true) >= $deadline - 1100000000) {
                            throw new MonitoringBudgetException();
                        }
                        $detected = runDetectionWorker([
                            'operation' => 'scan', 'threadId' => $thread,
                            'posts' => array_values(array_filter($posts, static fn (array $post): bool => $post['number'] > (int) $cursor['last_post'])),
                            'sourcePosts' => $posts, 'previous' => $previous,
                            'trackPending' => true,
                            'settings' => $settings, 'now' => $now * 1000,
                        ]);
                    }
                }
            } catch (BoardFetchException | DetectionWorkerException $error) {
                $errorCode = $error->errorCode;
                $nextThreads = null;
                $nextCursor = null;
                $detected = null;
            } catch (MonitoringBudgetException) {
                $statistics['deferred'] = true;
                return $statistics;
            }
            if (!commitMonitoringResource($database, $subscription, $board, $resource, $now, $errorCode, $nextThreads, $nextCursor, $detected)) {
                // An API update/stop/delete won the race. Do not fetch other stale targets.
                break;
            }
            if ($errorCode !== null) {
                ++$statistics['errors'];
            } else {
                ++$statistics['processed'];
                if ($nextThreads !== null) {
                    $threads = $nextThreads;
                }
            }
        }
    }
    return $statistics;
}
