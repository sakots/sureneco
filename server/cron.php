<?php

declare(strict_types=1);

namespace Sureneco;

use RuntimeException;
use Throwable;

ini_set('display_errors', '0');
ini_set('log_errors', '0');

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

$database = null;
$lock = null;
$result = null;
$exitCode = 0;

try {
    require __DIR__ . '/bootstrap.php';
    $database = openDatabase();
    $lockPath = workerLockPath($database);
    $mask = umask(0077);
    try {
        $lock = @fopen($lockPath, 'c');
    } finally {
        umask($mask);
    }
    if ($lock === false) {
        throw new RuntimeException('Worker lock is unavailable.');
    }

    $wouldBlock = 0;
    if (!@flock($lock, LOCK_EX | LOCK_NB, $wouldBlock)) {
        if ($wouldBlock !== 1) {
            throw new RuntimeException('Worker lock failed.');
        }
        $result = ['status' => 'skipped', 'monitoringReady' => false];
    } else {
        $startedAt = (int) floor(microtime(true) * 1000);
        $statement = $database->prepare('UPDATE worker_state SET last_started_at = ? WHERE id = 1');
        $statement->execute([$startedAt]);
        $statement = null;

        // This foundation records execution only; fetching and delivery are not implemented.
        $finishedAt = (int) floor(microtime(true) * 1000);
        $statement = $database->prepare('UPDATE worker_state SET last_finished_at = ? WHERE id = 1');
        $statement->execute([$finishedAt]);
        $statement = null;
        $result = ['status' => 'completed', 'monitoringReady' => false];
    }
} catch (Throwable) {
    fwrite(STDERR, "Worker execution failed.\n");
    $exitCode = 1;
} finally {
    $statement = null;
    $database = null;
    // Closing releases flock; the fixed file remains for subsequent and concurrent runs.
    if (is_resource($lock) && !@fclose($lock)) {
        if ($exitCode === 0) {
            fwrite(STDERR, "Worker execution failed.\n");
        }
        $exitCode = 1;
    }
}

if ($exitCode === 0) {
    if (fwrite(STDOUT, json_encode($result, JSON_THROW_ON_ERROR) . "\n") === false) {
        fwrite(STDERR, "Worker execution failed.\n");
        $exitCode = 1;
    }
}
exit($exitCode);
