<?php

declare(strict_types=1);

namespace Sureneco\FcmTrial;

final class SelectionEndpoint
{
    public const MAX_BODY_BYTES = 8192;
    private const MAX_EXCHANGE_BODY_BYTES = 1024;

    /** @return array{int, array} HTTP status and JSON document */
    public static function dispatch(
        PersistentMonitor $monitor,
        string $method,
        #[\SensitiveParameter] ?string $authorization,
        ?string $contentType,
        #[\SensitiveParameter] string $body,
    ): array {
        if ($method !== 'GET' && $method !== 'POST') {
            return [405, ['error' => 'method_not_allowed']];
        }
        $isJson = $contentType !== null && strtolower(trim(explode(';', $contentType, 2)[0])) === 'application/json';
        if ($method === 'POST' && $authorization === null && $isJson && $body !== '') {
            return self::exchange($monitor, $body);
        }
        if ($authorization === null || preg_match('/\A(?i:Bearer) ([a-f0-9]{64})\z/', $authorization, $match) !== 1) {
            return [401, ['error' => 'unauthorized']];
        }
        $id = $enabled = $settings = null;
        if ($method === 'POST') {
            if (!$isJson) {
                return [415, ['error' => 'unsupported_media_type']];
            }
            $change = strlen($body) <= self::MAX_BODY_BYTES ? json_decode($body, true, 4) : null;
            if (is_array($change) && count($change) === 1 && is_array($change['settings'] ?? null)) {
                $settings = $change['settings'];
            } elseif (is_array($change) && count($change) === 2 && is_string($change['id'] ?? null)
                && preg_match('/\A[0-9]{9,11}\z/', $change['id']) === 1 && is_bool($change['enabled'] ?? null)) {
                $id = $change['id'];
                $enabled = $change['enabled'];
            } else {
                return [400, ['error' => 'invalid_request']];
            }
        }

        try {
            return [200, $monitor->threadSelection($match[1], $id, $enabled, $settings)];
        } catch (SafeFailure $error) {
            return match ($error->reason) {
                'selection_unauthorized' => [401, ['error' => 'unauthorized']],
                'invalid_request' => [400, ['error' => 'invalid_request']],
                'unknown_thread' => [404, ['error' => 'unknown_thread']],
                'monitor_busy' => [409, ['error' => 'busy']],
                default => [503, ['error' => 'unavailable']],
            };
        } catch (\Throwable) {
            return [503, ['error' => 'unavailable']];
        }
    }

    private static function exchange(PersistentMonitor $monitor, #[\SensitiveParameter] string $body): array
    {
        $request = strlen($body) <= self::MAX_EXCHANGE_BODY_BYTES ? json_decode($body, false, 4) : null;
        if (!$request instanceof \stdClass) {
            return [400, ['error' => 'invalid_request']];
        }
        if (!property_exists($request, 'registrationProof')) {
            return [401, ['error' => 'unauthorized']];
        }
        // json_decode collapses duplicate keys; require a single string-to-string member in the wire object.
        if (!is_string($request->registrationProof) || preg_match('/\A[a-f0-9]{64}\z/', $request->registrationProof) !== 1
            || preg_match('/\A\s*\{\s*"(?:[^"\x5c]|\x5c.)*"\s*:\s*"(?:[^"\x5c]|\x5c.)*"\s*\}\s*\z/s', $body) !== 1) {
            return [400, ['error' => 'invalid_request']];
        }

        try {
            return [200, ['token' => $monitor->exchangeSelectionToken($request->registrationProof)]];
        } catch (SafeFailure $error) {
            if ($error->reason === 'selection_unauthorized') {
                return [401, ['error' => 'unauthorized']];
            }
            return [503, ['error' => 'unavailable']];
        } catch (\Throwable) {
            return [503, ['error' => 'unavailable']];
        }
    }
}
