<?php

declare(strict_types=1);

namespace Sureneco;

use PDO;
use RuntimeException;

function assertPrivateStoragePath(string $path): void
{
    $absolute = str_starts_with($path, '/') ? $path : getcwd() . '/' . $path;
    $parts = [];
    foreach (explode('/', $absolute) as $part) {
        if ($part === '' || $part === '.') {
            continue;
        }
        if ($part === '..') {
            array_pop($parts);
        } else {
            $parts[] = $part;
        }
    }

    $public = realpath(__DIR__ . '/public');
    if ($public === false) {
        throw new RuntimeException('Public root is unavailable.');
    }
    foreach (['/' . implode('/', $parts), realpath($path), realpath(dirname($path))] as $candidate) {
        if ($candidate !== false && ($candidate === $public || str_starts_with($candidate, $public . '/'))) {
            throw new RuntimeException('Storage must be outside the public root.');
        }
    }
}

/** Open the persistent SQLite database shared by the web request and CLI worker. */
function openDatabase(): PDO
{
    $configured = getenv('SURENECO_SERVER_DB');
    $path = $configured === false ? __DIR__ . '/data/monitor.sqlite' : $configured;
    if ($path === '' || $path === ':memory:' || str_contains($path, "\0")) {
        throw new RuntimeException('A persistent database file is required.');
    }
    assertPrivateStoragePath($path);

    $directory = dirname($path);
    if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
        throw new RuntimeException('Database directory is unavailable.');
    }
    assertPrivateStoragePath($path);
    $canonicalDirectory = realpath($directory);
    $canonicalPath = realpath($path);
    if ($canonicalDirectory === false || (is_link($path) && $canonicalPath === false)) {
        throw new RuntimeException('Database path is unavailable.');
    }
    $canonicalPath = $canonicalPath === false ? $canonicalDirectory . '/' . basename($path) : $canonicalPath;
    assertPrivateStoragePath($canonicalPath);

    $mask = umask(0077);
    try {
        $database = new PDO('sqlite:' . $canonicalPath, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_TIMEOUT => 5,
        ]);
    } finally {
        umask($mask);
    }
    $database->exec('
        CREATE TABLE IF NOT EXISTS worker_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            last_started_at INTEGER NOT NULL DEFAULT 0,
            last_finished_at INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO worker_state (id) VALUES (1);
    ');

    return $database;
}

/** The fixed lock file follows the canonical SQLite path; never unlink it. */
function workerLockPath(PDO $database): string
{
    $databases = $database->query('PRAGMA database_list')->fetchAll();
    foreach ($databases as $entry) {
        if ($entry['name'] !== 'main') {
            continue;
        }
        $canonicalPath = realpath($entry['file']);
        if ($canonicalPath === false) {
            break;
        }
        $lockPath = $canonicalPath . '.worker-lock';
        assertPrivateStoragePath($lockPath);
        if (is_link($lockPath)) {
            throw new RuntimeException('Worker lock must not be a symbolic link.');
        }
        return $lockPath;
    }
    throw new RuntimeException('Persistent database path is unavailable.');
}

function workerStatus(PDO $database): array
{
    $state = $database->query('SELECT last_started_at, last_finished_at FROM worker_state WHERE id = 1')->fetch();
    if ($state === false) {
        throw new RuntimeException('Worker status is unavailable.');
    }
    return [
        'lastStartedAt' => (int) $state['last_started_at'],
        'lastFinishedAt' => (int) $state['last_finished_at'],
        'monitoringReady' => false,
    ];
}
