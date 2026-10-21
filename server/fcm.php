<?php

declare(strict_types=1);

namespace Sureneco;

use Closure;
use RuntimeException;
use Throwable;

require_once __DIR__ . '/bootstrap.php';

final class FcmDeliveryException extends RuntimeException
{
    public function __construct(public readonly string $errorCode, public readonly bool $retryable = true, public readonly int $retryAfter = 0)
    {
        parent::__construct('Push delivery failed.');
    }
}

/** Credentials and destination URLs are never accepted from API inputs. */
function createFcmSenderFromEnvironment(): ?FcmSender
{
    $path = getenv('SURENECO_FCM_CREDENTIALS');
    if ($path === false || $path === '') {
        return null;
    }
    try {
        if (!str_starts_with($path, '/') || str_contains($path, "\0")) {
            throw new RuntimeException();
        }
        assertPrivateStoragePath($path);
        $real = realpath($path);
        if ($real === false || !is_file($real) || filesize($real) > 65536) {
            throw new RuntimeException();
        }
        assertPrivateStoragePath($real);
        $json = @file_get_contents($real);
        if ($json === false) {
            throw new RuntimeException();
        }
        return new FcmSender(json_decode($json, true, 16, JSON_THROW_ON_ERROR), (string) getenv('SURENECO_FIREBASE_PROJECT_ID'));
    } catch (Throwable) {
        throw new FcmDeliveryException('delivery_configuration', false);
    }
}

final class FcmSender
{
    private readonly Closure $request;
    private readonly Closure $clock;
    private ?string $accessToken = null;
    private int $tokenExpiresAt = 0;

    /** The optional HTTP transport and clock are in-process test dependencies, not configuration. */
    public function __construct(private readonly array $credentials, private readonly string $project, ?callable $request = null, ?callable $clock = null)
    {
        if (preg_match('/\A[a-z][a-z0-9-]{4,28}[a-z0-9]\z/D', $project) !== 1
            || ($credentials['type'] ?? null) !== 'service_account' || ($credentials['project_id'] ?? null) !== $project
            || !is_string($credentials['client_email'] ?? null) || preg_match('/\A[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com\z/D', $credentials['client_email']) !== 1
            || !is_string($credentials['private_key'] ?? null)) {
            throw new FcmDeliveryException('delivery_configuration', false);
        }
        $key = @openssl_pkey_get_private($credentials['private_key']);
        $details = $key === false ? false : openssl_pkey_get_details($key);
        if ($details === false || $details['type'] !== OPENSSL_KEYTYPE_RSA || $details['bits'] < 2048) {
            throw new FcmDeliveryException('delivery_configuration', false);
        }
        $this->request = Closure::fromCallable($request ?? fcmHttpRequest(...));
        $this->clock = Closure::fromCallable($clock ?? time(...));
    }

