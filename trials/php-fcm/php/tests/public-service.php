<?php

declare(strict_types=1);

use Sureneco\FcmTrial\PublicEndpoint;
use Sureneco\FcmTrial\PublicService;

require dirname(__DIR__) . '/vendor/autoload.php';

$directory = sys_get_temp_dir() . '/sureneco-public-test-' . bin2hex(random_bytes(8));
mkdir($directory, 0700);
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
$checks = 0;
$check = static function (bool $passed, string $message) use (&$checks): void {
    ++$checks;
    if (!$passed) {
        throw new RuntimeException($message);
    }
};
$now = time();
$ids = array_map(static fn (int $index): string => (string) (time() - 300 + $index), range(1, 4));
$date = (new DateTimeImmutable('now', new DateTimeZone('Asia/Tokyo')))->format('Y/m/d(D) H:i:s') . '.00';
$line = static fn (string $body, string $author = 'host'): string => "名無し<>sage<>$date ID:$author<>$body<>雀魂";
$files = ['subject.txt' => implode("\n", array_map(static fn (string $id): string => "$id.dat<>【雀魂】友人戦 (2)", $ids)) . "\n"];
foreach ($ids as $id) {
    $files["dat/$id.dat"] = $line('おはよう') . "\n";
}
$challengeMessages = $notifications = $fetches = [];
$challengeFails = false;
$deliveryFails = false;
$make = static function (string $name) use ($directory, &$now, &$files, &$challengeMessages, &$notifications, &$fetches, &$challengeFails, &$deliveryFails): PublicService {
    $root = "$directory/$name";
    if (!is_dir($root)) {
        mkdir($root, 0700);
        mkdir("$root/state", 0700);
    }
    return new PublicService($root,
        static function (string $token, array $message) use (&$challengeMessages, &$challengeFails): void {
            $challengeMessages[$token] = $message;
            if ($challengeFails) {
                throw new RuntimeException('provider-secret-do-not-echo');
            }
        },
        static function (string $token, string $thread, int $post, array $rooms, int $expires) use (&$notifications, &$deliveryFails): array {
            $notifications[] = [$token, $thread, $post, $rooms, $expires];
            if ($deliveryFails) {
                throw new RuntimeException('delivery-secret-do-not-echo');
            }
            return ['status' => 'accepted'];
        },
        static function (string $file) use (&$fetches, &$files): string {
            $fetches[] = $file;
            return $files[$file] ?? throw new RuntimeException('resource-secret-do-not-echo');
        },
        static function () use (&$now): int { return $now; },
    );
};
$call = static fn (PublicService $service, ?array $body = null, ?string $bearer = null, string $address = '192.0.2.1'): array =>
    PublicEndpoint::dispatch($service, $body === null ? 'GET' : 'POST', $bearer === null ? null : 'Bearer ' . $bearer,
        'application/json; charset=utf-8', $body === null ? '' : json_encode($body, JSON_THROW_ON_ERROR), $address);
$begin = static fn (PublicService $service, string $token, string $bearer, string $address = '192.0.2.1'): array =>
    $call($service, ['action' => 'begin', 'registrationToken' => $token, 'bearer' => $bearer], null, $address);
$finish = static fn (PublicService $service, array $message, string $bearer, ?string $code = null): array =>
    $call($service, ['action' => 'finish', 'challengeId' => $message['challengeId'], 'code' => $code ?? $message['code'], 'bearer' => $bearer]);
$a = str_repeat('a', 64);
$b = str_repeat('b', 64);
$c = str_repeat('c', 64);
$wrong = str_repeat('0', 64);

