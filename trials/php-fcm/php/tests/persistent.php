<?php

declare(strict_types=1);

use Sureneco\FcmTrial\PersistentMonitor;
use Sureneco\FcmTrial\RecruitmentMonitor;
use Sureneco\FcmTrial\SafeFailure;
use Sureneco\FcmTrial\SelectionEndpoint;

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
$postTime = new DateTimeImmutable('now', new DateTimeZone('Asia/Tokyo'));
$date = $postTime->format('Y/m/d(D) H:i:s') . '.00';
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

    $root = $makeRoot('selection');
    mkdir($root . '/secrets', 0700);
    $subject = "$id.dat<>【雀魂】既存の友人戦 (1)\n";
    $dat[$id] = [$line('四南 12345', 'baseline')];
    $dat[$nextId] = [$line('3人半荘 24680', 'older')];
    $scheduler = new PersistentMonitor($root, $monitor, $send);
    $scheduler->tick();
    $legacy = json_decode(file_get_contents($root . '/state/runtime.json'), true, 64, JSON_THROW_ON_ERROR);
    unset($legacy['candidates'][0]['title']);
    $writeJson($root . '/state/runtime.json', $legacy);
    $request = static function (string $method, ?string $authorization, string $body = '', ?string $type = 'application/json') use ($scheduler): array {
        return SelectionEndpoint::dispatch($scheduler, $method, $authorization, $type, $body);
    };
    $registrationPath = $root . '/secrets/registration-token.txt';
    $registration = 'fixture:configured_registration-token';
    $proofFor = static fn (string $value): string => hash('sha256', 'sureneco-php-selection-v1:' . $value);
    $proofBody = static fn (string $proof): string => json_encode(['registrationProof' => $proof], JSON_THROW_ON_ERROR);
    $proof = $proofFor($registration);
    $exchange = static fn (string $proof): array => $request('POST', null, $proofBody($proof));
    $unauthorized = [401, ['error' => 'unauthorized']];
    $invalid = [400, ['error' => 'invalid_request']];
    $unavailable = [503, ['error' => 'unavailable']];
    file_put_contents($registrationPath, $registration . "\n");
    chmod($registrationPath, 0600);
    $assert($exchange($proof) === $unavailable, 'Exchange never provisions selection');
    $authPath = $root . '/secrets/selection-auth.json';
    $writeJson($authPath, ['token' => str_repeat('a', 64)]);
    $assert($exchange($proof) === $unavailable, 'A bearer file alone does not make selection ready');
    unlink($authPath);
    $assert($request('GET', 'Bearer ' . str_repeat('a', 64))[0] === 503, 'API unavailable before explicit provisioning');
    $scheduler->provisionSelection();
    $token = json_decode(file_get_contents($authPath), true, 64, JSON_THROW_ON_ERROR)['token'];
    $authorization = 'Bearer ' . $token;
    $assert(preg_match('/\A[a-f0-9]{64}\z/', $token) === 1 && (fileperms($authPath) & 0777) === 0600, 'Provision a private dedicated token');
    $assert($exchange($proof) === [200, ['token' => $token]], 'Exchange returns only the existing bearer for the configured recipient');
    $assert($request('POST', null, ' { "registration\u0050roof" : "' . $proof . '" } ') === [200, ['token' => $token]],
        'Equivalent JSON encoding still exchanges a single proof');
    $assert($exchange(str_repeat('0', 64)) === $unauthorized, 'Reject a nonmatching registration proof without returning a bearer');
    $assert($request('POST', null, '{}') === $unauthorized && $request('POST', null) === $unauthorized,
        'Reject a missing credential');
    $assert($request('GET', null, $proofBody($proof)) === $unauthorized, 'GET cannot exchange proofs');
    $assert($request('POST', null, '{"id":"' . $id . '","enabled":false}') === $unauthorized,
        'An unauthenticated mutation cannot use the exchange');
    foreach (['', 'Basic credentials'] as $header) {
        $assert($request('POST', $header, $proofBody($proof)) === $unauthorized, 'Invalid Authorization prevents exchange');
    }
    foreach (['Bearer ' . str_repeat('0', 64), $authorization] as $header) {
        $assert($request('POST', $header, $proofBody($proof)) === $invalid, 'Bearer-shaped Authorization routes to mutation validation');
    }
    foreach (['[]', '{', str_repeat(' ', 1025), '{"registrationProof":null}', $proofBody(strtoupper($proof)),
        $proofBody($registration), '{"registrationProof":"' . $proof . '","extra":true}',
        '{"registrationProof":"' . $proof . '","registrationProof":"' . $proof . '"}'] as $bad) {
        $assert($request('POST', null, $bad) === $invalid, 'Reject malformed or non-exact exchange input');
    }
    $assert($request('POST', null, $proofBody($proof), 'text/plain') !== [200, ['token' => $token]],
        'Non-JSON media types cannot exchange');
    chmod($registrationPath, 0644);
    $assert($exchange($proof) === $unavailable, 'Fail closed on a non-private registration file');
    chmod($registrationPath, 0600);
    chmod($root . '/secrets', 0755);
    $assert($exchange($proof) === $unavailable, 'Fail closed on a non-private secrets directory');
    chmod($root . '/secrets', 0700);
    rename($registrationPath, $registrationPath . '.old');
    $assert($exchange($proof) === $unauthorized, 'No registration file means no authorized recipient');
    symlink($registrationPath . '.old', $registrationPath);
    $assert($exchange($proof) === $unavailable, 'Fail closed on a symlink to another private file');
    unlink($registrationPath);
    $replacement = 'fixture:replacement_registration-token';
    file_put_contents($registrationPath, $replacement);
    chmod($registrationPath, 0600);
    $assert($exchange($proof) === $unauthorized && $exchange($proofFor($replacement)) === [200, ['token' => $token]],
        'Exchange immediately follows rotation of the configured recipient');
    $assert($request('GET', null)[0] === 401 && $request('GET', 'Bearer ' . str_repeat('0', 64))[0] === 401, 'Reject missing and incorrect credentials');
    $assert($request('DELETE', $authorization)[0] === 405 && $request('POST', $authorization, '', 'text/plain')[0] === 415, 'Only allow supported methods and JSON mutations');
    foreach (['[]', '{', '{"id":123,"enabled":true}', '{"id":"' . $id . '","enabled":"true"}',
        '{"id":"' . $id . '","enabled":true,"extra":1}', str_repeat(' ', 1025)] as $bad) {
        $assert($request('POST', $authorization, $bad)[0] === 400, 'Reject malformed or oversized update');
    }
    $update = static fn (string $thread, bool $enabled): array => $request('POST', $authorization,
        json_encode(['id' => $thread, 'enabled' => $enabled], JSON_THROW_ON_ERROR));
    $initial = ['threads' => [['id' => $id, 'title' => $id, 'enabled' => true]], 'recruitments' => [],
        'settings' => ['thread_refresh_sec' => 300, 'recruitment_filter' => 'loose']];
    $assert($request('GET', $authorization) === [200, $initial], 'Snapshot legacy runtime without needing network');
    $settings = static fn (mixed $seconds, mixed $filter, ?string $bearer): array => $request('POST', $bearer,
        json_encode(['settings' => ['thread_refresh_sec' => $seconds, 'recruitment_filter' => $filter]], JSON_THROW_ON_ERROR));
    foreach ([[59, 'regex'], [86401, 'loose'], [60.5, 'regex'], ['60', 'regex'], [60, 'REGEX'], [60, null]] as [$seconds, $filter]) {
        $assert($settings($seconds, $filter, $authorization) === $invalid, 'Reject out-of-range and non-exact settings');
    }
    $assert($settings(60, 'regex', null) === $unauthorized, 'Settings require authorization');
    $assert($settings(60, 'regex', 'Bearer ' . str_repeat('0', 64)) === $unauthorized, 'Incorrect bearer cannot save settings');
    $assert($settings(86400, 'regex', $authorization) === [200, array_replace($initial, ['settings' => [
        'thread_refresh_sec' => 86400, 'recruitment_filter' => 'regex',
    ]])], 'Save upper-bound refresh interval and return the updated snapshot');
    $restarted = new PersistentMonitor($root, $monitor, $send);
    $assert($restarted->status()['threadRefreshSec'] === 86400 && $restarted->status()['filter'] === 'regex',
        'Settings persist for the restarted scheduler');
    $initial['settings']['thread_refresh_sec'] = 60;
    $assert($settings(60, 'loose', $authorization) === [200, $initial], 'Save the lower bound and restore loose detection');
    $assert($update($endedId, true)[0] === 404, 'Reject an unknown candidate');
    $lock = fopen($root . '/state/run.lock', 'r+b');
    flock($lock, LOCK_EX);
    try {
        $assert($request('GET', $authorization)[0] === 409 && $update($id, false)[0] === 409, 'API is nonblocking on the cron lock');
        $assert($settings(86400, 'regex', $authorization)[0] === 409, 'Settings save does not race a cron tick');
    } finally {
        fclose($lock);
    }

    $subject .= "$nextId.dat<>【雀魂】新しい友人戦 (1)\n";
    $dat[$id][] = $line('3人半荘 13589', 'existing-after-provision');
    $beforeSends = count($attempts);
    $beforeFetches = count($fetches);
    $refreshed = $scheduler->tick();
    $both = ['threads' => [
        ['id' => $id, 'title' => '【雀魂】既存の友人戦', 'enabled' => true],
        ['id' => $nextId, 'title' => '【雀魂】新しい友人戦', 'enabled' => false],
    ], 'recruitments' => [], 'settings' => $initial['settings']];
    $snapshot = $request('GET', $authorization);
    $postedAt = $postTime->getTimestamp() * 1000;
    $both['recruitments'] = [['threadId' => $id, 'number' => 2, 'body' => '3人半荘 13589', 'roomIds' => ['13589'],
        'postedAt' => $postedAt, 'expiresAt' => $snapshot[1]['recruitments'][0]['expiresAt'] ?? null]];
    $assert(is_int($both['recruitments'][0]['expiresAt']) && $both['recruitments'][0]['expiresAt'] > end($attempts)[3],
        'A delivered recruitment has a real expiration');
    $assert($snapshot === [200, $both], 'Refresh keeps existing selection and persists new titles with new candidates off: '
        . json_encode(['snapshot' => $snapshot, 'list' => $refreshed['list']], JSON_UNESCAPED_UNICODE));
    $assert(SelectionEndpoint::dispatch(new PersistentMonitor($root), 'GET', $authorization, null, '') === $snapshot,
        'The delivered recruitment survives scheduler reconstruction without board access');
    $assert(count($attempts) === $beforeSends + 1 && end($attempts)[0] === $id && end($attempts)[1] === 2, 'Provisioning preserves the selected cursor');
    $assert(array_slice($fetches, $beforeFetches) === ['subject.txt', "dat/$id.dat"], 'Skip DAT for a disabled candidate');
    $broken[$nextId] = true;
    $assert($update($nextId, true)[0] === 503 && $request('GET', $authorization) === [200, $both], 'Failed enabling baseline leaves selection off');
    unset($broken[$nextId]);
    $both['threads'][1]['enabled'] = true;
    $assert($update($nextId, true) === [200, $both], 'Enable only after a successful baseline');
    $assert($scheduler->tick()['counts']['sent'] === 0, 'First enable does not replay old DAT');
    $dat[$nextId][] = $line('3人半荘 35791', 'already-enabled');
    $assert($update($nextId, true) === [200, $both], 'Repeated ON is idempotent');
    $reject = true;
    $assert($scheduler->tick()['counts']['pending'] === 1 && end($attempts)[0] === $nextId && end($attempts)[1] === 2,
        'A post after the successful baseline stays eligible, including after an ON retry');
    $pending = $request('GET', $authorization)[1]['recruitments'];
    $assert(count($pending) === 2 && in_array($nextId, array_column($pending, 'threadId'), true),
        'Delivery rejection does not erase a genuine detection');
    $reject = false;
    $both['threads'][1]['enabled'] = false;
    $assert($update($nextId, false) === [200, $both], 'Turn a currently selected candidate off');
    $dat[$nextId][] = $line('3人半荘 46802', 'while-disabled');
    $beforeSends = count($attempts);
    $scheduler->tick();
    $assert(count($attempts) === $beforeSends, 'While off neither queued nor newer posts are sent');
    $latest = array_splice($dat[$nextId], 1);
    $assert($update($nextId, true)[0] === 503 && $request('GET', $authorization) === [200, $both],
        'A truncated DAT must not rewind a prior cursor or enable prematurely');
    array_push($dat[$nextId], ...$latest);
    $both['threads'][1]['enabled'] = true;
    $assert($update($nextId, true) === [200, $both], 'Re-enable refreshes the DAT baseline');
    $assert($scheduler->tick()['counts']['pending'] === 0 && count($attempts) === $beforeSends, 'Re-enable discards queued and while-off posts');
    $dat[$nextId][] = $line('3人半荘 57913', 'after-re-enable');
    $scheduler->tick();
    $assert(count($attempts) === $beforeSends + 1 && end($attempts)[0] === $nextId && end($attempts)[1] === 4,
        'Posts after re-enable are delivered normally');
    $dat[$nextId][] = $line('&gt;&gt;4 満員', 'after-re-enable');
    $scheduler->tick();
    $assert($request('GET', $authorization) === [200, $both], 'A later close removes the already delivered recruitment');
    $scheduler->provisionSelection();
    $assert($request('GET', $authorization) === [200, $both], 'Reprovisioning does not reset credentials or selection');
    $subject = "$nextId.dat<>【雀魂】新しい友人戦 (5)\n";
    $refresh($root);
    $scheduler->tick();
    $hidden = $request('GET', $authorization);
    $assert($hidden === [200, ['threads' => [$both['threads'][1]], 'recruitments' => [], 'settings' => $both['settings']]],
        'Removed candidates and their recruitment history are no longer visible');
    $state = new PDO('sqlite:' . $root . '/state/monitor.sqlite');
    $assert((int) $state->query('SELECT COUNT(*) FROM recruitment_history')->fetchColumn() === 0,
        'Removed candidates are purged from stored recruitment history');
    $settings(60, 'regex', $authorization);
    $dat[$nextId][] = $line('3人 半荘 12345', 'regex-test');
    $assert($scheduler->tick()['counts']['sent'] === 0 && $request('GET', $authorization)[1]['recruitments'] === [],
        'The saved regex setting governs future detection, not just the settings snapshot');
    $settings(60, 'loose', $authorization);
    $dat[$nextId][] = $line('3人 半荘 23456', 'loose-test');
    $assert($scheduler->tick()['counts']['sent'] === 1
        && array_column($request('GET', $authorization)[1]['recruitments'], 'roomIds') === [['23456']],
        'The saved loose setting detects the next post without replaying the prior cursor');

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
