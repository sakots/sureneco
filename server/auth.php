<?php

declare(strict_types=1);

namespace Sureneco;

use Closure;
use JsonException;
use RuntimeException;
use Throwable;

require_once __DIR__ . '/bootstrap.php';

final class FirebaseAuthException extends RuntimeException
{
    public function __construct(public readonly int $status = 401)
    {
        $this->errorCode = $status === 401 ? 'unauthorized' : 'authentication_unavailable';
        parent::__construct($status === 401 ? 'Authentication required.' : 'Authentication unavailable.');
    }

    public readonly string $errorCode;
}

/** Public Firebase identifiers only; no service-account credential is needed for verification. */
function firebaseAuthConfig(): array
{
    $cache = getenv('SURENECO_FIREBASE_KEY_CACHE');
    return [
        'projectId' => getenv('SURENECO_FIREBASE_PROJECT_ID'),
        'projectNumber' => getenv('SURENECO_FIREBASE_PROJECT_NUMBER'),
        'appId' => getenv('SURENECO_FIREBASE_APP_ID'),
        'cacheDirectory' => $cache === false ? __DIR__ . '/data/firebase-keys' : $cache,
    ];
}

/** Authenticate self-service requests. Never derive the owner from the request body or FCM token. */
function authenticateFirebaseRequest(array $server, ?FirebaseTokenVerifier $verifier = null): array
{
    $verifier ??= new FirebaseTokenVerifier(firebaseAuthConfig());
    $authorization = $server['HTTP_AUTHORIZATION'] ?? null;
    $appCheck = $server['HTTP_X_FIREBASE_APPCHECK'] ?? null;
    if (!is_string($authorization) || !is_string($appCheck)
        || strlen($authorization) > 16391 || strlen($appCheck) > 16384
        || preg_match('/\ABearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\z/D', $authorization, $match) !== 1
        || preg_match('/\A[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\z/D', $appCheck) !== 1) {
        throw new FirebaseAuthException();
    }
    return $verifier->verify($match[1], $appCheck);
}

final class FirebaseTokenVerifier
{
    private const ID_KEYS = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
    private const APP_KEYS = 'https://firebaseappcheck.googleapis.com/v1/jwks';
    private const MAX_RESPONSE_BYTES = 262144;
    private const MAX_CACHE_SECONDS = 3600;

    private readonly Closure $fetcher;
    private readonly Closure $clock;
    private array $keys = [];

    /**
     * $config: projectId, projectNumber, Android Firebase appId, private cacheDirectory.
     * $fetcher(URL): ['body' => JSON string, 'maxAge' => seconds] is an explicit test seam.
     * Production uses only the fixed HTTPS endpoints below; no environment can replace them.
     */
    public function __construct(private readonly array $config, ?callable $fetcher = null, ?callable $clock = null)
    {
        if (!is_string($config['projectId'] ?? null)
            || preg_match('/\A[a-z][a-z0-9-]{4,28}[a-z0-9]\z/D', $config['projectId']) !== 1
            || !is_string($config['projectNumber'] ?? null)
            || preg_match('/\A[1-9][0-9]{0,19}\z/D', $config['projectNumber']) !== 1
            || !is_string($config['appId'] ?? null)
            || preg_match('/\A1:' . preg_quote($config['projectNumber'], '/') . ':android:[a-f0-9]{16,64}\z/D', $config['appId']) !== 1
            || !is_string($config['cacheDirectory'] ?? null)
            || $config['cacheDirectory'] === '' || str_contains($config['cacheDirectory'], "\0")
            || !extension_loaded('openssl') || ($fetcher === null && !extension_loaded('curl'))) {
            throw new FirebaseAuthException(503);
        }
        try {
            assertPrivateStoragePath($config['cacheDirectory']);
        } catch (Throwable) {
            throw new FirebaseAuthException(503);
        }
        $this->fetcher = $fetcher === null ? $this->fetchGoogleKeys(...) : Closure::fromCallable($fetcher);
        $this->clock = $clock === null ? time(...) : Closure::fromCallable($clock);
    }

