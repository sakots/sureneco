<?php

declare(strict_types=1);

namespace Sureneco\FcmTrial;

final class Configuration
{
    public const PACKAGE = 'sureneco.sakots.phptrial';
    public const OAUTH_ENDPOINT = 'https://oauth2.googleapis.com/token';
    public const OPERATIONS = ['auth', 'validate', 'validate-topic', 'send'];
    private const JSON_LIMIT = 65536;

    private function __construct(
        public readonly string $operation,
        public readonly string $projectId,
        #[\SensitiveParameter] public readonly array $credentials,
        #[\SensitiveParameter] public readonly ?string $registrationToken,
    ) {
    }

    /** @param resource|null $stdin */
    public static function load(
        string $operation,
        string $credentialPath,
        string $clientConfigPath,
        ?string $tokenPath,
        $stdin = null,
    ): self {
        if (!in_array($operation, self::OPERATIONS, true)) {
            throw new SafeFailure('invalid_operation');
        }
        if ($credentialPath === '-') {
            $stream = $stdin ?? STDIN;
            $rawCredentials = self::readStream($stream, self::JSON_LIMIT);
        } else {
            $rawCredentials = self::readFile($credentialPath, self::JSON_LIMIT, 'credentials');
        }
        $credentials = self::decode($rawCredentials);
        $client = self::decode(self::readFile($clientConfigPath, self::JSON_LIMIT, 'client'));
        $project = $credentials['project_id'] ?? null;
        if (($credentials['type'] ?? null) !== 'service_account'
            || !is_string($project)
            || preg_match('/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/D', $project) !== 1
            || ($credentials['token_uri'] ?? null) !== self::OAUTH_ENDPOINT
            || !is_string($credentials['client_email'] ?? null)
            || preg_match('/^[a-zA-Z0-9._-]+@' . preg_quote($project, '/') . '\.iam\.gserviceaccount\.com$/D', $credentials['client_email']) !== 1
            || !is_string($credentials['private_key'] ?? null)
        ) {
            throw new SafeFailure('invalid_credentials');
        }
        $privateKey = @openssl_pkey_get_private($credentials['private_key']);
        $keyDetails = $privateKey === false ? false : openssl_pkey_get_details($privateKey);
        if ($keyDetails === false || $keyDetails['type'] !== OPENSSL_KEYTYPE_RSA || $keyDetails['bits'] < 2048) {
            throw new SafeFailure('invalid_credentials');
        }
        if (($client['project_info']['project_id'] ?? null) !== $project) {
            throw new SafeFailure('project_mismatch');
        }
        $projectNumber = $client['project_info']['project_number'] ?? null;
        if (!is_string($projectNumber) || preg_match('/^[0-9]+$/D', $projectNumber) !== 1 || !is_array($client['client'] ?? null)) {
            throw new SafeFailure('invalid_client_config');
        }
        $matches = array_values(array_filter($client['client'], static fn ($entry): bool => is_array($entry)
            && ($entry['client_info']['android_client_info']['package_name'] ?? null) === self::PACKAGE));
        if (count($matches) !== 1) {
            throw new SafeFailure('trial_client_missing');
        }
        $appId = $matches[0]['client_info']['mobilesdk_app_id'] ?? null;
        $apiKeys = $matches[0]['api_key'] ?? null;
        if (!is_string($appId)
            || preg_match('/^1:' . preg_quote($projectNumber, '/') . ':android:[a-f0-9]+$/D', $appId) !== 1
            || !is_array($apiKeys)
            || count(array_filter($apiKeys, static fn ($entry): bool => is_array($entry)
                && is_string($entry['current_key'] ?? null) && $entry['current_key'] !== '')) === 0
        ) {
            throw new SafeFailure('invalid_client_config');
        }
        $token = null;
        if (in_array($operation, ['validate', 'send'], true)) {
            if ($tokenPath === null || $tokenPath === '' || $tokenPath === '-') {
                throw new SafeFailure('registration_token_required');
            }
            $token = trim(self::readFile($tokenPath, 8192, 'token'));
            if ($token === '' || preg_match('/^[a-zA-Z0-9_:\-]+$/D', $token) !== 1) {
                throw new SafeFailure('invalid_registration_token');
            }
        } elseif ($tokenPath !== null) {
            throw new SafeFailure('unexpected_registration_token');
        }
        // Discard all credential fields that could alter authentication endpoints or behavior.
        $allowedCredentials = array_intersect_key($credentials, array_flip([
            'type', 'project_id', 'client_email', 'private_key', 'private_key_id', 'token_uri',
        ]));
        if (isset($allowedCredentials['private_key_id']) && !is_string($allowedCredentials['private_key_id'])) {
            throw new SafeFailure('invalid_credentials');
        }
        return new self($operation, $project, $allowedCredentials, $token);
    }

    private static function decode(#[\SensitiveParameter] string $input): array
    {
        try {
            $value = json_decode($input, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new SafeFailure('invalid_input_json');
        }
        if (!is_array($value) || array_is_list($value)) {
            throw new SafeFailure('invalid_input_json');
        }
        return $value;
    }

    private static function readFile(string $path, int $limit, string $kind): string
    {
        $metadata = @lstat($path);
        if ($metadata === false) {
            throw new SafeFailure('input_file_unavailable');
        }
        if (($metadata['mode'] & 0170000) !== 0100000) {
            throw new SafeFailure('input_file_not_regular');
        }
        self::checkPermissions($metadata['mode'], $kind);
        if ($metadata['size'] > $limit) {
            throw new SafeFailure('input_too_large');
        }
        $stream = @fopen($path, 'rb');
        if ($stream === false) {
            throw new SafeFailure('input_file_unavailable');
        }
        try {
            $opened = fstat($stream);
            if ($opened === false || ($opened['mode'] & 0170000) !== 0100000
                || $opened['ino'] !== $metadata['ino'] || $opened['dev'] !== $metadata['dev']) {
                throw new SafeFailure('input_file_not_regular');
            }
            self::checkPermissions($opened['mode'], $kind);
            return self::readStream($stream, $limit);
        } finally {
            fclose($stream);
        }
    }

    private static function checkPermissions(int $mode, string $kind): void
    {
        if (($kind === 'credentials' && ($mode & 0077) !== 0)
            || ($kind === 'token' && ($mode & 0777) !== 0600)) {
            throw new SafeFailure('input_file_permissions');
        }
    }

    /** @param resource $stream */
    private static function readStream($stream, int $limit): string
    {
        if (!is_resource($stream)) {
            throw new SafeFailure('input_file_unavailable');
        }
        $data = stream_get_contents($stream, $limit + 1);
        if ($data === false) {
            throw new SafeFailure('input_file_unavailable');
        }
        if (strlen($data) > $limit) {
            throw new SafeFailure('input_too_large');
        }
        return $data;
    }
}
