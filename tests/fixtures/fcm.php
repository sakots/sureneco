<?php

declare(strict_types=1);

require __DIR__ . '/../../server/fcm.php';
$input = json_decode(stream_get_contents(STDIN), true, 64, JSON_THROW_ON_ERROR);
$key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
openssl_pkey_export($key, $privateKey);
$publicKey = openssl_pkey_get_details($key)['key'];
$credentials = ['type' => 'service_account', 'project_id' => 'sureneco-test', 'client_email' => 'sender@sureneco-test.iam.gserviceaccount.com', 'private_key' => $privateKey];
$credentials = array_replace($credentials, $input['credentials'] ?? []);
$requests = [];
$messages = [];
$responses = $input['responses'] ?? [];
$claims = null;
$verified = false;
$at = $input['now'];
$http = function (string $url, array $headers, string $body, int $timeout) use (&$requests, &$responses, &$messages, &$claims, &$verified, $publicKey, $input): array {
    $requests[] = ['url' => $url, 'timeout' => $timeout];
    if ($url === 'https://oauth2.googleapis.com/token') {
        parse_str($body, $form);
        $parts = explode('.', $form['assertion']);
        $decode = static fn (string $value): string => base64_decode(strtr($value, '-_', '+/'), true);
        $claims = json_decode($decode($parts[1]), true, 64, JSON_THROW_ON_ERROR);
        $verified = openssl_verify($parts[0] . '.' . $parts[1], $decode($parts[2]), $publicKey, OPENSSL_ALGO_SHA256) === 1;
        return $input['oauthResponse'] ?? ['status' => 200, 'body' => '{"access_token":"fixture-token","expires_in":3600}'];
    }
    if (!in_array('Authorization: Bearer fixture-token', $headers, true)) { throw new RuntimeException('Missing authorization.'); }
    $messages[] = json_decode($body, true, 64, JSON_THROW_ON_ERROR);
    return array_shift($responses) ?? ['status' => 200, 'body' => '{"name":"projects/sureneco-test/messages/test"}'];
};
$errors = [];
try {
    $sender = new Sureneco\FcmSender($credentials, 'sureneco-test', $http, static fn (): int => $at);
    foreach (range(1, $input['count'] ?? 1) as $iteration) {
        try {
            $sender('fixture-registration-token', $input['payload'], 3000);
            $errors[] = null;
        } catch (Sureneco\FcmDeliveryException $error) {
            $errors[] = ['code' => $error->errorCode, 'retryable' => $error->retryable, 'retryAfter' => $error->retryAfter, 'message' => $error->getMessage()];
        }
    }
} catch (Sureneco\FcmDeliveryException $error) {
    $errors[] = ['code' => $error->errorCode, 'retryable' => $error->retryable];
}
echo json_encode(['requests' => $requests, 'messages' => $messages, 'claims' => $claims, 'verified' => $verified, 'errors' => $errors], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
