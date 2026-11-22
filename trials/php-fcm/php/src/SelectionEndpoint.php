<?php

declare(strict_types=1);

namespace Sureneco\FcmTrial;

final class SelectionEndpoint
{
    public const MAX_BODY_BYTES = 1024;

    /** @return array{int, array} HTTP status and JSON document */
    public static function dispatch(
        PersistentMonitor $monitor,
        string $method,
        #[\SensitiveParameter] ?string $authorization,
        ?string $contentType,
        string $body,
    ): array {
        if ($method !== 'GET' && $method !== 'POST') {
            return [405, ['error' => 'method_not_allowed']];
        }
        if ($authorization === null || preg_match('/\A(?i:Bearer) ([a-f0-9]{64})\z/', $authorization, $match) !== 1) {
            return [401, ['error' => 'unauthorized']];
        }
        $id = $enabled = null;
        if ($method === 'POST') {
            if ($contentType === null || strtolower(trim(explode(';', $contentType, 2)[0])) !== 'application/json') {
                return [415, ['error' => 'unsupported_media_type']];
            }
            $change = strlen($body) <= self::MAX_BODY_BYTES ? json_decode($body, true, 4) : null;
            if (!is_array($change) || count($change) !== 2 || !is_string($change['id'] ?? null)
                || preg_match('/\A[0-9]{9,11}\z/', $change['id']) !== 1 || !is_bool($change['enabled'] ?? null)) {
                return [400, ['error' => 'invalid_request']];
            }
            $id = $change['id'];
            $enabled = $change['enabled'];
        }

        try {
            return [200, $monitor->threadSelection($match[1], $id, $enabled)];
        } catch (SafeFailure $error) {
            return match ($error->reason) {
                'selection_unauthorized' => [401, ['error' => 'unauthorized']],
                'unknown_thread' => [404, ['error' => 'unknown_thread']],
                'monitor_busy' => [409, ['error' => 'busy']],
                default => [503, ['error' => 'unavailable']],
            };
        } catch (\Throwable) {
            return [503, ['error' => 'unavailable']];
        }
    }
}
