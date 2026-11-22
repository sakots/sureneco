<?php

declare(strict_types=1);

use Sureneco\FcmTrial\RecruitmentMonitor;
use Sureneco\FcmTrial\SafeFailure;

require dirname(__DIR__) . '/src/SafeFailure.php';
require dirname(__DIR__) . '/src/MonitorIo.php';
require dirname(__DIR__) . '/src/RecruitmentMonitor.php';

$assert = static function (bool $passed, string $label): void {
    if (!$passed) {
        throw new RuntimeException($label);
    }
};
$fails = static function (callable $run, string $reason) use ($assert): void {
    try {
        $run();
    } catch (SafeFailure $error) {
        $assert($error->reason === $reason, 'Expected ' . $reason . ', got ' . $error->reason);
        return;
    }
    throw new RuntimeException('Expected ' . $reason);
};

$directory = sys_get_temp_dir() . '/sureneco-monitor-test-' . bin2hex(random_bytes(8));
mkdir($directory, 0700);
$db = $directory . '/monitor.sqlite';
$now = (new DateTimeImmutable('2026-11-22T12:00:00+09:00'))->getTimestamp() * 1000;
$id = (string) (intdiv($now, 1000) - 600);
$line = static fn (string $body, string $author = 'host', string $time = '11:59:00.00'): string =>
    "名無し<>sage<>2026/11/22(日) $time ID:$author<>$body<>雀魂";
$dat = [$line('挨拶')];
$monitor = new RecruitmentMonitor(static function (string $resource) use ($id, &$dat, $assert): string {
    if ($resource === 'subject.txt') {
        return "$id.dat<>【雀魂】 友人戦 &amp; 雑談 (8)\n1790000000.dat<>【雀魂】古い (3)\n"
            . ((int) $id - 1) . ".dat<>別ゲーム (5)\n";
    }
    $assert($resource === "dat/$id.dat", 'Only the watched thread should be fetched');
    return implode("\n", $dat);
});

