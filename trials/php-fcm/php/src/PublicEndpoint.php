<?php

declare(strict_types=1);

namespace Sureneco\FcmTrial;

final class PublicEndpoint
{
    public const MAX_BODY_BYTES = 8192;

    /** @return array{int, array} HTTP status and JSON document */
    public static function dispatch(
        PublicService $service,
        string $method,
        #[\SensitiveParameter] ?string $authorization,
        ?string $contentType,
        #[\SensitiveParameter] string $body,
        string $address,
    ): array {
        if ($method !== 'GET' && $method !== 'POST') {
            return [405, ['error' => 'method_not_allowed']];
        }
        $request = null;
        if ($method === 'POST') {
            if ($contentType === null || strtolower(trim(explode(';', $contentType, 2)[0])) !== 'application/json') {
                return [415, ['error' => 'unsupported_media_type']];
            }
            if (strlen($body) > self::MAX_BODY_BYTES) {
                return [413, ['error' => 'request_too_large']];
            }
            $request = json_decode($body, false, 4);
            if (!$request instanceof \stdClass) {
                return [400, ['error' => 'invalid_request']];
            }
        }
        try {
            $action = $request->action ?? null;
            $fields = $request === null ? 0 : count((array) $request);
            if ($authorization === null && ($action === 'begin' || $action === 'finish')) {
                if (!self::validHex($request->bearer ?? null, 64)) {
                    throw new SafeFailure('invalid_request');
                }
                if ($action === 'begin' && $fields === 3 && is_string($request->registrationToken ?? null)
                    && preg_match('/\A[a-zA-Z0-9_:\-]{1,4096}\z/', $request->registrationToken) === 1) {
                    return [200, $service->begin($request->registrationToken, $request->bearer, $address)];
                }
                if ($action === 'finish' && $fields === 4 && self::validHex($request->challengeId ?? null, 32)
                    && self::validHex($request->code ?? null, 64)) {
                    return [200, $service->finish($request->challengeId, $request->code, $request->bearer)];
                }
                throw new SafeFailure('invalid_request');
            }
            if ($authorization === null || preg_match('/\A(?i:Bearer) ([a-f0-9]{64})\z/', $authorization, $match) !== 1) {
                throw new SafeFailure('unauthorized');
            }
            if ($method === 'GET') {
                return [200, $service->selection($match[1])];
            }
            if ($fields === 1) {
                if ($action === 'delete') {
                    return [200, $service->delete($match[1])];
                }
                if ($action === 'pause' || $action === 'resume') {
                    return [200, $service->setEnabled($match[1], $action === 'resume')];
                }
                if (($request->settings ?? null) instanceof \stdClass) {
                    return [200, $service->selection($match[1], settings: (array) $request->settings)];
                }
            }
            if ($fields === 2 && is_string($request->id ?? null) && preg_match('/\A[0-9]{9,11}\z/', $request->id) === 1
                && is_bool($request->enabled ?? null)) {
                return [200, $service->selection($match[1], $request->id, $request->enabled)];
            }
            throw new SafeFailure('invalid_request');
        } catch (SafeFailure $error) {
            return match ($error->reason) {
                'unauthorized' => [401, ['error' => 'unauthorized']],
                'invalid_challenge' => [401, ['error' => 'invalid_challenge']],
                'invalid_request' => [400, ['error' => 'invalid_request']],
                'unknown_thread' => [404, ['error' => 'unknown_thread']],
                'monitor_busy' => [409, ['error' => 'busy']],
                'capacity' => [409, ['error' => 'capacity']],
                'selection_limit' => [409, ['error' => 'selection_limit']],
                'rate_limited' => [429, ['error' => 'rate_limited']],
                default => [503, ['error' => 'unavailable']],
            };
        } catch (\Throwable) {
            return [503, ['error' => 'unavailable']];
        }
    }

    private static function validHex(#[\SensitiveParameter] mixed $value, int $length): bool
    {
        return is_string($value) && strlen($value) === $length && strspn($value, '0123456789abcdef') === $length;
    }
}
