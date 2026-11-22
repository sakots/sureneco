<?php

declare(strict_types=1);

$assert = static function (bool $passed, string $label): void {
    if (!$passed) {
        throw new RuntimeException($label);
    }
};
$directory = sys_get_temp_dir() . '/sureneco-service-cli-' . bin2hex(random_bytes(8));
mkdir($directory, 0700);
mkdir($directory . '/php', 0700);
mkdir($directory . '/php/bin', 0700);
mkdir($directory . '/php/vendor', 0700);
copy(dirname(__DIR__) . '/bin/service.php', $directory . '/php/bin/service.php');
$run = static function (array $arguments, ?string $source = null) use ($directory, $assert): array {
    $process = proc_open(
        $source === null ? [PHP_BINARY, $directory . '/php/bin/service.php', ...$arguments] : [PHP_BINARY, '-r', $source],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes,
        $directory,
    );
    $assert(is_resource($process), 'CLI process starts');
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exit = proc_close($process);
    $assert($stderr === '', 'No runtime warnings or secret-bearing stderr');
    return [$exit, $stdout];
};
$json = static function (array $arguments, int $expectedExit) use ($run, $assert): array {
    [$exit, $stdout] = $run($arguments);
    $assert($exit === $expectedExit, 'Expected exit ' . $expectedExit);
    $result = json_decode($stdout, true, 512, JSON_THROW_ON_ERROR);
    $assert(is_array($result) && is_bool($result['ok']), 'One JSON result with boolean ok');
    return $result;
};

try {
    [$exit, $help] = $run(['--help']);
    $assert($exit === 0 && str_contains($help, 'ROOT') && str_contains($help, 'pause'), 'Help works without dependencies');
    foreach ([[], ['status'], ['unknown', $directory], ['tick', $directory, 'extra']] as $arguments) {
        $result = $json($arguments, 1);
        $assert($result['error'] === 'invalid_arguments', 'Reject missing root and invalid commands');
    }
    $result = $json(['status', $directory], 1);
    $assert($result['error'] === 'dependencies_missing', 'Missing autoload yields safe JSON');
    $json(['resume', $directory], 1);

    // Isolate consumer dispatch and exit semantics without network or credential access.
    file_put_contents($directory . '/php/vendor/autoload.php', <<<'PHP'
<?php
namespace Sureneco\FcmTrial;
final class PersistentMonitor
{
    public function __construct(private string $root) {}
    public function tick(): array { return $this->status(); }
    public function status(): array
    {
        $state = basename($this->root);
        if ($state === 'throw') {
            throw new \RuntimeException('SECRET_TOKEN /private/key.json');
        }
        if ($state === 'warn') {
            trigger_error('SECRET_TOKEN /private/key.json', E_USER_WARNING);
            throw new \RuntimeException('SECRET_TOKEN');
        }
        return ['status' => $state];
    }
}
PHP);
    foreach (['idle', 'running', 'paused', 'disabled'] as $status) {
        foreach (['status', 'tick'] as $operation) {
            $root = $directory . '/' . $status;
            $result = $json([$operation, $root], 0);
            $assert($result['ok'], 'Healthy and paused states are successful for cron');
        }
    }
    foreach (['degraded', 'error', 'stale'] as $status) {
        $result = $json(['status', $directory . '/' . $status], 1);
        $assert(!$result['ok'], 'Unhealthy state is nonzero');
    }
    foreach (['throw', 'warn'] as $status) {
        $result = $json(['tick', $directory . '/' . $status], 1);
        $assert($result['error'] === 'runtime_failure' && !str_contains(json_encode($result), 'SECRET_TOKEN'), 'Unexpected failures redact secrets');
    }
    file_put_contents($directory . '/php/vendor/autoload.php', '<?php require ' . var_export(dirname(__DIR__) . '/vendor/autoload.php', true) . ';');
    mkdir($directory . '/state', 0700);
    file_put_contents($directory . '/config.json', json_encode(['enabled' => false, 'filter' => 'loose', 'thread_refresh_sec' => 300]));
    chmod($directory . '/config.json', 0600);
    $json(['pause', $directory], 0);
    $resumed = $json(['resume', $directory], 0);
    $assert($resumed['enabled'] && $resumed['status'] === 'stale', 'Resume succeeds while waiting for its first cron cycle');
    $json(['status', $directory], 1);
    mkdir($directory . '/secrets', 0700);
    $provisioned = $json(['provision-selection', $directory], 0);
    $auth = $directory . '/secrets/selection-auth.json';
    $secret = json_decode(file_get_contents($auth), true, 8, JSON_THROW_ON_ERROR)['token'];
    $assert($provisioned === ['ok' => true, 'operation' => 'provision-selection', 'status' => 'provisioned']
        && !str_contains(json_encode($provisioned), $secret), 'Provisioning never outputs the generated token');
    $front = dirname(__DIR__) . '/public/selection.php';
    $web = static function (array $server) use ($run, $directory, $front, $assert): array {
        $server += ['DOCUMENT_ROOT' => $directory . '/php/bin', 'REQUEST_METHOD' => 'GET'];
        $code = '$_SERVER = ' . var_export($server, true) . '; putenv(' . var_export('SURENECO_PHP_ROOT=' . $directory, true) . ');'
            . 'register_shutdown_function(static function (): void { echo "\n", http_response_code(); });'
            . 'require ' . var_export($front, true) . ';';
        [$exit, $output] = $run([], $code);
        $assert($exit === 0, 'Public script exits without leaking a runtime failure');
        [$body, $status] = explode("\n", $output, 2);
        return [(int) $status, json_decode($body, true, 8, JSON_THROW_ON_ERROR)];
    };
    $assert($web(['HTTP_X_FORWARDED_PROTO' => 'https']) === [403, ['error' => 'https_required']],
        'Client-supplied forwarding headers cannot authorize plaintext HTTP');
    $assert($web(['HTTPS' => 'on']) === [401, ['error' => 'unauthorized']], 'HTTPS still requires bearer authentication');
    $request = ['HTTPS' => 'on', 'HTTP_AUTHORIZATION' => 'Bearer ' . $secret];
    $assert($web($request) === [200, ['threads' => []]], 'Public script can use a private root configured by the web environment');
    $assert($web($request + ['DOCUMENT_ROOT' => dirname($directory)]) === [503, ['error' => 'unavailable']],
        'Public script rejects a root within the document root');
    echo "Service CLI consumer tests passed\n";
} finally {
    unlink($directory . '/php/bin/service.php');
    if (is_file($directory . '/php/vendor/autoload.php')) {
        unlink($directory . '/php/vendor/autoload.php');
    }
    rmdir($directory . '/php/vendor');
    rmdir($directory . '/php/bin');
    rmdir($directory . '/php');
    foreach (glob($directory . '/state/*') ?: [] as $file) unlink($file);
    if (is_dir($directory . '/state')) rmdir($directory . '/state');
    if (is_dir($directory . '/secrets')) {
        foreach (glob($directory . '/secrets/*') ?: [] as $file) unlink($file);
        rmdir($directory . '/secrets');
    }
    if (is_file($directory . '/config.json')) unlink($directory . '/config.json');
    rmdir($directory);
}
