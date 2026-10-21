<?php

declare(strict_types=1);

namespace Sureneco;

use JsonException;
use RuntimeException;
use Throwable;

const DETECTION_MAX_REQUEST_BYTES = 16777216;
const DETECTION_MAX_RESPONSE_BYTES = 4194304;
const DETECTION_MAX_STDERR_BYTES = 65536;

final class DetectionWorkerException extends RuntimeException
{
    public function __construct(public readonly string $errorCode)
    {
        parent::__construct('Detection unavailable.');
    }
}

/** Run only the dedicated executable; requests are data, never source or shell arguments. */
function runDetectionWorker(array $request): mixed
{
    $deadline = hrtime(true) + 1000000000;
    try {
        $input = json_encode($request, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    } catch (JsonException) {
        throw new DetectionWorkerException('invalid_request');
    }
    $inputLength = strlen($input);
    if ($inputLength > DETECTION_MAX_REQUEST_BYTES) {
        throw new DetectionWorkerException('invalid_request');
    }
    $configured = getenv('SURENECO_WORKER_BIN');
    $binary = $configured === false ? __DIR__ . '/worker/target/release/sureneco-worker' . (PHP_OS_FAMILY === 'Windows' ? '.exe' : '') : $configured;
    $absolute = str_starts_with($binary, '/') || str_starts_with($binary, '\\\\')
        || preg_match('~\A[A-Za-z]:/~D', str_replace('\\', '/', $binary)) === 1;
    if (!$absolute || str_contains($binary, "\0")
        || !is_file($binary) || !is_executable($binary) || !function_exists('proc_open')) {
        throw new DetectionWorkerException('execution_failed');
    }

    $process = null;
    $files = [];
    $output = '';
    $exitCode = null;
    try {
        // File-backed descriptors avoid pipe backpressure and Windows stream_select limits.
        for ($index = 0; $index < 3; ++$index) {
            $file = @tmpfile();
            if ($file === false) {
                throw new DetectionWorkerException('execution_failed');
            }
            $files[$index] = $file;
        }
        $written = 0;
        while ($written < $inputLength) {
            if (hrtime(true) >= $deadline) {
                throw new DetectionWorkerException('execution_limit');
            }
            $count = @fwrite($files[0], substr($input, $written, 65536));
            if ($count === false || $count === 0) {
                throw new DetectionWorkerException('execution_failed');
            }
            $written += $count;
        }
        unset($input);
        if (!rewind($files[0])) {
            throw new DetectionWorkerException('execution_failed');
        }
        if (hrtime(true) >= $deadline) {
            throw new DetectionWorkerException('execution_limit');
        }
        $pipes = [];
        $process = @proc_open([$binary], $files, $pipes, __DIR__, null, ['bypass_shell' => true]);
        if (!is_resource($process)) {
            throw new DetectionWorkerException('execution_failed');
        }
        while (true) {
            $remaining = $deadline - hrtime(true);
            if ($remaining <= 0) {
                throw new DetectionWorkerException('execution_limit');
            }
            $status = proc_get_status($process);
            if ($status === false) {
                throw new DetectionWorkerException('execution_failed');
            }
            foreach ([1 => DETECTION_MAX_RESPONSE_BYTES, 2 => DETECTION_MAX_STDERR_BYTES] as $index => $maximum) {
                $stat = fstat($files[$index]);
                if ($stat === false) {
                    throw new DetectionWorkerException('execution_failed');
                }
                if ($stat['size'] > $maximum) {
                    throw new DetectionWorkerException('execution_limit');
                }
            }
            if (!$status['running']) {
                $exitCode = $status['exitcode'];
                break;
            }
            usleep((int) min(1000, max(1, intdiv($remaining, 1000))));
        }
        if ($exitCode !== 0 || !rewind($files[1])) {
            throw new DetectionWorkerException('execution_failed');
        }
        $output = stream_get_contents($files[1], DETECTION_MAX_RESPONSE_BYTES + 1);
        if ($output === false) {
            throw new DetectionWorkerException('execution_failed');
        }
        if (strlen($output) > DETECTION_MAX_RESPONSE_BYTES || hrtime(true) >= $deadline) {
            throw new DetectionWorkerException('execution_limit');
        }
    } catch (DetectionWorkerException $error) {
        throw $error;
    } catch (Throwable) {
        throw new DetectionWorkerException('execution_failed');
    } finally {
        // Reap before closing descriptors; tmpfile removes all request/response data on close.
        if (is_resource($process)) {
            $status = proc_get_status($process);
            if ($status !== false && $status['running']) {
                proc_terminate($process, 9);
            } elseif ($exitCode === null && $status !== false && $status['exitcode'] >= 0) {
                $exitCode = $status['exitcode'];
            }
            $closedExitCode = proc_close($process);
            if ($exitCode === null) {
                $exitCode = $closedExitCode;
            }
        }
        foreach ($files as $file) {
            fclose($file);
        }
    }
    if ($exitCode !== 0) {
        throw new DetectionWorkerException('execution_failed');
    }
    try {
        $envelope = json_decode($output, true, 64, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        throw new DetectionWorkerException('execution_failed');
    }
    if (!str_starts_with(ltrim($output), '{') || !is_array($envelope) || !is_bool($envelope['ok'] ?? null)) {
        throw new DetectionWorkerException('execution_failed');
    }
    if ($envelope['ok']) {
        if (count($envelope) !== 2 || !array_key_exists('result', $envelope)
            || (($request['operation'] ?? null) === 'validate' && $envelope['result'] !== null)) {
            throw new DetectionWorkerException('execution_failed');
        }
        return $envelope['result'];
    }
    if (count($envelope) !== 2 || !is_string($envelope['error'] ?? null)
        || !in_array($envelope['error'], ['invalid_pattern', 'invalid_request', 'execution_limit', 'execution_failed'], true)) {
        throw new DetectionWorkerException('execution_failed');
    }
    throw new DetectionWorkerException($envelope['error']);
}
