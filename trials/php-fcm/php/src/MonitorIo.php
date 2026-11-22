<?php

declare(strict_types=1);

namespace Sureneco\FcmTrial;

final class MonitorIo
{
    private const BOARD_MAX_BYTES = 5 * 1024 * 1024;
    private const INPUT_MAX_BYTES = 16 * 1024 * 1024;
    private const OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
    private const STDERR_MAX_BYTES = 64 * 1024;

    public static function fetch(string $resource): string
    {
        if (preg_match('~\A(?:subject\.txt|dat/[0-9]{9,11}\.dat)\z~', $resource) !== 1) {
            throw new SafeFailure('invalid_resource');
        }
        if (!function_exists('curl_init')) {
            throw new SafeFailure('fetch_failed');
        }

        $body = '';
        $tooLarge = false;
        try {
            $handle = @curl_init('https://egg.5ch.io/mj/' . $resource);
            $protocol = defined('CURLOPT_PROTOCOLS_STR')
                ? [CURLOPT_PROTOCOLS_STR => 'https']
                : [CURLOPT_PROTOCOLS => CURLPROTO_HTTPS];
            if ($handle === false || !@curl_setopt_array($handle, $protocol + [
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_TIMEOUT_MS => 15000,
                CURLOPT_CONNECTTIMEOUT_MS => 15000,
                CURLOPT_NOSIGNAL => true,
                CURLOPT_USERAGENT => 'sureneco/php-monitor',
                CURLOPT_HTTPHEADER => ['Accept: text/plain', 'Accept-Encoding: identity'],
                CURLOPT_HTTP_CONTENT_DECODING => false,
                CURLOPT_MAXFILESIZE => self::BOARD_MAX_BYTES,
                CURLOPT_WRITEFUNCTION => static function (\CurlHandle $handle, string $chunk) use (&$body, &$tooLarge): int {
                    $length = strlen($chunk);
                    if ($length > self::BOARD_MAX_BYTES - strlen($body)) {
                        $tooLarge = true;
                        return 0;
                    }
                    $body .= $chunk;
                    return $length;
                },
            ])) {
                throw new SafeFailure('fetch_failed');
            }
            $result = @curl_exec($handle);
            $errno = curl_errno($handle);
            if ($tooLarge || $errno === CURLE_FILESIZE_EXCEEDED) {
                throw new SafeFailure('response_too_large');
            }
            if ($result === false) {
                throw new SafeFailure($errno === CURLE_OPERATION_TIMEDOUT ? 'fetch_timeout' : 'fetch_failed');
            }
            if (curl_getinfo($handle, CURLINFO_RESPONSE_CODE) !== 200) {
                throw new SafeFailure('http_error');
            }
            $contentType = strtolower((string) curl_getinfo($handle, CURLINFO_CONTENT_TYPE));
        } catch (SafeFailure $failure) {
            throw $failure;
        } catch (\Throwable) {
            throw new SafeFailure('fetch_failed');
        }

        try {
            $encoding = str_contains($contentType, 'utf-8') || str_contains($contentType, 'utf8') ? 'UTF-8' : 'CP932';
            foreach (["\xef\xbb\xbf" => 'UTF-8', "\xff\xfe" => 'UTF-16LE', "\xfe\xff" => 'UTF-16BE'] as $bom => $bomEncoding) {
                if (str_starts_with($body, $bom)) {
                    $encoding = $bomEncoding;
                    $body = substr($body, strlen($bom));
                    break;
                }
            }
            $substitute = mb_substitute_character();
            try {
                mb_substitute_character(0xfffd);
                return mb_convert_encoding($body, 'UTF-8', $encoding);
            } finally {
                mb_substitute_character($substitute);
            }
        } catch (\Throwable) {
            throw new SafeFailure('decoding_failed');
        }
    }

