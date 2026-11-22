#!/bin/sh
# Install directly in the private deployment ROOT; class tick owns run.lock.
umask 077
PATH=/usr/bin:/bin
export PATH
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
SURENECO_PHP_WORKER_BIN=$ROOT/bin/sureneco-php-worker
export SURENECO_PHP_WORKER_BIN
exec /usr/bin/timeout 180 /usr/bin/php8.4 "$ROOT/php/bin/service.php" tick "$ROOT" </dev/null
