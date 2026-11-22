<?php

declare(strict_types=1);

use Sureneco\FcmTrial\PersistentMonitor;
use Sureneco\FcmTrial\SafeFailure;

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit(1);
}

// Neither PHP warnings nor exception messages may expose credentials or paths.
ini_set('display_errors', '0');
ini_set('log_errors', '0');

$operation = null;
try {
    if ($argc === 2 && $argv[1] === '--help') {
        echo "php service.php tick|status|pause|resume ROOT\n"
            . "ROOT is the explicitly supplied private deployment directory.\n"
            . "Exit 0: successful control operation, healthy or paused; exit 1: invalid arguments, degraded, stale or error health.\n";
        exit(0);
    }
    if ($argc !== 3 || !in_array($argv[1], ['tick', 'status', 'pause', 'resume'], true)
        || $argv[2] === '' || str_contains($argv[2], "\0")) {
        $result = ['status' => 'error', 'error' => 'invalid_arguments'];
    } else {
        $operation = $argv[1];
        $autoload = dirname(__DIR__) . '/vendor/autoload.php';
        if (!is_file($autoload)) {
            $result = ['status' => 'error', 'error' => 'dependencies_missing'];
        } else {
            require $autoload;
            $monitor = new PersistentMonitor($argv[2]);
            $result = match ($operation) {
                'tick' => $monitor->tick(),
                'status' => $monitor->status(),
                'pause' => $monitor->setEnabled(false),
                'resume' => $monitor->setEnabled(true),
            };
        }
    }
    $ok = (in_array($operation, ['pause', 'resume'], true)
            && ($result['enabled'] ?? null) === ($operation === 'resume'))
        || (($result['ok'] ?? true) !== false
            && !in_array($result['status'] ?? 'error', ['degraded', 'error', 'stale'], true));
    echo json_encode(['ok' => $ok, 'operation' => $operation] + $result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) . PHP_EOL;
    exit($ok ? 0 : 1);
} catch (SafeFailure $error) {
    $reason = preg_match('/\A[a-z][a-z0-9_]{0,63}\z/D', $error->reason) === 1
        ? $error->reason : 'runtime_failure';
    echo json_encode(['ok' => false, 'operation' => $operation, 'status' => 'error', 'error' => $reason], JSON_THROW_ON_ERROR) . PHP_EOL;
    exit(1);
} catch (Throwable) {
    echo json_encode(['ok' => false, 'operation' => $operation, 'status' => 'error', 'error' => 'runtime_failure']) . PHP_EOL;
    exit(1);
}