try {
    $threads = $monitor->listThreads($now)['threads'];
    $assert(array_column($threads, 'id') === [$id] && $threads[0]['title'] === '【雀魂】 友人戦 & 雑談', 'Only current Mahjong Soul candidates');

    $dat[] = $line('四南 23456');
    $first = $monitor->scan($id, $db, 'loose', $now);
    $assert($first['baseline'] && $first['lastPost'] === 2 && $first['recruitments'] === [], 'Do not notify on first acquisition');
    $assert((fileperms($db) & 0777) === 0600 && (fileperms($db . '.lock') & 0777) === 0600, 'State files must be private');

    $dat[] = $line('三麻半荘友人戦募集にゃ<br><br>24328<br>5分後爆破', 'fresh');
    $dat[] = $line('&gt;&gt;2 あと1人', 'other');
    $dat[] = $line('&gt;&gt;4 満員', 'other');
    $dat[] = $line('&gt;&gt;2 あと1人', 'another');
    $dat[] = $line('四南 34567 1分後爆破', 'deadline');
    $second = $monitor->scan($id, $db, 'loose', $now);
    $assert(!$second['baseline'] && $second['lastPost'] === 7 && array_column($second['recruitments'], 'number') === [3], 'Exclude closing chain, later reply and exact deadline');
    $assert($second['recruitments'][0]['roomIds'] === ['24328'] && $second['recruitments'][0]['expiresAt'] === $now + 240_000, 'Shared loose filter and relative deadline');
    $assert($monitor->scan($id, $db, 'loose', $now)['recruitments'] === [], 'Repeated execution must not replay posts');

    $healthy = $dat;
    $dat = ['not a DAT'];
    $fails(fn () => $monitor->scan($id, $db, 'loose', $now), 'invalid_dat');
    $dat = array_slice($healthy, 0, 3);
    $fails(fn () => $monitor->scan($id, $db, 'loose', $now), 'dat_regressed');
    $dat = [...$healthy, $line('四南 56789')];
    $lock = fopen($db . '.lock', 'r+');
    flock($lock, LOCK_EX);
    try {
        $fails(fn () => $monitor->scan($id, $db, 'loose', $now), 'monitor_busy');
    } finally {
        fclose($lock);
    }
    $state = new PDO('sqlite:' . $db);
    $state->exec("CREATE TRIGGER reject_detection BEFORE INSERT ON detected_recruitments
        BEGIN SELECT RAISE(ABORT, 'write failed'); END");
    try {
        $monitor->scan($id, $db, 'loose', $now);
        throw new RuntimeException('Expected database failure');
    } catch (PDOException) {
        $assert((int) $state->query('SELECT last_post FROM cursors')->fetchColumn() === 7, 'Failed persistence rolls back cursor');
    }
    $state->exec('DROP TRIGGER reject_detection');
    $retry = $monitor->scan($id, $db, 'loose', $now);
    $assert(array_column($retry['recruitments'], 'number') === [8], 'Failed or overlapping scan must not consume posts');
    $assert($state->query('SELECT post_number FROM detected_recruitments ORDER BY post_number')->fetchAll(PDO::FETCH_COLUMN) === [3, 8], 'Keep each detection once across scans');
    $monitor->scan($id, $db, 'loose', $now + 240_000);
    $assert($state->query('SELECT post_number FROM detected_recruitments')->fetchAll(PDO::FETCH_COLUMN) === [8], 'Remove detections at expiry');
    $assert($state->query('SELECT post_number FROM recruitment_history')->fetchAll(PDO::FETCH_COLUMN) === [8],
        'Expiry removes the history row at the same detection deadline');
    $dat[] = $line('&gt;&gt;8 あと1人', 'followup');
    $dat[] = $line('&gt;&gt;9 満員', 'followup');
    $monitor->scan($id, $db, 'loose', $now + 241_000);
    $assert($state->query('SELECT post_number FROM detected_recruitments')->fetchAll(PDO::FETCH_COLUMN) === [], 'Closing a later reply removes the saved original');

    $dat[] = $line('四南 67890', 'send1');
    $attempts = [];
    $send = static function (string $thread, int $post, array $rooms, int $expiry) use (&$attempts): array {
        $attempts[] = [$thread, $post, $rooms, $expiry];
        if (count($attempts) === 1) {
            throw new SafeFailure('fcm_network_failed');
        }
        return ['status' => 'accepted'];
    };
    $fails(fn () => $monitor->deliver($id, $db, 'loose', $send, $now + 242_000), 'fcm_network_failed');
    $failedDat = $dat;
    $dat = ['not a DAT'];
    $fails(fn () => $monitor->deliver($id, $db, 'loose', $send, $now + 243_000), 'invalid_dat');
    $assert(count($attempts) === 1, 'Never send queued items when refresh fails');
    $dat = [...$failedDat, $line('四南 78901', 'send2')];
    $assert($monitor->deliver($id, $db, 'loose', $send, $now + 244_000)['delivery']['status'] === 'accepted'
        && $attempts[0] === $attempts[1], 'Retry the same recruitment, at most one per run');
    $dat[] = $line('&gt;&gt;12 満員', 'send2');
    $assert($monitor->deliver($id, $db, 'loose', $send, $now + 245_000)['delivery']['status'] === 'idle'
        && count($attempts) === 2, 'Do not resend accepted recruitment or send newly closed pending recruitment');
    $assert($state->query('SELECT post_number FROM recruitment_history')->fetchAll(PDO::FETCH_COLUMN) === [11],
        'Acceptance keeps the recruitment visible, while a close removes a pending room from both stores');
    $dat[] = $line('四南 89012', 'send3');
    $reject = static function (): never {
        throw new SafeFailure('fcm_network_failed');
    };
    $fails(fn () => $monitor->deliver($id, $db, 'loose', $reject, $now + 246_000), 'fcm_network_failed');
    $assert($monitor->deliver($id, $db, 'loose', $send, $now + 546_000)['delivery']['status'] === 'idle'
        && count($attempts) === 2, 'Ambiguous events expire at the first attempt window even if the room is open');
    $assert($state->query('SELECT post_number FROM recruitment_history ORDER BY post_number')->fetchAll(PDO::FETCH_COLUMN) === [11, 14],
        'Notification retry cutoff does not shorten either real recruitment deadline');
    for ($i = 0; $i < 201; ++$i) {
        $dat[] = $line('四南 90123', 'bulk');
    }
    $monitor->scan($id, $db, 'loose', $now + 547_000);
    $assert($state->query('SELECT post_number FROM recruitment_history ORDER BY post_number')->fetchAll(PDO::FETCH_COLUMN) === range(16, 215),
        'Retain at most the 200 newest recruitment detections');
    $assert((int) $state->query('SELECT COUNT(*) FROM detected_recruitments')->fetchColumn() === 201,
        'The history size limit must not drop undelivered notifications');
} finally {
    foreach (glob($directory . '/*') as $file) {
        unlink($file);
    }
    rmdir($directory);
}
echo "PHP募集監視: 候補一覧・初回基準・新着判定・締め／期限・重複・失敗復旧を確認\n";
