<?php

declare(strict_types=1);

use Sureneco\FcmTrial\PersistentMonitor;
use Sureneco\FcmTrial\SelectionEndpoint;

// Copy only this file to the document root. Keep the deployment and secrets private.
ini_set('display_errors', '0');
ini_set('log_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

// Use only the HTTPS indicator set by the web server, not forwarded request headers.
if (!in_array($_SERVER['HTTPS'] ?? null, ['on', '1'], true)) {
    http_response_code(403);
    echo '{"error":"https_required"}';
    exit;
}

try {
    $root = getenv('SURENECO_PHP_ROOT');
    if ($root === false || $root === '') {
        $home = getenv('HOME');
        $root = $home === false || $home === '' ? '' : rtrim($home, '/') . '/.sureneco-php';
    }
    if (!str_starts_with($root, '/') || str_contains($root, "\0")) {
        throw new RuntimeException();
    }
    $private = realpath($root);
    $documentRoot = empty($_SERVER['DOCUMENT_ROOT']) ? false : realpath($_SERVER['DOCUMENT_ROOT']);
    if ($private === false || $documentRoot === false || $private === $documentRoot
        || str_starts_with($private, rtrim($documentRoot, '/') . '/')) {
        throw new RuntimeException();
    }
    require $root . '/php/vendor/autoload.php';
    $monitor = new PersistentMonitor($root);
    $method = $_SERVER['REQUEST_METHOD'] ?? '';
    $body = $method === 'POST' ? file_get_contents('php://input', false, null, 0, SelectionEndpoint::MAX_BODY_BYTES + 1) : '';
    if ($body === false) {
        throw new RuntimeException();
    }
    [$status, $payload] = SelectionEndpoint::dispatch($monitor, $method,
        $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null,
        $_SERVER['CONTENT_TYPE'] ?? null, $body);
    $json = json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    if ($status === 401) {
        header('WWW-Authenticate: Bearer');
    } elseif ($status === 405) {
        header('Allow: GET, POST');
    }
    http_response_code($status);
    echo $json;
} catch (Throwable) {
    http_response_code(503);
    echo '{"error":"unavailable"}';
}
