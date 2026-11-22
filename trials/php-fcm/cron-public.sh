#!/bin/sh
# Install directly in the private public-service ROOT; tick owns public-run.lock.
umask 077
PATH=/usr/bin:/bin
export PATH
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
SURENECO_PHP_WORKER_BIN=$ROOT/bin/sureneco-php-worker
export SURENECO_PHP_WORKER_BIN
exec /usr/bin/timeout --kill-after=5 50 /usr/bin/php8.4 "$ROOT/php/bin/public-service.php" tick "$ROOT" </dev/null