    public function verify(string $idToken, string $appCheckToken): array
    {
        $now = ($this->clock)();
        $id = $this->verifyJwt($idToken, 'id', $now);
        if (($id['iss'] ?? null) !== 'https://securetoken.google.com/' . $this->config['projectId']
            || ($id['aud'] ?? null) !== $this->config['projectId']
            || !is_string($id['sub'] ?? null) || $id['sub'] === '' || strlen($id['sub']) > 128
            || preg_match('/[\x00-\x1f\x7f]/', $id['sub']) === 1
            || !is_int($id['auth_time'] ?? null) || $id['auth_time'] < 0 || $id['auth_time'] > $now
            || $id['auth_time'] > $id['iat']
            || ($id['firebase']['sign_in_provider'] ?? null) !== 'anonymous'
            || isset($id['firebase']['tenant'])) {
            throw new FirebaseAuthException();
        }
        $app = $this->verifyJwt($appCheckToken, 'app', $now);
        if (($app['iss'] ?? null) !== 'https://firebaseappcheck.googleapis.com/' . $this->config['projectNumber']
            || !is_array($app['aud'] ?? null) || !array_is_list($app['aud'])
            || !in_array('projects/' . $this->config['projectNumber'], $app['aud'], true)
            || ($app['sub'] ?? null) !== $this->config['appId']) {
            throw new FirebaseAuthException();
        }
        return ['uid' => $id['sub'], 'appId' => $app['sub']];
    }

    private function verifyJwt(string $token, string $kind, int $now): array
    {
        if (strlen($token) > 16384) {
            throw new FirebaseAuthException();
        }
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            throw new FirebaseAuthException();
        }
        try {
            $header = json_decode($this->decodeBase64Url($parts[0]), false, 16, JSON_THROW_ON_ERROR);
            $claims = json_decode($this->decodeBase64Url($parts[1]), false, 16, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new FirebaseAuthException();
        }
        if (!$header instanceof \stdClass || !$claims instanceof \stdClass
            || ($header->alg ?? null) !== 'RS256' || ($header->typ ?? null) !== 'JWT'
            || !is_string($header->kid ?? null) || preg_match('/\A[A-Za-z0-9_-]{1,128}\z/D', $header->kid) !== 1
            || property_exists($header, 'jku') || property_exists($header, 'x5u') || property_exists($header, 'crit')) {
            throw new FirebaseAuthException();
        }
        $claims = json_decode($this->decodeBase64Url($parts[1]), true, 16, JSON_THROW_ON_ERROR);
        if (!is_int($claims['exp'] ?? null) || !is_int($claims['iat'] ?? null)
            || $claims['iat'] < 0 || $claims['iat'] > $now || $claims['exp'] <= $now || $claims['exp'] <= $claims['iat']
            || (isset($claims['nbf']) && (!is_int($claims['nbf']) || $claims['nbf'] > $now))) {
            throw new FirebaseAuthException();
        }
        $keys = $this->loadKeys($kind, $now);
        if (!isset($keys[$header->kid])) {
            // Do not let arbitrary kid values force repeated Google fetches while the cache is fresh.
            throw new FirebaseAuthException();
        }
        $signature = $this->decodeBase64Url($parts[2]);
        $valid = @openssl_verify($parts[0] . '.' . $parts[1], $signature, $keys[$header->kid], OPENSSL_ALGO_SHA256);
        if ($valid !== 1) {
            throw new FirebaseAuthException();
        }
        return $claims;
    }

    private function decodeBase64Url(string $encoded): string
    {
        if ($encoded === '' || preg_match('/\A[A-Za-z0-9_-]+\z/D', $encoded) !== 1 || strlen($encoded) % 4 === 1) {
            throw new FirebaseAuthException();
        }
        $decoded = base64_decode(strtr($encoded, '-_', '+/'), true);
        if ($decoded === false || rtrim(strtr(base64_encode($decoded), '+/', '-_'), '=') !== $encoded) {
            throw new FirebaseAuthException();
        }
        return $decoded;
    }

