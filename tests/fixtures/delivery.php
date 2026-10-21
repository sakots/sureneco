<?php

declare(strict_types=1);

require __DIR__ . '/../../server/bootstrap.php';
require __DIR__ . '/../../server/monitor.php';
require __DIR__ . '/../../server/delivery.php';
$db = Sureneco\openDatabase();
Sureneco\initializeDeliverySchema($db);
$input = json_decode(stream_get_contents(STDIN), true, 64, JSON_THROW_ON_ERROR);
foreach ($input['register'] ?? [] as $item) {
    $body = json_decode(json_encode($item['input']), false, 64, JSON_THROW_ON_ERROR);
    $response = Sureneco\subscriptionRequest($db, $item['uid'], 'PUT', '/v1/subscription', $body);
    if ($response['status'] !== 200) { throw new RuntimeException('Registration failed.'); }
}
foreach ($input['queue'] ?? [] as $item) {
    $statement = $db->prepare('SELECT * FROM subscriptions WHERE uid = ?');
    $statement->execute([$item['uid']]);
    $subscription = $statement->fetch();
    $statement->closeCursor();
    $number = $item['number'] ?? 1;
    $postedAt = $input['now'] * 1000;
    $thread = '1792548000';
    $recruitment = ['number' => $number, 'threadId' => $thread, 'name' => '名無し', 'id' => 'host', 'watchoi' => '', 'postedAt' => $postedAt, 'body' => '四南 12345', 'roomIds' => ['12345'], 'closed' => false];
    Sureneco\commitMonitoringResource($db, $subscription, 'https://egg.5ch.io/mj/', 'dat/' . $thread . '.dat', $input['now'], null, null,
        ['thread' => $thread, 'lastPost' => $number, 'emphasisSec' => $item['ttl'] ?? 3600, 'title' => '雀魂'],
        ['closedPrevious' => [], 'notifications' => [$recruitment]]);
}
if (isset($input['stop'])) { Sureneco\subscriptionRequest($db, $input['stop'], 'POST', '/v1/subscription/stop', null); }
if (isset($input['close'])) {
    $statement = $db->prepare('SELECT * FROM subscriptions WHERE uid = ?');
    $statement->execute([$input['close']]);
    $subscription = $statement->fetch();
    $statement->closeCursor();
    Sureneco\commitMonitoringResource($db, $subscription, 'https://egg.5ch.io/mj/', 'dat/1792548000.dat', $input['now'], null, null,
        ['thread' => '1792548000', 'lastPost' => 2, 'emphasisSec' => 3600, 'title' => '雀魂'],
        ['closedPrevious' => [1], 'notifications' => []]);
}
$calls = [];
$result = null;
if (isset($input['deliver'])) {
    $sender = function (string $token, array $payload, int $timeout) use (&$calls, $input, $db): void {
        $calls[] = ['token' => $token, 'eventId' => $payload['eventId'], 'revision' => $payload['revision'], 'timeout' => $timeout];
        if (isset($input['during'])) {
            Sureneco\subscriptionRequest($db, $input['during']['uid'], 'PUT', '/v1/subscription', json_decode(json_encode($input['during']['input']), false));
        }
        $action = $input['deliver'][$token] ?? 'success';
        if ($action === 'crash') { exit(77); }
        if ($action !== 'success') {
            throw new Sureneco\FcmDeliveryException($action, $action !== 'invalid_argument', $input['retryAfter'] ?? 0);
        }
    };
    $result = Sureneco\runDeliveryBatch($db, $sender, $input['now'], $input['budgetMs'] ?? 15000);
}
$output = ['calls' => $calls, 'result' => $result];
foreach (['notification_outbox', 'notification_events', 'subscriptions', 'notification_delivery_state'] as $table) {
    $output[$table] = $db->query('SELECT * FROM ' . $table)->fetchAll();
}
echo json_encode($output, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
