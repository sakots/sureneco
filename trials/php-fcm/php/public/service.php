<?php

declare(strict_types=1);

use Sureneco\FcmTrial\PublicEndpoint;
use Sureneco\FcmTrial\PublicService;

// Deploy only this file to the document root; code, state and Firebase files are private.
ini_set('display_errors', '0');
ini_set('log_errors', '0');
umask(0077);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if (!in_array($_SERVER['HTTPS'] ?? null, ['on', '1'], true)) {
    http_response_code(403);
    echo '{"error":"https_required"}';
    exit;
}

try {
    $root = getenv('SURENECO_PHP_PUBLIC_ROOT');
    if ($root === false || $root === '') {
        $home = getenv('HOME');
        $root = $home === false || $home === '' ? '' : rtrim($home, '/') . '/.sureneco-php-public';
    }
    if (!str_starts_with($root, '/') || str_contains($root, "\0") || realpath($root) !== $root) {
        throw new RuntimeException();
    }
    $documentRoot = empty($_SERVER['DOCUMENT_ROOT']) ? false : realpath($_SERVER['DOCUMENT_ROOT']);
    if ($documentRoot === false || $root === $documentRoot || str_starts_with($root, rtrim($documentRoot, '/') . '/')) {
        throw new RuntimeException();
    }
    require $root . '/php/vendor/autoload.php';
    $method = $_SERVER['REQUEST_METHOD'] ?? '';
    $body = $method === 'POST' ? file_get_contents('php://input', false, null, 0, PublicEndpoint::MAX_BODY_BYTES + 1) : '';
    if ($body === false) {
        throw new RuntimeException();
    }
    [$status, $payload] = PublicEndpoint::dispatch(new PublicService($root), $method,
        $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null,
        $_SERVER['CONTENT_TYPE'] ?? null, $body, $_SERVER['REMOTE_ADDR'] ?? '');
    $json = json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    if ($status === 401) {
        header('WWW-Authenticate: Bearer');
    } elseif ($status === 405) {
        header('Allow: GET, POST');
    } elseif ($status === 429) {
        header('Retry-After: 300');
    } elseif (($payload['error'] ?? null) === 'busy') {
        header('Retry-After: 1');
    }
    http_response_code($status);
    echo $json;
} catch (Throwable) {
    http_response_code(503);
    echo '{"error":"unavailable"}';
}