    private function loadKeys(string $kind, int $now): array
    {
        if (isset($this->keys[$kind]) && $this->keys[$kind]['expiresAt'] > $now) {
            return $this->keys[$kind]['keys'];
        }
        $directory = $this->config['cacheDirectory'];
        $lock = null;
        try {
            if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
                throw new FirebaseAuthException(503);
            }
            assertPrivateStoragePath($directory);
            $path = $directory . '/' . $kind . '.json';
            $lockPath = $path . '.lock';
            if (is_link($path) || is_link($lockPath)) {
                throw new FirebaseAuthException(503);
            }
            $cached = $this->readCache($path, $now, $kind);
            if ($cached !== null) {
                $this->keys[$kind] = $cached;
                return $cached['keys'];
            }
            $mask = umask(0077);
            try {
                $lock = @fopen($lockPath, 'c');
            } finally {
                umask($mask);
            }
            // A concurrent cold fetch must not make a PHP worker wait without a bound.
            if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
                throw new FirebaseAuthException(503);
            }
            $cached = $this->readCache($path, $now, $kind);
            if ($cached === null) {
                $response = ($this->fetcher)($kind === 'id' ? self::ID_KEYS : self::APP_KEYS);
                if (!is_string($response['body'] ?? null) || strlen($response['body']) > self::MAX_RESPONSE_BYTES
                    || !is_int($response['maxAge'] ?? null) || $response['maxAge'] < 0) {
                    throw new FirebaseAuthException(503);
                }
                $keys = $this->parseKeys($response['body'], $kind);
                $ttl = min($response['maxAge'], self::MAX_CACHE_SECONDS);
                $cached = ['expiresAt' => $now + $ttl, 'keys' => $keys];
                if ($ttl > 0) {
                    $this->writeCache($path, ['expiresAt' => $cached['expiresAt'], 'body' => $response['body']]);
                }
            }
            $this->keys[$kind] = $cached;
            return $cached['keys'];
        } catch (Throwable) {
            throw new FirebaseAuthException(503);
        } finally {
            if (is_resource($lock)) {
                flock($lock, LOCK_UN);
                fclose($lock);
            }
        }
    }

    private function readCache(string $path, int $now, string $kind): ?array
    {
        if (!is_file($path)) {
            return null;
        }
        $contents = @file_get_contents($path, false, null, 0, self::MAX_RESPONSE_BYTES * 2 + 1);
        if ($contents === false || strlen($contents) > self::MAX_RESPONSE_BYTES * 2) {
            return null;
        }
        try {
            $entry = json_decode($contents, true, 8, JSON_THROW_ON_ERROR);
            if (!is_int($entry['expiresAt'] ?? null) || $entry['expiresAt'] <= $now
                || $entry['expiresAt'] > $now + self::MAX_CACHE_SECONDS
                || !is_string($entry['body'] ?? null) || strlen($entry['body']) > self::MAX_RESPONSE_BYTES) {
                return null;
            }
            return ['expiresAt' => $entry['expiresAt'], 'keys' => $this->parseKeys($entry['body'], $kind)];
        } catch (Throwable) {
            return null;
        }
    }

    private function writeCache(string $path, array $entry): void
    {
        $temporary = @tempnam(dirname($path), '.firebase-');
        if ($temporary === false) {
            throw new FirebaseAuthException(503);
        }
        try {
            if (!@chmod($temporary, 0600)
                || @file_put_contents($temporary, json_encode($entry, JSON_THROW_ON_ERROR), LOCK_EX) === false
                || !@rename($temporary, $path)) {
                throw new FirebaseAuthException(503);
            }
        } finally {
            if (is_file($temporary)) {
                @unlink($temporary);
            }
        }
    }

    private function parseKeys(string $body, string $kind): array
    {
        $document = json_decode($body, true, 16, JSON_THROW_ON_ERROR);
        $entries = $kind === 'id' ? $document : ($document['keys'] ?? null);
        if (!is_array($entries) || count($entries) < 1 || count($entries) > 64) {
            throw new FirebaseAuthException(503);
        }
        $keys = [];
        foreach ($entries as $index => $entry) {
            if ($kind === 'id') {
                $kid = $index;
                $pem = $entry;
            } else {
                if (!is_array($entry) || ($entry['kty'] ?? null) !== 'RSA'
                    || (isset($entry['alg']) && $entry['alg'] !== 'RS256')
                    || (isset($entry['use']) && $entry['use'] !== 'sig')
                    || !is_string($entry['n'] ?? null) || !is_string($entry['e'] ?? null)) {
                    throw new FirebaseAuthException(503);
                }
                $kid = $entry['kid'] ?? null;
                $pem = $this->jwkToPem($entry['n'], $entry['e']);
            }
            if (!is_string($kid) || preg_match('/\A[A-Za-z0-9_-]{1,128}\z/D', $kid) !== 1
                || isset($keys[$kid]) || !is_string($pem)) {
                throw new FirebaseAuthException(503);
            }
            $key = @openssl_pkey_get_public($pem);
            $details = $key === false ? false : openssl_pkey_get_details($key);
            if ($details === false || $details['type'] !== OPENSSL_KEYTYPE_RSA || $details['bits'] < 2048) {
                throw new FirebaseAuthException(503);
            }
            $keys[$kid] = $details['key'];
        }
        return $keys;
    }

    /** Encode the two unsigned JWK integers as an RSA SubjectPublicKeyInfo for OpenSSL. */
    private function jwkToPem(string $modulus, string $exponent): string
    {
        $integer = function (string $encoded): string {
            $bytes = ltrim($this->decodeBase64Url($encoded), "\0");
            if ($bytes === '' || strlen($bytes) > 1024) {
                throw new FirebaseAuthException(503);
            }
            if (ord($bytes[0]) > 127) {
                $bytes = "\0" . $bytes;
            }
            return $this->der(0x02, $bytes);
        };
        $rsa = $this->der(0x30, $integer($modulus) . $integer($exponent));
        $algorithm = hex2bin('300d06092a864886f70d0101010500');
        $spki = $this->der(0x30, $algorithm . $this->der(0x03, "\0" . $rsa));
        return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
    }

    private function der(int $tag, string $bytes): string
    {
        $length = strlen($bytes);
        if ($length < 128) {
            return chr($tag) . chr($length) . $bytes;
        }
        $encoded = '';
        while ($length > 0) {
            $encoded = chr($length & 255) . $encoded;
            $length >>= 8;
        }
        return chr($tag) . chr(128 | strlen($encoded)) . $encoded . $bytes;
    }

    /** Fixed HTTPS destinations, verified TLS, no redirects, five-second total budget and 256 KiB cap. */
    private function fetchGoogleKeys(string $url): array
    {
        if ($url !== self::ID_KEYS && $url !== self::APP_KEYS) {
            throw new FirebaseAuthException(503);
        }
        $handle = curl_init($url);
        $body = '';
        $headers = [];
        $headerBytes = 0;
        curl_setopt_array($handle, [
            CURLOPT_CONNECTTIMEOUT_MS => 3000,
            CURLOPT_TIMEOUT_MS => 5000,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HTTPHEADER => ['Accept: application/json'],
            CURLOPT_PROXY => '',
            CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$headers, &$headerBytes): int {
                $headerBytes += strlen($line);
                if ($headerBytes > 16384) {
                    return 0;
                }
                $headers[] = $line;
                return strlen($line);
            },
            CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$body): int {
                if (strlen($body) + strlen($chunk) > self::MAX_RESPONSE_BYTES) {
                    return 0;
                }
                $body .= $chunk;
                return strlen($chunk);
            },
        ]);
        if (curl_exec($handle) === false || curl_getinfo($handle, CURLINFO_RESPONSE_CODE) !== 200) {
            throw new FirebaseAuthException(503);
        }
        $maxAge = 0;
        $age = 0;
        foreach ($headers as $header) {
            if (preg_match('/\ACache-Control:\s*.*\bmax-age=(\d+)/i', $header, $match) === 1) {
                $maxAge = min((int) $match[1], self::MAX_CACHE_SECONDS);
            }
            if (preg_match('/\AAge:\s*(\d+)\s*\z/i', $header, $match) === 1) {
                $age = (int) $match[1];
            }
        }
        return ['body' => $body, 'maxAge' => max(0, $maxAge - $age)];
    }
}
