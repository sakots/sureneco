<?php

declare(strict_types=1);

namespace Sureneco\FcmTrial;

use Google\Auth\Credentials\ServiceAccountCredentials;
use GuzzleHttp\Client;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

final class Sender
{
    private const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
    private const RESPONSE_LIMIT = 65536;
    private readonly ClientInterface $http;

    public function __construct(?ClientInterface $http = null)
    {
        $this->http = $http ?? new Client();
    }

    public function run(#[\SensitiveParameter] Configuration $configuration): array
    {
        if ($configuration->operation === 'validate-recruitment') {
            return $this->execute($configuration, static fn (int $now): array =>
                self::recruitmentData($now, '1000000000', 1, ['12345'], ($now + 60) * 1000));
        }
        return $this->execute($configuration);
    }

    public function sendRecruitment(
        #[\SensitiveParameter] Configuration $configuration,
        string $threadId,
        int $postNumber,
        array $roomIds,
        int $expiresAtMs,
    ): array {
        if ($configuration->operation !== 'send') {
            throw new SafeFailure('invalid_operation');
        }
        return $this->execute($configuration, static fn (int $now): array =>
            self::recruitmentData($now, $threadId, $postNumber, $roomIds, $expiresAtMs));
    }

    private static function recruitmentData(int $now, string $threadId, int $postNumber, array $roomIds, int $expiresAtMs): array
    {
        $expiresAt = min($now + 300, intdiv($expiresAtMs, 1000));
        if ($expiresAt <= $now) {
            throw new SafeFailure('recruitment_expired');
        }
        return [
            'type' => 'recruitment',
            'eventId' => substr(hash('sha256', "recruitment:$threadId:$postNumber"), 0, 32),
            'sentAt' => (string) $now,
            'expiresAt' => (string) $expiresAt,
            'title' => 'スレネコ PHP試験：友人戦募集',
            'body' => 'レス #' . $postNumber . ' ／ 部屋ID: ' . implode('、', array_slice($roomIds, 0, 5)),
        ];
    }

    private function execute(#[\SensitiveParameter] Configuration $configuration, ?\Closure $recruitment = null): array
    {
        try {
            $credentials = new ServiceAccountCredentials(self::SCOPE, $configuration->credentials);
            $authentication = $credentials->fetchAuthToken(function (RequestInterface $request, array $options = []): ResponseInterface {
                if ((string) $request->getUri() !== Configuration::OAUTH_ENDPOINT || $request->getMethod() !== 'POST') {
                    throw new SafeFailure('invalid_oauth_endpoint');
                }
                return $this->perform($request, 'oauth');
            });
        } catch (SafeFailure $error) {
            throw $error;
        } catch (\Throwable) {
            throw new SafeFailure('oauth_authentication_failed');
        }
        $accessToken = $authentication['access_token'] ?? null;
        if (!is_string($accessToken) || $accessToken === '' || strlen($accessToken) > 16384
            || preg_match('/^[\x21-\x7e]+$/D', $accessToken) !== 1) {
            throw new SafeFailure('invalid_provider_response');
        }
        $result = [
            'ok' => true,
            'operation' => $configuration->operation,
            'status' => 'authenticated',
            'authenticated' => true,
            'deviceDeliveryVerified' => false,
        ];
        if ($configuration->operation === 'auth') {
            return $result;
        }
        $now = time();
        $data = $recruitment === null ? [
            'type' => 'connectivity_test',
            'eventId' => bin2hex(random_bytes(16)),
            'sentAt' => (string) $now,
            'expiresAt' => (string) ($now + 300),
            'title' => 'スレネコ PHP・FCM疎通試験',
            'body' => 'PHPからFCM経由で送信した試験通知です。本番の募集通知ではありません。',
        ] : $recruitment($now);
        $validateOnly = $configuration->operation !== 'send';
        $message = [
            'data' => $data,
            'android' => [
                'priority' => 'high',
                'ttl' => ((int) $data['expiresAt'] - $now) . 's',
                'restricted_package_name' => Configuration::PACKAGE,
            ],
        ];
        if (in_array($configuration->operation, ['validate-topic', 'validate-recruitment'], true)) {
            // This explicit operation can validate authorization without a registered device; it never sends.
            $message['topic'] = 'sureneco-trial-' . bin2hex(random_bytes(16));
        } else {
            if ($configuration->registrationToken === null) {
                throw new SafeFailure('registration_token_required');
            }
            $message['token'] = $configuration->registrationToken;
        }
        $endpoint = 'https://fcm.googleapis.com/v1/projects/' . $configuration->projectId . '/messages:send';
        $request = new Request('POST', $endpoint, [
            'Authorization' => 'Bearer ' . $accessToken,
            'Content-Type' => 'application/json; charset=utf-8',
            'Accept' => 'application/json',
        ], json_encode(['validate_only' => $validateOnly, 'message' => $message], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
        $response = $this->perform($request, 'fcm');
        try {
            $responseData = json_decode((string) $response->getBody(), false, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new SafeFailure('invalid_provider_response', $response->getStatusCode());
        }
        if (!$responseData instanceof \stdClass || isset($responseData->error)
            || (!$validateOnly && (!isset($responseData->name) || !is_string($responseData->name)
                || !str_starts_with($responseData->name, 'projects/' . $configuration->projectId . '/messages/')))) {
            throw new SafeFailure('invalid_provider_response', $response->getStatusCode());
        }
        $result['status'] = $validateOnly ? 'validated' : 'accepted';
        $result['validated'] = $validateOnly;
        $result['sent'] = !$validateOnly;
        $result['eventId'] = $data['eventId'];
        $result['sentAt'] = $data['sentAt'];
        $result['expiresAt'] = $data['expiresAt'];
        if ($configuration->operation === 'validate-topic') {
            $result['mode'] = 'validate-topic';
        }
        return $result;
    }

    private function perform(#[\SensitiveParameter] RequestInterface $request, string $provider): ResponseInterface
    {
        try {
            $response = $this->http->send($request, [
                'allow_redirects' => false,
                'verify' => true,
                'http_errors' => false,
                'connect_timeout' => 10.0,
                'timeout' => 20.0,
                'stream' => true,
                'debug' => false,
            ]);
            $stream = $response->getBody();
            $readDeadline = microtime(true) + 20.0;
            try {
                $body = '';
                while (!$stream->eof() && strlen($body) <= self::RESPONSE_LIMIT) {
                    if (microtime(true) >= $readDeadline) {
                        throw new SafeFailure($provider . '_network_failed');
                    }
                    $chunk = $stream->read(self::RESPONSE_LIMIT + 1 - strlen($body));
                    if ($chunk === '' && !$stream->eof()) {
                        throw new SafeFailure('invalid_provider_response', $response->getStatusCode());
                    }
                    $body .= $chunk;
                }
            } finally {
                $stream->close();
            }
        } catch (SafeFailure $error) {
            throw $error;
        } catch (\Throwable) {
            throw new SafeFailure($provider . '_network_failed');
        }
        if (strlen($body) > self::RESPONSE_LIMIT) {
            throw new SafeFailure('provider_response_too_large', $response->getStatusCode());
        }
        if ($response->getStatusCode() !== 200) {
            throw new SafeFailure(
                $provider . '_rejected',
                $response->getStatusCode(),
                self::providerError($provider, $body),
            );
        }
        // Give Google Auth a bounded body, not the live network stream or provider exception.
        return new Response($response->getStatusCode(), [], $body);
    }

    private static function providerError(string $provider, #[\SensitiveParameter] string $body): ?string
    {
        $decoded = json_decode($body, true, 32);
        if (!is_array($decoded)) {
            return null;
        }
        if ($provider === 'oauth') {
            $error = $decoded['error'] ?? null;
            return is_string($error) && in_array($error, [
                'invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_request',
                'unsupported_grant_type', 'invalid_scope', 'access_denied', 'temporarily_unavailable', 'server_error',
            ], true) ? $error : null;
        }
        $error = $decoded['error'] ?? null;
        if (!is_array($error)) {
            return null;
        }
        foreach (is_array($error['details'] ?? null) ? $error['details'] : [] as $detail) {
            if (is_array($detail) && ($detail['@type'] ?? null) === 'type.googleapis.com/google.firebase.fcm.v1.FcmError'
                && is_string($detail['errorCode'] ?? null)
                && in_array($detail['errorCode'], [
                    'UNSPECIFIED_ERROR', 'INVALID_ARGUMENT', 'UNREGISTERED', 'SENDER_ID_MISMATCH',
                    'QUOTA_EXCEEDED', 'APNS_AUTH_ERROR', 'THIRD_PARTY_AUTH_ERROR', 'UNAVAILABLE', 'INTERNAL',
                ], true)) {
                return $detail['errorCode'];
            }
        }
        $status = $error['status'] ?? null;
        return is_string($status) && in_array($status, [
            'INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'NOT_FOUND', 'RESOURCE_EXHAUSTED',
            'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE',
            'DEADLINE_EXCEEDED', 'UNKNOWN', 'CANCELLED', 'ALREADY_EXISTS', 'DATA_LOSS',
        ], true) ? $status : null;
    }
}
