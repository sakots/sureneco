<?php

declare(strict_types=1);

use Sureneco\FcmTrial\PublicService;

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit(1);
}

ini_set('display_errors', '0');
ini_set('log_errors', '0');
umask(0077);

try {
    if ($argc !== 3 || $argv[1] !== 'tick') {
        echo "Usage: php public-service.php tick /absolute/private/root\n";
        exit(1);
    }
    require dirname(__DIR__) . '/vendor/autoload.php';
    $result = (new PublicService($argv[2]))->tick();
    echo json_encode($result, JSON_THROW_ON_ERROR) . PHP_EOL;
    exit($result['status'] === 'degraded' ? 1 : 0);
} catch (Throwable) {
    echo '{"status":"error","error":"unavailable"}' . PHP_EOL;
    exit(1);
}