    public static function detect(array $request): array
    {
        $deadline = hrtime(true) + 2_000_000_000;
        try {
            $input = json_encode($request, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        } catch (\Throwable) {
            throw new SafeFailure('invalid_request');
        }
        $inputLength = strlen($input);
        if ($inputLength > self::INPUT_MAX_BYTES) {
            throw new SafeFailure('invalid_request');
        }

        $process = null;
        $running = false;
        $files = [];
        try {
            $windows = PHP_OS_FAMILY === 'Windows';
            $configured = getenv('SURENECO_PHP_WORKER_BIN');
            $binary = $configured === false
                ? dirname(__DIR__, 2) . '/worker/target/release/sureneco-php-worker' . ($windows ? '.exe' : '')
                : $configured;
            $absolute = $windows
                ? str_starts_with($binary, '\\\\') || preg_match('~\A[A-Za-z]:/~', str_replace('\\', '/', $binary)) === 1
                : str_starts_with($binary, '/');
            if (!$absolute || str_contains($binary, "\0") || !@is_file($binary) || !@is_executable($binary)
                || !function_exists('proc_open')) {
                throw new SafeFailure('execution_failed');
            }

            // Files avoid pipe backpressure and Windows stream_select limits.
            for ($index = 0; $index < 3; ++$index) {
                $file = @tmpfile();
                if ($file === false) {
                    throw new SafeFailure('execution_failed');
                }
                $files[$index] = $file;
            }
            for ($written = 0; $written < $inputLength; $written += $count) {
                self::checkDeadline($deadline);
                $count = @fwrite($files[0], substr($input, $written, 65536));
                if ($count === false || $count === 0) {
                    throw new SafeFailure('execution_failed');
                }
            }
            unset($input);
            if (!@rewind($files[0])) {
                throw new SafeFailure('execution_failed');
            }
            self::checkDeadline($deadline);
            $pipes = [];
            $process = @proc_open([$binary], $files, $pipes, __DIR__, null, ['bypass_shell' => true]);
            if (!is_resource($process)) {
                throw new SafeFailure('execution_failed');
            }
            $running = true;
            do {
                self::checkDeadline($deadline);
                $status = @proc_get_status($process);
                if ($status === false) {
                    throw new SafeFailure('execution_failed');
                }
                $running = $status['running'];
                foreach ([1 => self::OUTPUT_MAX_BYTES, 2 => self::STDERR_MAX_BYTES] as $index => $maximum) {
                    $stat = @fstat($files[$index]);
                    if ($stat === false) {
                        throw new SafeFailure('execution_failed');
                    }
                    if ($stat['size'] > $maximum) {
                        throw new SafeFailure('execution_limit');
                    }
                }
                if ($running) {
                    usleep(1000);
                }
            } while ($running);

            if ($status['exitcode'] !== 0 || !@rewind($files[1])) {
                throw new SafeFailure('execution_failed');
            }
            $output = @stream_get_contents($files[1], self::OUTPUT_MAX_BYTES + 1);
            if ($output === false) {
                throw new SafeFailure('execution_failed');
            }
            if (strlen($output) > self::OUTPUT_MAX_BYTES) {
                throw new SafeFailure('execution_limit');
            }
            self::checkDeadline($deadline);
            $envelope = json_decode($output, true, 64, JSON_THROW_ON_ERROR);
            self::checkDeadline($deadline);
            if (!is_array($envelope) || count($envelope) !== 2 || !is_bool($envelope['ok'] ?? null)) {
                throw new SafeFailure('execution_failed');
            }
            if ($envelope['ok'] && is_array($envelope['result'] ?? null)) {
                return $envelope['result'];
            }
            if (!$envelope['ok'] && in_array($envelope['error'] ?? null, [
                'invalid_request', 'invalid_dat', 'invalid_subject', 'execution_limit', 'execution_failed',
            ], true)) {
                throw new SafeFailure($envelope['error']);
            }
            throw new SafeFailure('execution_failed');
        } catch (SafeFailure $failure) {
            throw $failure;
        } catch (\Throwable) {
            throw new SafeFailure('execution_failed');
        } finally {
            if (is_resource($process)) {
                if ($running) {
                    @proc_terminate($process, 9);
                }
                @proc_close($process);
            }
            foreach ($files as $file) {
                @fclose($file);
            }
        }
    }

    private static function checkDeadline(int|float $deadline): void
    {
        if (hrtime(true) >= $deadline) {
            throw new SafeFailure('execution_limit');
        }
    }
}
