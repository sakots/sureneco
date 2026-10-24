#!/bin/bash
# Managed by sureneco encrypted backup installer.
# This independent outcome channel never reads the repository encryption password.
set +x
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
# Do not expose private paths, SSH diagnostics, or credentials to the journal.
exec 3>&2
exec >/dev/null 2>&1
work=
cleanup() {
    result=$?
    trap - EXIT
    if [[ -n $work ]]; then rm -rf --one-file-system -- "$work" || result=1; fi
    if (( result != 0 )); then printf 'Backup outcome publication failed (exit %s).\n' "$result" >&3; fi
    exit "$result"
}
trap cleanup EXIT
[[ $EUID == 0 && $# == 1 ]] || exit 1
case $1 in success|failure) readonly outcome=$1 ;; *) exit 1 ;; esac
readonly config=/etc/sureneco-backup
readonly runtime=/run/sureneco-backup-status
[[ -d $config && ! -L $config && $(stat -c '%u:%g:%a' "$config") == 0:0:700 ]] || exit 1
for file in id_ed25519 known_hosts; do
    [[ -f $config/$file && ! -L $config/$file && $(stat -c '%u:%g:%a:%h' "$config/$file") == 0:0:600:1 && -s $config/$file ]] || exit 1
done
# The template preserves this root-only directory between instances so all
# publishers use the same lock, including overlapping success/failure handlers.
if [[ ! -e $runtime && ! -L $runtime ]]; then
    mkdir -m 700 "$runtime" || [[ -d $runtime ]]
fi
[[ -d $runtime && ! -L $runtime && $(stat -c '%u:%g:%a' "$runtime") == 0:0:700 ]] || exit 1
if [[ -e $runtime/publish.lock || -L $runtime/publish.lock ]]; then
    [[ -f $runtime/publish.lock && ! -L $runtime/publish.lock && $(stat -c '%u:%g:%a:%h' "$runtime/publish.lock") == 0:0:600:1 ]] || exit 1
fi
exec 9>"$runtime/publish.lock"
flock -w 10 9 || exit 1
work=$(mktemp -d "$runtime/publish.XXXXXXXX")
trap 'exit 1' HUP INT TERM
now=$(date +%s.%N)
[[ $now =~ ^[0-9]+\.[0-9]+$ ]] || exit 1
printf '{"version":1,"outcome":"%s","time":%s}\n' "$outcome" "$now" >"$work/status.json"
# A partial upload can only affect pending. OpenSSH's atomic rename extension
# replaces the published file only after put and chmod both succeed.
printf 'put %s /data/backup-status.pending\nchmod 600 /data/backup-status.pending\nrename /data/backup-status.pending /data/backup-status.json\n' "$work/status.json" >"$work/batch"
timeout --signal=TERM --kill-after=5s 40s /usr/bin/sftp -q -b "$work/batch" -F /dev/null \
    -i "$config/id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$config/known_hosts" \
    -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=10 \
    -o ServerAliveInterval=10 -o ServerAliveCountMax=2 \
    sureneco-backup@141.147.175.12