try {
    $service = $make('scope');
    $check($call($service) === [401, ['error' => 'unauthorized']], 'GET needs authentication');
    $check($begin($service, "unsafe\nregistration", $a)[0] === 400 && $challengeMessages === [], 'Invalid destinations do not send');
    $root = "$directory/scope";
    [$status, $payload] = $begin($service, 'fcm-A', $a);
    $proofA = $challengeMessages['fcm-A'];
    $check($status === 200 && $payload === ['challengeId' => $proofA['challengeId']]
        && preg_match('/\A[a-f0-9]{32}\z/', $payload['challengeId']) === 1, 'Begin does not disclose the code');
    $check($proofA['type'] === 'registration_challenge' && $proofA['expiresAt'] === (string) ($now + 120)
        && preg_match('/\A[a-f0-9]{64}\z/', $proofA['code']) === 1, 'Device-only proof and expiry');
    for ($i = 0; $i < 6; ++$i) {
        $check($finish($service, $proofA, $b)[0] === 401, 'Wrong bearer cannot prove or exhaust another challenge');
    }
    $check($finish($service, $proofA, $a, $wrong)[0] === 401, 'Wrong code cannot prove');
    $check($call($service, null, $a)[0] === 401, 'Begin alone does not register');
    $check($finish($service, $proofA, $a) === [200, ['registered' => true]], 'Matching bearer and code register');
    $service = $make('scope');
    $check($finish($service, $proofA, $a) === [200, ['registered' => true]], 'Lost finish reply survives restart');
    $check($call($service, null, $a) === [200, ['threads' => [], 'recruitments' => [], 'settings' => [
        'thread_refresh_sec' => 300, 'recruitment_filter' => 'loose'], 'enabled' => true]], 'Fresh device has no selections');
    $check($begin($service, 'fcm-A', $b)[0] === 200 && $finish($service, $challengeMessages['fcm-A'], $b)[0] === 401,
        'Even a newly proven token cannot overwrite a different bearer');
    $check($begin($service, 'fcm-B', $b)[0] === 200 && $finish($service, $challengeMessages['fcm-B'], $b)[0] === 200,
        'Second device enrolls independently');
    $service->tick();
    $check($fetches === ['subject.txt'], 'Candidate fetch shared across devices in one cycle');
    $check(count($call($service, null, $a)[1]['threads']) === 4, 'Candidates available after cron');
    $check($call($service, ['action' => 'delete', 'bearer' => $a], $b)[0] === 400, 'Actions do not accept a target bearer');
    $check($call($service, ['settings' => ['thread_refresh_sec' => 60, 'recruitment_filter' => 'regex']], $b)[0] === 200,
        'Device settings can change');
    $check($call($service, null, $a)[1]['settings'] === ['thread_refresh_sec' => 300, 'recruitment_filter' => 'loose'],
        'Device settings stay isolated');
    foreach (array_slice($ids, 0, 3) as $id) {
        $check($call($service, ['id' => $id, 'enabled' => true], $a)[0] === 200, 'A can select eligible threads');
    }
    $check($call($service, ['id' => $ids[3], 'enabled' => true], $a) === [409, ['error' => 'selection_limit']],
        'Device selection is capped');
    $check(!in_array(true, array_column($call($service, null, $b)[1]['threads'], 'enabled'), true), 'Selections are private');
    $check($call($service, ['id' => $ids[0], 'enabled' => true], $b)[0] === 200, 'B can select same thread');
    $fetches = [];
    $service->tick();
    $check(count(array_keys($fetches, "dat/$ids[0].dat", true)) === 1 && $notifications === [],
        'One DAT fetch per cycle and no notification during baseline');
    $check($call($service, ['action' => 'pause'], $a) === [200, ['enabled' => false]], 'Pause succeeds for A');
    $files["dat/$ids[0].dat"] .= $line('四南 12345') . "\n";
    $service->tick();
    $check(array_column($notifications, 0) === ['fcm-B'], 'Only active B is notified');
    $check($call($service, null, $a)[1]['enabled'] === false && $call($service, null, $a)[1]['recruitments'] === [],
        'B recruitment history is not visible to paused A');
    $check(count($call($service, null, $b)[1]['recruitments']) === 1, 'B keeps history after notification');
    $deviceLock = fopen("$root/state/device-1.lock", 'r+b');
    flock($deviceLock, LOCK_EX | LOCK_NB);
    $check($call($service, ['action' => 'resume'], $a) === [409, ['error' => 'busy']]
        && $call($service, null, $b)[0] === 200, 'Busy A does not lock out B');
    fclose($deviceLock);
    $deliveryFails = true;
    $files["dat/$ids[0].dat"] .= $line('四南 54321', 'another') . "\n";
    $check($service->tick()['status'] === 'degraded' && end($notifications)[0] === 'fcm-B', 'Only B queues a failed notification');
    $deliveryFails = false;
    $check($begin($service, 'fcm-B-new', $b)[0] === 200 && $finish($service, $challengeMessages['fcm-B-new'], $b)[0] === 200,
        'Same bearer can rotate to a newly proven destination');
    $check($finish($service, $challengeMessages['fcm-B'], $b)[0] === 401, 'Previously completed proof cannot roll back address');
    $check($call($service, null, $b)[1]['threads'][0]['enabled'] && count($call($service, null, $b)[1]['recruitments']) === 2,
        'Rotation retains B selections, cursor, and history');
    $attempt = end($notifications);
    $service->tick();
    $retried = end($notifications);
    $check($retried[0] === 'fcm-B-new' && array_slice($retried, 1) === array_slice($attempt, 1),
        'Pending delivery survives rotation, keeps its deadline and uses only the new destination');
    $now += 300;
    $check($begin($service, 'fcm-B-pending', $b, '192.0.2.2')[0] === 200, 'B can have an in-flight rotation');
    $check($call($service, ['action' => 'delete'], $b) === [200, ['deleted' => true]], 'Delete succeeds for B');
    $check($call($service, null, $b)[0] === 401 && $finish($service, $challengeMessages['fcm-B-pending'], $b)[0] === 401,
        'Deleted bearer and in-flight challenges cannot restore deleted monitor');
    $check(!file_exists("$root/state/device-2/state/monitor.sqlite"), 'Delete removes device history, positions and queue');
    $check($call($service, ['action' => 'resume'], $a) === [200, ['enabled' => true]], 'A can resume after B deleted');
    $check($call($service, null, $a)[1]['threads'][0]['enabled'], 'A keeps selections after B deletion');
    $check($begin($service, 'fcm-B-new', $c, '192.0.2.2')[0] === 200 && $finish($service, $challengeMessages['fcm-B-new'], $c)[0] === 200,
        'Released slot and token can enroll after fresh proof');
    $check($call($service, null, $c)[1]['threads'] === [] && $call($service, null, $c)[1]['recruitments'] === [],
        'Recycled slot has no prior device state');
    $dbFile = "$root/state/registry.sqlite";
    $check((fileperms($dbFile) & 0777) === 0600 && !str_contains(file_get_contents($dbFile), $a), 'Private registry stores bearer hashes only');
    $lock = fopen("$root/state/public-run.lock", 'r+b');
    flock($lock, LOCK_EX | LOCK_NB);
    $check($service->tick()['status'] === 'busy', 'Second cron worker does not run');
    fclose($lock);

    $rate = $make('rate');
    $proofLocks = [];
    for ($slot = 1; $slot <= 3; ++$slot) {
        $proofLock = fopen("$directory/rate/state/proof-send-$slot.lock", 'x+b');
        chmod("$directory/rate/state/proof-send-$slot.lock", 0600);
        flock($proofLock, LOCK_EX | LOCK_NB);
        $proofLocks[] = $proofLock;
    }
    $check($begin($rate, 'busy-key', $a) === [409, ['error' => 'busy']] && !isset($challengeMessages['busy-key']),
        'At most three concurrent enrollment sends are admitted');
    foreach ($proofLocks as $proofLock) {
        fclose($proofLock);
    }
    for ($i = 0; $i < 3; ++$i) {
        $check($begin($rate, 'same-token', hash('sha256', "bearer-$i"), "192.0.2.$i")[0] === 200, 'Destination allowance');
    }
    $check($begin($rate, 'same-token', $a, '192.0.2.10')[0] === 429, 'Destination bound is shared across IPs');
    for ($i = 0; $i < 6; ++$i) {
        $check($begin($rate, "ip-token-$i", hash('sha256', "ip-$i"), "2001:db8::" . ($i + 1))[0] === 200, 'IP allowance');
    }
    $check($begin($rate, 'ip-token-limit', $a, '2001:db8::f')[0] === 429, 'IPv6 limit includes the whole /64');
    for ($i = 0; $i < 3; ++$i) {
        $check($begin($rate, "bearer-token-$i", $a, "192.0.2." . ($i + 20))[0] === 200, 'Bearer allowance');
    }
    $check($begin($rate, 'bearer-token-limit', $a, '192.0.2.24')[0] === 429, 'Bearer bound covers new IPs and destinations');
    for ($i = 12; $i < 24; ++$i) {
        $check($begin($rate, "global-token-$i", hash('sha256', "global-$i"), "192.0.2." . ($i + 50))[0] === 200, 'Global allowance');
    }
    $check($begin($rate, 'global-token-limit', $b, '192.0.2.80')[0] === 429, 'Global limit covers rotating identities');
    $now += 120;
    $check($finish($rate, $challengeMessages['bearer-token-0'], $a)[0] === 401, 'Proof expires at expiry instant');
    $now += 180;
    $check($begin($rate, 'fresh-token', $a)[0] === 200, 'Rate window resets after 300 seconds');
    $locked = $challengeMessages['fresh-token'];
    for ($i = 0; $i < 5; ++$i) {
        $check($finish($rate, $locked, $a, $wrong)[0] === 401, 'Wrong code charged to a challenge');
    }
    $check($finish($rate, $locked, $a)[0] === 401, 'Challenge exhausted after five wrong attempts');
    $challengeFails = true;
    $check($begin($rate, 'provider-failure', $b) === [503, ['error' => 'unavailable']], 'Provider failures do not expose errors or secrets');
    $challengeFails = false;

    $capacity = $make('capacity');
    for ($i = 0; $i < 16; ++$i) {
        $bearer = hash('sha256', "slot-$i");
        $token = "slot-token-$i";
        $check($begin($capacity, $token, $bearer, "192.0.2." . ($i + 1))[0] === 200, 'Each device slot permits one enrollment');
        $check($finish($capacity, $challengeMessages[$token], $bearer)[0] === 200, 'A proven device is stored');
    }
    $check($begin($capacity, 'overflow', $a, '192.0.2.100') === [409, ['error' => 'capacity']], 'Full registry sends no new challenge');
    $bearer = hash('sha256', 'slot-0');
    $check($begin($capacity, 'slot-token-0-new', $bearer, '192.0.2.100')[0] === 200
        && $finish($capacity, $challengeMessages['slot-token-0-new'], $bearer)[0] === 200, 'Existing device can rotate at capacity');

    $unsafe = $make('unsafe');
    $outside = "$directory/do-not-touch";
    file_put_contents($outside, 'sentinel');
    chmod($outside, 0600);
    symlink($outside, "$directory/unsafe/state/registry.sqlite");
    $check($begin($unsafe, 'unsafe-key', $a) === [503, ['error' => 'unavailable']] && file_get_contents($outside) === 'sentinel'
        && !isset($challengeMessages['unsafe-key']), 'A symlink registry fails closed without using its target');
    echo "Public service: $checks assertions passed\n";
} finally {
    $remove($directory);
}
