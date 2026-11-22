<?php

declare(strict_types=1);

use Sureneco\FcmTrial\RecruitmentMonitor;
use Sureneco\FcmTrial\SafeFailure;

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit(1);
}

require dirname(__DIR__) . '/src/SafeFailure.php';
require dirname(__DIR__) . '/src/MonitorIo.php';
require dirname(__DIR__) . '/src/RecruitmentMonitor.php';

$operation = null;
try {
    if ($argc === 2 && $argv[1] === '--help') {
        echo "php monitor.php list\nphp monitor.php scan THREAD_ID /absolute/private/monitor.sqlite [regex|loose]\n";
        exit(0);
    }
    $monitor = new RecruitmentMonitor();
    if ($argc === 2 && $argv[1] === 'list') {
        $operation = 'list';
        $result = $monitor->listThreads();
    } elseif (($argc === 4 || $argc === 5) && $argv[1] === 'scan') {
        $operation = 'scan';
        $result = $monitor->scan($argv[2], $argv[3], $argv[4] ?? 'regex');
    } else {
        throw new SafeFailure('invalid_arguments');
    }
    echo json_encode(['ok' => true, 'operation' => $operation] + $result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) . PHP_EOL;
} catch (SafeFailure $error) {
    echo json_encode($error->result($operation), JSON_THROW_ON_ERROR) . PHP_EOL;
    exit(1);
} catch (Throwable) {
    echo json_encode(['ok' => false, 'operation' => $operation, 'status' => 'error', 'error' => 'runtime_failure']) . PHP_EOL;
    exit(1);
}
