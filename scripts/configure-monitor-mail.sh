#!/usr/bin/env bash
# Managed by sureneco Gmail monitoring setup.
# Enter the Google APP password on the operator's terminal, never in argv or chat.
set +x
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'root is required'
[[ $# -eq 0 || ( $# -eq 1 && $1 == --replace ) ]] || fail 'usage: configure-monitor-mail.sh [--replace]'
[[ -r /dev/tty && -w /dev/tty ]] || fail 'an interactive SSH terminal is required'
exec 9>/run/sureneco-monitor-credential.lock
flock -n 9 || fail 'another credential change is running'
config=/etc/sureneco-monitor
target=$config/gmail-app-password
if [[ -e $config || -L $config ]]; then
    [[ -d $config && ! -L $config && $(stat -c '%u:%g:%a' "$config") == 0:0:700 ]] || fail 'unsafe monitor configuration directory'
else
    install -d -o root -g root -m 0700 "$config"
fi
if [[ -e $target || -L $target ]]; then
    [[ ${1-} == --replace ]] || fail 'credential already exists; use --replace explicitly to rotate it'
    [[ -f $target && ! -L $target && $(stat -c '%u:%g:%a:%h' "$target") == 0:0:600:1 ]] || fail 'unsafe existing credential file'
fi
work=$(mktemp -d "$config/.credential.XXXXXXXX")
cleanup() { unset password; rm -rf -- "$work"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
IFS= read -r -s -p 'Google app password (16 characters; input hidden): ' password < /dev/tty || fail 'credential entry cancelled'
printf '\n' > /dev/tty
password=${password// /}
[[ $password =~ ^[A-Za-z0-9]{16}$ ]] || fail 'expected the 16-character Google app password, not the normal account password'
printf '%s\n' "$password" > "$work/password"
unset password
chmod 0600 "$work/password"
mv -T -- "$work/password" "$target"
printf '%s\n' 'Gmail app password saved with root-only access. No email sent and no timer enabled by this command.'
