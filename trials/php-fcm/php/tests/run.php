<?php

declare(strict_types=1);

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use Sureneco\FcmTrial\Configuration;
use Sureneco\FcmTrial\SafeFailure;
use Sureneco\FcmTrial\Sender;

require dirname(__DIR__) . '/vendor/autoload.php';

$directory = sys_get_temp_dir() . '/sureneco-fcm-tests-' . bin2hex(random_bytes(8));
mkdir($directory, 0700);
$assertions = 0;
$assert = static function (bool $condition, string $label) use (&$assertions): void {
    ++$assertions;
    if (!$condition) {
        throw new RuntimeException($label);
    }
};
$failure = static function (callable $operation, string $expected) use ($assert): SafeFailure {
    try {
        $operation();
    } catch (SafeFailure $error) {
        $assert($error->reason === $expected, 'Expected safe failure: ' . $expected);
        return $error;
    }
    throw new RuntimeException('Expected failure: ' . $expected);
};
$put = static function (string $name, string $content, int $mode = 0600) use ($directory): string {
    $path = $directory . '/' . $name;
    file_put_contents($path, $content);
    chmod($path, $mode);
    return $path;
};

try {
    $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
    if ($key === false || !openssl_pkey_export($key, $privateKey)) {
        throw new RuntimeException('Cannot generate ephemeral test key');
    }
    $credentials = [
        'type' => 'service_account',
        'project_id' => 'trial-project',
        'client_email' => 'trial@trial-project.iam.gserviceaccount.com',
        'private_key' => $privateKey,
        'token_uri' => 'https://oauth2.googleapis.com/token',
    ];
    $client = [
        'project_info' => ['project_id' => 'trial-project', 'project_number' => '123456789'],
        'client' => [[
            'client_info' => [
                'mobilesdk_app_id' => '1:123456789:android:abc123',
                'android_client_info' => ['package_name' => 'sureneco.sakots.phptrial'],
            ],
            'api_key' => [['current_key' => 'public-client-test-key']],
        ]],
    ];
    $credentialPath = $put('credentials.json', json_encode($credentials, JSON_THROW_ON_ERROR));
    $clientPath = $put('client.json', json_encode($client, JSON_THROW_ON_ERROR));
    $tokenPath = $put('token.txt', "test-registration-token_123:abc\n");
    $load = static fn (string $operation = 'send', ?string $token = null): Configuration => Configuration::load(
        $operation,
        $credentialPath,
        $clientPath,
        in_array($operation, ['auth', 'validate-topic'], true) ? null : ($token ?? $tokenPath),
    );

    $wrongProject = $client;
    $wrongProject['project_info']['project_id'] = 'another-project';
    $wrongProjectPath = $put('wrong-project.json', json_encode($wrongProject, JSON_THROW_ON_ERROR));
    $failure(fn () => Configuration::load('send', $credentialPath, $wrongProjectPath, $tokenPath), 'project_mismatch');
    $wrongPackage = $client;
    $wrongPackage['client'][0]['client_info']['android_client_info']['package_name'] = 'production.app';
    $wrongPackagePath = $put('wrong-package.json', json_encode($wrongPackage, JSON_THROW_ON_ERROR));
    $failure(fn () => Configuration::load('send', $credentialPath, $wrongPackagePath, $tokenPath), 'trial_client_missing');
    $evilCredentials = $credentials;
    $evilCredentials['token_uri'] = 'https://attacker.invalid/token';
    $evilPath = $put('evil.json', json_encode($evilCredentials, JSON_THROW_ON_ERROR));
    $failure(fn () => Configuration::load('auth', $evilPath, $clientPath, null), 'invalid_credentials');
    $failure(fn () => Configuration::load('send', $credentialPath, $clientPath, null), 'registration_token_required');
    $failure(fn () => Configuration::load('auth', $directory . '/absent-credentials', $clientPath, null), 'input_file_unavailable');
    $failure(fn () => Configuration::load('validate-topic', $credentialPath, $clientPath, $tokenPath), 'unexpected_registration_token');
    $failure(fn () => $load('send', $directory . '/absent'), 'input_file_unavailable');
    $failure(fn () => $load('send', $put('empty.txt', '')), 'invalid_registration_token');
    $failure(fn () => $load('send', $put('invalid.txt', "token\nsecond-token")), 'invalid_registration_token');
    $failure(fn () => $load('send', $put('public-token.txt', 'test-token', 0644)), 'input_file_permissions');
    $publicCredentials = $put('public-credentials.json', json_encode($credentials, JSON_THROW_ON_ERROR), 0644);
    $failure(fn () => Configuration::load('auth', $publicCredentials, $clientPath, null), 'input_file_permissions');
    $largeCredentials = $put('large.json', str_repeat('x', 65537));
    $failure(fn () => Configuration::load('auth', $largeCredentials, $clientPath, null), 'input_too_large');
    symlink($credentialPath, $directory . '/linked.json');
    $failure(fn () => Configuration::load('auth', $directory . '/linked.json', $clientPath, null), 'input_file_not_regular');
    $input = fopen('php://temp', 'w+b');
    fwrite($input, json_encode($credentials, JSON_THROW_ON_ERROR));
    rewind($input);
    $stdinConfiguration = Configuration::load('auth', '-', $clientPath, null, $input);
    $assert($stdinConfiguration->projectId === 'trial-project', 'Credentials stdin supports SSH streaming');
    fclose($input);

    foreach (['auth', 'validate', 'validate-topic', 'send'] as $operation) {
        $history = [];
        $responses = [new Response(200, [], json_encode(['access_token' => 'secret-access-token', 'expires_in' => 3600, 'token_type' => 'Bearer']))];
        if ($operation !== 'auth') {
            $responses[] = new Response(200, [], '{"name":"projects/trial-project/messages/provider-id"}');
        }
        $stack = HandlerStack::create(new MockHandler($responses));
        $stack->push(Middleware::history($history));
        $sender = new Sender(new Client(['handler' => $stack]));
        $result = $sender->run($load($operation));
        $expected = ['auth' => 'authenticated', 'validate' => 'validated', 'validate-topic' => 'validated', 'send' => 'accepted'][$operation];
        $assert($result['status'] === $expected, 'Operation status: ' . $operation);
        $assert(!str_contains(json_encode($result), 'secret-access-token'), 'Access token not returned');
        $assert((string) $history[0]['request']->getUri() === 'https://oauth2.googleapis.com/token', 'Fixed OAuth endpoint');
        foreach ($history as $request) {
            $assert($request['options']['verify'] === true, 'TLS verification enabled');
            $assert($request['options']['allow_redirects'] === false, 'Redirects disabled');
            $assert($request['options']['timeout'] === 20.0, 'Bounded request timeout');
        }
        if ($operation !== 'auth') {
            $assert((string) $history[1]['request']->getUri() === 'https://fcm.googleapis.com/v1/projects/trial-project/messages:send', 'Fixed FCM endpoint');
            $payload = json_decode((string) $history[1]['request']->getBody(), true, 16, JSON_THROW_ON_ERROR);
            $assert($payload['validate_only'] === ($operation !== 'send'), 'Validate never requests delivery');
            $assert(!isset($payload['message']['notification']), 'Data-only delivery');
            $assert($payload['message']['android'] === ['priority' => 'high', 'ttl' => '300s', 'restricted_package_name' => 'sureneco.sakots.phptrial'], 'Restricted package and TTL');
            $data = $payload['message']['data'];
            $assert(array_keys($data) === ['type', 'eventId', 'sentAt', 'expiresAt', 'title', 'body'], 'Exact payload fields');
            $assert($data['type'] === 'connectivity_test' && preg_match('/^[a-f0-9]{32}$/D', $data['eventId']) === 1, 'Expected event identity');
            $assert((int) $data['expiresAt'] - (int) $data['sentAt'] === 300, 'Five-minute event lifetime');
            $assert(count(preg_split('//u', $data['title'], -1, PREG_SPLIT_NO_EMPTY)) <= 80, 'Title size');
            $assert(count(preg_split('//u', $data['body'], -1, PREG_SPLIT_NO_EMPTY)) <= 220, 'Body size');
            $assert($result['eventId'] === $data['eventId'], 'Safe result correlates receiver event');
            if ($operation === 'validate-topic') {
                $assert(isset($payload['message']['topic']) && !isset($payload['message']['token']), 'Topic validation has no registration token');
                $assert(preg_match('/^sureneco-trial-[a-f0-9]{32}$/D', $payload['message']['topic']) === 1, 'Fresh isolated topic name');
                $assert($result['mode'] === 'validate-topic' && $result['validated'] === true
                    && $result['sent'] === false && $result['deviceDeliveryVerified'] === false, 'Topic validation never claims delivery');
            } else {
                $assert(isset($payload['message']['token']) && !isset($payload['message']['topic']), 'Receiver operations never target a topic');
            }
        }
    }

    $secretBody = json_encode(['error' => ['status' => 'PERMISSION_DENIED', 'message' => 'secret-registration-token ' . $privateKey]]);
    $mock = new MockHandler([
        new Response(200, [], '{"access_token":"secret-access-token","expires_in":3600,"token_type":"Bearer"}'),
        new Response(403, [], $secretBody),
    ]);
    $error = $failure(fn () => (new Sender(new Client(['handler' => HandlerStack::create($mock)])))->run($load()), 'fcm_rejected');
    $encodedError = json_encode($error->result('send'));
    $assert($error->httpStatus === 403 && $error->providerError === 'PERMISSION_DENIED', 'Safe provider code preserved');
    $assert(!str_contains($encodedError, 'PRIVATE KEY') && !str_contains($encodedError, 'secret-'), 'Provider details redacted');
    $mock = new MockHandler([new Response(400, [], '{"error":"invalid_grant","error_description":"secret-private-key"}')]);
    $error = $failure(fn () => (new Sender(new Client(['handler' => HandlerStack::create($mock)])))->run($load('auth')), 'oauth_rejected');
    $assert($error->providerError === 'invalid_grant' && !str_contains(json_encode($error->result('auth')), 'secret-'), 'OAuth details redacted');
    $mock = new MockHandler([new Response(302, ['Location' => 'https://attacker.invalid'], '{"error":"secret-token"}')]);
    $error = $failure(fn () => (new Sender(new Client(['handler' => HandlerStack::create($mock)])))->run($load('auth')), 'oauth_rejected');
    $assert($error->httpStatus === 302 && $error->providerError === null, 'Redirect refused without exposing arbitrary provider error');
    $mock = new MockHandler([new Response(200, [], '{"access_token":"secret-access-token","expires_in":3600,"token_type":"Bearer"}'), new Response(200, [], 'not-json secret-private-key')]);
    $failure(fn () => (new Sender(new Client(['handler' => HandlerStack::create($mock)])))->run($load()), 'invalid_provider_response');

    echo json_encode(['ok' => true, 'assertions' => $assertions], JSON_THROW_ON_ERROR) . PHP_EOL;
} finally {
    foreach (glob($directory . '/*') as $path) {
        unlink($path);
    }
    rmdir($directory);
}
