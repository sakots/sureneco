<?php

declare(strict_types=1);

namespace Sureneco;

use Throwable;

ini_set('display_errors', '0');
ini_set('log_errors', '0');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
if ($path !== '/healthz') {
    http_response_code(404);
    echo '{"error":"Not found."}';
    return;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    http_response_code(405);
    header('Allow: GET');
    echo '{"error":"Method not allowed."}';
    return;
}

$database = null;
try {
    require dirname(__DIR__) . '/bootstrap.php';
    $database = openDatabase();
    echo json_encode(workerStatus($database), JSON_THROW_ON_ERROR);
} catch (Throwable) {
    http_response_code(500);
    echo '{"error":"Service unavailable."}';
} finally {
    $database = null;
}
