<?php

declare(strict_types=1);

use Sureneco\FcmTrial\PersistentMonitor;
use Sureneco\FcmTrial\RecruitmentMonitor;
use Sureneco\FcmTrial\SafeFailure;

require dirname(__DIR__) . '/vendor/autoload.php';

$assertions = 0;
$assert = static function (bool $passed, string $label) use (&$assertions): void {
    ++$assertions;
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
$writeJson = static function (string $path, array $value): void {
    file_put_contents($path, json_encode($value, JSON_THROW_ON_ERROR));
    chmod($path, 0600);
};
$directory = sys_get_temp_dir() . '/sureneco-persistent-test-' . bin2hex(random_bytes(8));
mkdir($directory, 0700);
$makeRoot = static function (string $name) use ($directory, $writeJson): string {
    $root = $directory . '/' . $name;
    mkdir($root, 0700);
    mkdir($root . '/state', 0700);
    $writeJson($root . '/config.json', ['enabled' => true, 'filter' => ' LOOSE ', 'thread_refresh_sec' => 300]);
    return $root;
};
$refresh = static function (string $root) use ($writeJson): void {
    $runtime = json_decode(file_get_contents($root . '/state/runtime.json'), true, 64, JSON_THROW_ON_ERROR);
    $runtime['list']['attemptedAt'] = null;
    $writeJson($root . '/state/runtime.json', $runtime);
};
$remove = static function (string $path) use (&$remove): void {
    if (is_dir($path) && !is_link($path)) {
        foreach (new FilesystemIterator($path) as $entry) {
            $remove($entry->getPathname());
        }
        rmdir($path);
    } else {
        unlink($path);
    }
};
$id = (string) (time() - 600);
$nextId = (string) (time() - 500);
$endedId = (string) (time() - 400);
$date = (new DateTimeImmutable('now', new DateTimeZone('Asia/Tokyo')))->format('Y/m/d(D) H:i:s') . '.00';
$line = static fn (string $body, string $author = 'host'): string => "名無し<>sage<>$date ID:$author<>$body<>雀魂";
$subject = "$id.dat<>【雀魂】友人戦 (2)\n$endedId.dat<>【雀魂】完走 (1000)\n";
$dat = [$id => [$line('四南 12345')]];
$listFails = false;
$broken = [];
$fetches = [];
$monitor = new RecruitmentMonitor(static function (string $resource) use (&$subject, &$dat, &$listFails, &$broken, &$fetches): string {
    $fetches[] = $resource;
    if ($resource === 'subject.txt') {
        if ($listFails) {
            throw new RuntimeException('secret-token-should-not-appear');
        }
        return $subject;
    }
    $thread = basename($resource, '.dat');
    return isset($broken[$thread]) ? 'not a DAT' : implode("\n", $dat[$thread]);
});
$attempts = [];
$reject = false;
$send = static function (string $thread, int $number, array $rooms, int $expiry) use (&$attempts, &$reject): array {
    $attempts[] = [$thread, $number, $rooms, $expiry];
    if ($reject) {
        throw new SafeFailure('fcm_network_failed');
    }
    return ['status' => 'accepted'];
};

try {
    $root = $makeRoot('continuity');
    $scheduler = new PersistentMonitor($root, $monitor, $send);
    $assert($scheduler->status()['status'] === 'stale' && $scheduler->status()['lastSuccessAt'] === null, 'Initial status is not a successful tick');
    $first = $scheduler->tick();
    $assert($first['status'] === 'idle' && $first['counts']['candidates'] === 1 && $first['counts']['sent'] === 0, 'Baseline suppresses history and excludes completed candidates');
    $assert($first['threads'][0]['baseline'] === true && $first['threads'][0]['lastPost'] === 1, 'Record baseline and cursor');
    $assert(json_decode(file_get_contents($root . '/config.json'), true)['filter'] === 'loose', 'Normalize the explicitly selected filter');
    $dat[$id][] = $line('3人半荘 13589', 'fresh');
    $second = $scheduler->tick();
    $assert($second['counts']['sent'] === 1 && $attempts[0][1] === 2 && $attempts[0][2] === ['13589'], 'Next acquisition sends a new loose-filter recruitment');
    $scheduler = new PersistentMonitor($root, $monitor, $send);
    $assert($scheduler->tick()['counts']['sent'] === 0 && count($attempts) === 1, 'Restart does not reset cursors or resend acceptance');
    $dat[$id][] = $line('3人半荘 24680', 'restart');
    $assert($scheduler->tick()['counts']['sent'] === 1 && count($attempts) === 2, 'Restart continues detecting new posts');

    $paused = $scheduler->setEnabled(false);
    $beforeFetches = count($fetches);
    $beforeSends = count($attempts);
    $dat[$id][] = $line('3人半荘 35791', 'pause');
    $pausedTick = (new PersistentMonitor($root, $monitor))->tick();
    $assert($paused['status'] === 'paused' && $pausedTick['status'] === 'paused', 'Pause is visible and persists across construction');
    $assert(count($fetches) === $beforeFetches && count($attempts) === $beforeSends, 'Paused ticks do not fetch, read absent secrets, or send');
    $assert($pausedTick['completedAt'] !== null && $pausedTick['completedAt'] >= $paused['completedAt'], 'Paused cron still persists its heartbeat');
    $scheduler->setEnabled(true);
    $assert($scheduler->tick()['counts']['sent'] === 1 && count($attempts) === $beforeSends + 1, 'Resume retains the pre-pause cursor');

    $refresh($root);
    $listFails = true;
    $dat[$id][] = $line('3人半荘 46802', 'cached');
    $degraded = $scheduler->tick();
    $assert($degraded['status'] === 'degraded' && $degraded['counts']['sent'] === 1 && $degraded['counts']['candidates'] === 1, 'Listing failure preserves and scans the last successful candidates');
    $assert(!str_contains(json_encode($degraded), 'secret-token'), 'Exceptions never expose raw messages');
    $listFails = false;
    $subject = "$nextId.dat<>【雀魂】次スレ (1)\n$endedId.dat<>【雀魂】完走 (1001)\n";
    $dat[$nextId] = [$line('3人半荘 57913', 'history')];
    $refresh($root);
    $replaced = $scheduler->tick();
    $assert($replaced['status'] === 'idle' && $replaced['counts']['candidates'] === 1 && $replaced['counts']['sent'] === 0, 'Recovered listing replaces candidates and baselines a natural new thread');
    $assert($replaced['threads'][0]['id'] === $nextId && $replaced['threads'][0]['baseline'] === true, 'Replacement thread has its own cursor');
    $dat[$nextId][] = $line('3人半荘 68024', 'new-thread');
    $assert($scheduler->tick()['counts']['sent'] === 1 && end($attempts)[0] === $nextId, 'New thread delivers only subsequent posts');
    $subject = "$id.dat<>【雀魂】戻ったスレ (5)\n$nextId.dat<>【雀魂】次スレ (2)\n";
    $refresh($root);
    $assert($scheduler->tick()['counts']['sent'] === 0, 'Temporarily removed candidates keep their cursor on return');

    $reject = true;
    $dat[$nextId][] = $line('3人半荘 79135', 'retry');
    $failed = $scheduler->tick();
    $assert($failed['status'] === 'degraded' && $failed['counts']['pending'] === 1 && $failed['counts']['failed'] === 1, 'Sender failure retains the existing monitor queue: ' . json_encode($failed));
    $failedAttempts = count($attempts);
    $broken[$nextId] = true;
    $dat[$id][] = $line('3人半荘 80246', 'healthy');
    $reject = false;
    $partial = $scheduler->tick();
    $assert(count($attempts) === $failedAttempts + 1 && end($attempts)[0] === $id && $partial['counts']['succeeded'] === 1, 'One broken thread does not block others or deliver its stale queue');
    unset($broken[$nextId]);
    $dat[$nextId][] = $line('&gt;&gt;3 満員', 'retry');
    $closed = $scheduler->tick();
    $assert($closed['counts']['pending'] === 0 && count($attempts) === $failedAttempts + 1, 'Failed delivery is re-evaluated and removed when closed');
    $reject = true;
    $dat[$nextId][] = $line('3人半荘 91357', 'retry-success');
    $scheduler->tick();
    $failedAttempt = end($attempts);
    $reject = false;
    $retry = (new PersistentMonitor($root, $monitor, $send))->tick();
    $assert($retry['counts']['sent'] === 1 && end($attempts) === $failedAttempt && $retry['counts']['pending'] === 0, 'Restart retries the same event only after fresh re-evaluation and deletes acceptance');

    $statusPath = $root . '/state/status.json';
    $status = json_decode(file_get_contents($statusPath), true, 64, JSON_THROW_ON_ERROR);
    $status['status'] = 'running';
    $writeJson($statusPath, $status);
    $assert($scheduler->status()['status'] === 'stale', 'An interrupted process is not a successful completed tick');
    $status['status'] = 'idle';
    $status['completedAt'] = (time() - 600) * 1000;
    $writeJson($statusPath, $status);
    $assert($scheduler->status()['status'] === 'stale', 'A missing cron heartbeat becomes stale');
    $scheduler->tick();
    foreach (glob($root . '/state/*') as $file) {
        $assert((fileperms($file) & 0777) === 0600, 'Every persistent state file is private');
    }
    $assert(filesize($statusPath) < 32768, 'Status stays bounded instead of accumulating logs');

    $lock = fopen($root . '/state/run.lock', 'r+b');
    flock($lock, LOCK_EX);
    $beforeFetches = count($fetches);
    $scheduler->tick();
    $assert(count($fetches) === $beforeFetches, 'Overlapping tick is nonblocking and does no work');
    $code = 'require ' . var_export(dirname(__DIR__) . '/vendor/autoload.php', true)
        . '; (new \\Sureneco\\FcmTrial\\PersistentMonitor($argv[1]))->setEnabled(false);';
    $process = proc_open([PHP_BINARY, '-r', $code, $root], [['file', '/dev/null', 'r'], ['file', '/dev/null', 'w'], ['pipe', 'w']], $pipes);
    try {
        usleep(100000);
        $assert(is_resource($process) && proc_get_status($process)['running'], 'Pause waits for the current tick lock');
        flock($lock, LOCK_UN);
        fclose($lock);
        $error = stream_get_contents($pipes[2]);
        fclose($pipes[2]);
        $assert(proc_close($process) === 0 && $error === '' && !$scheduler->status()['enabled'], 'Pause completes only after exclusion and persists the stop');
    } finally {
        if (is_resource($lock)) {
            fclose($lock);
        }
        if (is_resource($process)) {
            proc_terminate($process);
            proc_close($process);
        }
    }

    $unsafe = $makeRoot('unsafe');
    chmod($unsafe . '/config.json', 0644);
    $fails(fn () => (new PersistentMonitor($unsafe, $monitor, $send))->tick(), 'invalid_state_path');
    chmod($unsafe . '/config.json', 0600);
    rename($unsafe . '/config.json', $unsafe . '/real-config.json');
    symlink($unsafe . '/real-config.json', $unsafe . '/config.json');
    $fails(fn () => (new PersistentMonitor($unsafe, $monitor, $send))->tick(), 'invalid_state_path');
    $fails(fn () => new PersistentMonitor($directory . '/continuity/../unsafe'), 'invalid_state_path');
} finally {
    $remove($directory);
}
echo "PHP常設監視: $assertions assertions (実QuickJS・SQLite、初回／再起動・停止・候補更新・再判定・安全な状態)\n";
