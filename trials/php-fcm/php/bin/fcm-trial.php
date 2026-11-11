<?php

declare(strict_types=1);

// Suppress PHP's default exception/warning output: credential-bearing requests must never be logged.
ini_set('display_errors', '0');
ini_set('log_errors', '0');
error_reporting(E_ALL);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"ok":false,"operation":null,"status":"error","error":"cli_only"}' . PHP_EOL;
    exit(1);
}

set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if ((error_reporting() & $severity) === 0) {
        return false;
    }
    throw new ErrorException('php_runtime_error', 0, $severity);
});

$operation = null;
try {
    $autoload = dirname(__DIR__) . '/vendor/autoload.php';
    if (!is_file($autoload)) {
        echo '{"ok":false,"operation":null,"status":"error","error":"dependencies_missing"}' . PHP_EOL;
        exit(1);
    }
    require $autoload;

    $usage = 'php trials/php-fcm/php/bin/fcm-trial.php auth|validate|validate-topic|send '
        . '--credentials=/private/path/or/- --client-config=/path/google-services.json '
        . '[--registration-token-file=/private/path]';
    if (count($argv) === 2 && $argv[1] === '--help') {
        echo json_encode([
            'ok' => true,
            'usage' => $usage,
            'operations' => [
                'auth' => 'Real Google OAuth authentication only; no FCM request.',
                'validate' => 'Real FCM validate_only with the required private receiver token file; no delivery.',
                'validate-topic' => 'Real FCM validate_only with a fresh unsubscribed random topic; no token file, no delivery.',
                'send' => 'One real FCM request to the required private receiver token file; acceptance is not device receipt.',
            ],
        ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . PHP_EOL;
        exit(0);
    }
    if (!isset($argv[1]) || !in_array($argv[1], \Sureneco\FcmTrial\Configuration::OPERATIONS, true)) {
        throw new \Sureneco\FcmTrial\SafeFailure('invalid_operation');
    }
    $operation = $argv[1];
    $options = [];
    foreach (array_slice($argv, 2) as $argument) {
        if (preg_match('/^--(credentials|client-config|registration-token-file)=(.+)$/D', $argument, $match) !== 1
            || array_key_exists($match[1], $options)) {
            throw new \Sureneco\FcmTrial\SafeFailure('invalid_arguments');
        }
        $options[$match[1]] = $match[2];
    }
    if (!isset($options['credentials'])) {
        throw new \Sureneco\FcmTrial\SafeFailure('credentials_required');
    }
    if (!isset($options['client-config'])) {
        throw new \Sureneco\FcmTrial\SafeFailure('client_config_required');
    }
    $configuration = \Sureneco\FcmTrial\Configuration::load(
        $operation,
        $options['credentials'],
        $options['client-config'],
        $options['registration-token-file'] ?? null,
    );
    $result = (new \Sureneco\FcmTrial\Sender())->run($configuration);
    echo json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . PHP_EOL;
    exit(0);
} catch (\Sureneco\FcmTrial\SafeFailure $error) {
    echo json_encode($error->result($operation), JSON_UNESCAPED_SLASHES) . PHP_EOL;
    exit(1);
} catch (Throwable) {
    echo json_encode([
        'ok' => false,
        'operation' => $operation,
        'status' => 'error',
        'error' => 'runtime_failure',
    ], JSON_UNESCAPED_SLASHES) . PHP_EOL;
    exit(1);
}