    public function __invoke(string $token, array $payload, int $timeoutMs): void
    {
        $deadline = hrtime(true) + min(5000, $timeoutMs) * 1000000;
        $remaining = static fn (): int => max(1, (int) (($deadline - hrtime(true)) / 1000000));
        $at = ($this->clock)();
        if ($this->accessToken === null || $at >= $this->tokenExpiresAt - 60) {
            $encode = static fn (string $value): string => rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
            $unsigned = $encode('{"alg":"RS256","typ":"JWT"}') . '.' . $encode(json_encode([
                'iss' => $this->credentials['client_email'], 'scope' => 'https://www.googleapis.com/auth/firebase.messaging',
                'aud' => 'https://oauth2.googleapis.com/token', 'iat' => $at, 'exp' => $at + 3600,
            ], JSON_THROW_ON_ERROR));
            if (!@openssl_sign($unsigned, $signature, $this->credentials['private_key'], OPENSSL_ALGO_SHA256)) {
                throw new FcmDeliveryException('delivery_configuration', false);
            }
            $response = ($this->request)('https://oauth2.googleapis.com/token', ['Content-Type: application/x-www-form-urlencoded'], http_build_query([
                'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'assertion' => $unsigned . '.' . $encode($signature),
            ]), $remaining());
            $body = json_decode($response['body'], true);
            if ($response['status'] !== 200 || !is_string($body['access_token'] ?? null)
                || preg_match('/\A[\x21-\x7e]{1,16384}\z/D', $body['access_token']) !== 1
                || !is_int($body['expires_in'] ?? null) || $body['expires_in'] <= 0) {
                throw new FcmDeliveryException('delivery_authentication', true, $response['retryAfter'] ?? 0);
            }
            $this->accessToken = $body['access_token'];
            $this->tokenExpiresAt = $at + min(3600, $body['expires_in']);
        }
        if (hrtime(true) >= $deadline) {
            throw new FcmDeliveryException('delivery_timeout');
        }
        $at = ($this->clock)();
        $ttl = min(2419200, ($payload['expiresAt'] ?? 0) - $at);
        if ($ttl <= 0) {
            throw new FcmDeliveryException('expired', false);
        }
        $item = $payload['recruitment'];
        $message = ['message' => [
            'token' => $token,
            'android' => ['priority' => 'HIGH', 'ttl' => $ttl . 's', 'restricted_package_name' => 'io.github.sakots.sureneco'],
            'data' => [
                'eventId' => $payload['eventId'], 'revision' => (string) $payload['revision'],
                'expiresAt' => (string) $payload['expiresAt'], 'boardUrl' => $payload['boardUrl'],
                'threadId' => $payload['threadId'], 'postNumber' => (string) $item['number'],
                'roomIds' => json_encode(array_slice($item['roomIds'], 0, 20), JSON_THROW_ON_ERROR),
                'title' => mb_strcut($payload['threadTitle'], 0, 240, 'UTF-8'),
                'body' => mb_strcut($item['body'], 0, 1500, 'UTF-8'),
            ],
        ]];
        $dataSize = 0;
        foreach ($message['message']['data'] as $key => $value) {
            $dataSize += strlen($key) + strlen($value);
        }
        if ($dataSize > 3500) {
            throw new FcmDeliveryException('invalid_payload', false);
        }
        $response = ($this->request)('https://fcm.googleapis.com/v1/projects/' . $this->project . '/messages:send', [
            'Content-Type: application/json', 'Authorization: Bearer ' . $this->accessToken,
        ], json_encode($message, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $remaining());
        $body = json_decode($response['body'], true);
        if ($response['status'] === 200 && is_string($body['name'] ?? null)) {
            return;
        }
        $details = $body['error']['details'] ?? [];
        foreach (is_array($details) ? $details : [] as $detail) {
            if (is_array($detail) && $response['status'] === 404 && ($detail['@type'] ?? null) === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' && ($detail['errorCode'] ?? null) === 'UNREGISTERED') {
                throw new FcmDeliveryException('unregistered', false);
            }
        }
        if ($response['status'] === 401 || $response['status'] === 403) {
            $this->accessToken = null;
            throw new FcmDeliveryException('delivery_authentication');
        }
        if ($response['status'] === 429 || $response['status'] >= 500 || $response['status'] === 200) {
            throw new FcmDeliveryException('delivery_unavailable', true, $response['retryAfter'] ?? 0);
        }
        throw new FcmDeliveryException('invalid_argument', false);
    }
}

/** Fixed Google endpoints only, with bounded TLS-verified requests and no redirects or body logging. */
function fcmHttpRequest(string $url, array $headers, string $body, int $timeoutMs): array
{
    if ($url !== 'https://oauth2.googleapis.com/token' && preg_match('~\Ahttps://fcm\.googleapis\.com/v1/projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/messages:send\z~D', $url) !== 1) {
        throw new FcmDeliveryException('delivery_configuration', false);
    }
    $response = '';
    $retryAfter = 0;
    $headerBytes = 0;
    $curl = curl_init($url);
    if ($curl === false) {
        throw new FcmDeliveryException('delivery_unavailable');
    }
    try {
        curl_setopt_array($curl, [
            CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => $headers,
            CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_TIMEOUT_MS => max(1, min(5000, $timeoutMs)), CURLOPT_CONNECTTIMEOUT_MS => max(1, min(3000, $timeoutMs)),
            CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$response): int {
                if (strlen($response) + strlen($chunk) > 262144) { return 0; }
                $response .= $chunk;
                return strlen($chunk);
            },
            CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$retryAfter, &$headerBytes): int {
                $headerBytes += strlen($line);
                if ($headerBytes > 16384) { return 0; }
                if (preg_match('/^Retry-After:\s*(.*?)\s*$/i', $line, $match)) {
                    $retryAfter = ctype_digit($match[1]) ? (int) min(2419200, (float) $match[1]) : max(0, min(2419200, (strtotime($match[1]) ?: time()) - time()));
                }
                return strlen($line);
            },
        ]);
        if (curl_exec($curl) === false) {
            throw new FcmDeliveryException('delivery_unavailable');
        }
        return ['status' => (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE), 'body' => $response, 'retryAfter' => $retryAfter];
    } finally {
        unset($curl);
    }
}
