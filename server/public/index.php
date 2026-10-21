<?php

declare(strict_types=1);

namespace Sureneco;

use Throwable;

ini_set('display_errors', '0');
ini_set('log_errors', '0');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'] ?? '';
$subscriptionRoute = $path === '/v1/subscription' || $path === '/v1/subscription/stop';
if ($path !== '/healthz' && !$subscriptionRoute) {
    http_response_code(404);
    echo '{"error":"Not found."}';
    return;
}
$allowed = $path === '/healthz' ? ['GET'] : ($path === '/v1/subscription/stop' ? ['POST'] : ['GET', 'PUT', 'DELETE']);
if (!in_array($method, $allowed, true)) {
    http_response_code(405);
    header('Allow: ' . implode(', ', $allowed));
    echo '{"error":"Method not allowed."}';
    return;
}

$database = null;
try {
    require dirname(__DIR__) . '/bootstrap.php';
    if (!$subscriptionRoute) {
        $database = openDatabase();
        echo json_encode(workerStatus($database), JSON_THROW_ON_ERROR);
        return;
    }
    require dirname(__DIR__) . '/auth.php';
    require dirname(__DIR__) . '/subscriptions.php';
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > SUBSCRIPTION_MAX_BODY_BYTES) {
        http_response_code(413);
        echo '{"error":"payload_too_large"}';
        return;
    }
    $raw = file_get_contents('php://input', false, null, 0, SUBSCRIPTION_MAX_BODY_BYTES + 1);
    if ($raw === false) {
        throw new \RuntimeException('Request body unavailable.');
    }
    if (strlen($raw) > SUBSCRIPTION_MAX_BODY_BYTES) {
        http_response_code(413);
        echo '{"error":"payload_too_large"}';
        return;
    }
    $database = openDatabase();
    initializeSubscriptionSchema($database);
    if (!rateLimitSubscriptionRequest($database, 'ip', $_SERVER['REMOTE_ADDR'] ?? 'unknown', 120)) {
        http_response_code(429);
        echo '{"error":"rate_limited"}';
        return;
    }
    $identity = authenticateFirebaseRequest($_SERVER);
    $input = null;
    if ($raw !== '') {
        try {
            $input = json_decode($raw, false, 32, JSON_THROW_ON_ERROR);
            if (!str_starts_with(ltrim($raw), '{')) {
                throw new \JsonException('Object required.');
            }
        } catch (\JsonException) {
            http_response_code(400);
            echo '{"error":"invalid_json"}';
            return;
        }
    }
    $result = subscriptionRequest($database, $identity['uid'], $method, $path, $input);
    http_response_code($result['status']);
    echo json_encode($result['body'], JSON_THROW_ON_ERROR);
} catch (FirebaseAuthException $error) {
    http_response_code($error->status);
    echo json_encode(['error' => $error->errorCode], JSON_THROW_ON_ERROR);
} catch (Throwable) {
    http_response_code(500);
    echo '{"error":"Service unavailable."}';
} finally {
    $database = null;
}
