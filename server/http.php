<?php

declare(strict_types=1);

namespace Sureneco;

use CurlHandle;
use RuntimeException;
use Throwable;

const BOARD_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const BOARD_FETCH_TIMEOUT_MS = 15000;

final class BoardFetchException extends RuntimeException
{
    public function __construct(public readonly string $errorCode)
    {
        parent::__construct('Board data unavailable.');
    }
}

/** @internal Validate the original path, before a URL client can normalize traversal. */
function validateBoardDataUrl(string $url): void
{
    if (preg_match('~[\x00-\x20\x7f\\\\]~', $url) === 1) {
        throw new BoardFetchException('invalid_url');
    }
    $parts = parse_url($url);
    if ($parts === false
        || strtolower($parts['scheme'] ?? '') !== 'https'
        || preg_match('~\A(?:[a-z0-9_-]+\.)*5ch\.(?:io|net)\z~iD', $parts['host'] ?? '') !== 1
        || (isset($parts['port']) && $parts['port'] !== 443)
        || array_key_exists('user', $parts)
        || array_key_exists('pass', $parts)
        || array_key_exists('query', $parts)
        || array_key_exists('fragment', $parts)
        || preg_match('~\A/[A-Za-z0-9_]+/(?:subject\.txt|dat/[0-9]{9,11}\.dat)\z~D', $parts['path'] ?? '') !== 1) {
        throw new BoardFetchException('invalid_url');
    }
}

/**
 * @internal Consume an already configured cURL handle; never supplies a production URL override.
 * The write callback counts actual body bytes, including responses without Content-Length.
 */
function consumeBoardResponse(CurlHandle $handle): string
{
    $body = '';
    $tooLarge = false;
    if (!curl_setopt_array($handle, [
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_HEADER => false,
        CURLOPT_WRITEFUNCTION => static function (CurlHandle $handle, string $chunk) use (&$body, &$tooLarge): int {
            $length = strlen($chunk);
            if ($length > BOARD_MAX_RESPONSE_BYTES - strlen($body)) {
                $tooLarge = true;
                return 0;
            }
            $body .= $chunk;
            return $length;
        },
    ])) {
        throw new BoardFetchException('fetch_failed');
    }
    $result = @curl_exec($handle);
    if ($tooLarge) {
        throw new BoardFetchException('response_too_large');
    }
    if ($result === false) {
        throw new BoardFetchException(curl_errno($handle) === CURLE_OPERATION_TIMEDOUT ? 'fetch_timeout' : 'fetch_failed');
    }
    $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    if ($status < 200 || $status >= 300) {
        throw new BoardFetchException('http_error');
    }
    if (!function_exists('mb_convert_encoding')) {
        throw new BoardFetchException('decoding_failed');
    }
    $contentType = strtolower((string) curl_getinfo($handle, CURLINFO_CONTENT_TYPE));
    $encoding = str_contains($contentType, 'utf-8') || str_contains($contentType, 'utf8') ? 'UTF-8' : 'CP932';
    // Match encoding_rs::decode: a Unicode BOM overrides even the legacy fallback.
    foreach (["\xef\xbb\xbf" => 'UTF-8', "\xff\xfe" => 'UTF-16LE', "\xfe\xff" => 'UTF-16BE'] as $bom => $bomEncoding) {
        if (str_starts_with($body, $bom)) {
            $encoding = $bomEncoding;
            $body = substr($body, strlen($bom));
            break;
        }
    }
    // encoding_rs replaces malformed input instead of dropping bytes or emitting invalid JSON.
    $substitute = mb_substitute_character();
    try {
        mb_substitute_character(0xfffd);
        return mb_convert_encoding($body, 'UTF-8', $encoding);
    } finally {
        mb_substitute_character($substitute);
    }
}

/** Fetch only a 5ch subject/dat resource; a caller may reduce, never extend, the batch budget. */
function fetchBoardData(string $url, int $timeoutMs = BOARD_FETCH_TIMEOUT_MS): string
{
    validateBoardDataUrl($url);
    if ($timeoutMs <= 0) {
        throw new BoardFetchException('fetch_timeout');
    }
    $timeoutMs = min($timeoutMs, BOARD_FETCH_TIMEOUT_MS);
    $deadline = hrtime(true) + $timeoutMs * 1000000;
    if (!function_exists('curl_init')) {
        throw new BoardFetchException('fetch_failed');
    }
    $handle = null;
    try {
        $handle = curl_init($url);
        if ($handle === false) {
            throw new BoardFetchException('fetch_failed');
        }
        $remainingMs = (int) (($deadline - hrtime(true)) / 1000000);
        if ($remainingMs <= 0) {
            throw new BoardFetchException('fetch_timeout');
        }
        if (!curl_setopt_array($handle, [
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_MAXREDIRS => 0,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_TIMEOUT_MS => $remainingMs,
            CURLOPT_CONNECTTIMEOUT_MS => $remainingMs,
            CURLOPT_NOSIGNAL => true,
            CURLOPT_USERAGENT => 'sureneco/server',
            CURLOPT_HTTPHEADER => ['Accept: text/plain'],
        ])) {
            throw new BoardFetchException('fetch_failed');
        }
        $result = consumeBoardResponse($handle);
        if (hrtime(true) >= $deadline) {
            throw new BoardFetchException('fetch_timeout');
        }
        return $result;
    } catch (BoardFetchException $error) {
        throw $error;
    } catch (Throwable) {
        throw new BoardFetchException('fetch_failed');
    } finally {
        // PHP 8 releases cURL resources with the handle; curl_close is a deprecated no-op.
        unset($handle);
    }
}
