#!/bin/bash
# Managed by sureneco encrypted backup installer.
# Usage (root): bash install-vps-backup.sh prepare
#               bash install-vps-backup.sh enable /absolute/path/to/verified_known_hosts
# Bundle vps-backup.sh and publish-backup-status.sh beside this script, and all
# three systemd units beside it or in ../server/.
# Export /etc/sureneco-backup/password securely off this VPS before enable; never print it.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset RESTIC_PASSWORD RESTIC_PASSWORD_COMMAND RESTIC_REPOSITORY RESTIC_REPOSITORY_FILE RESTIC_KEY_HINT RESTIC_OPTIONS
readonly config=/etc/sureneco-backup
readonly repository=sftp:sureneco-backup@141.147.175.12:/data/repository
readonly marker='# Managed by sureneco encrypted backup installer.'
fail() { printf '%s\n' "Backup setup failed: $*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'root is required.'
[[ $# == 1 && $1 == prepare || $# == 2 && $1 == enable && $2 == /* ]] || fail 'usage: prepare | enable /absolute/path/to/verified_known_hosts'
readonly phase=$1
exec 9>/run/sureneco-backup.lock
flock -n 9 || fail 'another backup or installation is running.'
# This installer targets the existing Ubuntu/systemd production layout, not arbitrary hosts.
[[ -d /run/systemd/system && -x /usr/bin/node && -x /usr/bin/ssh && -x /usr/bin/sftp ]] || fail 'systemd, Node.js and OpenSSH client are required.'
if ! command -v restic >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends restic
fi
for command in restic ssh-keygen flock cp find install od timeout date mktemp stat sftp; do
    command -v "$command" >/dev/null || fail 'a required system tool is unavailable.'
done
safe_directory() {
    local directory=$1
    [[ ! -L $directory ]] || fail 'refusing symlink directory.'
    if [[ -e $directory ]]; then
        [[ -d $directory && $(stat -c '%u:%g:%a' "$directory") == 0:0:700 ]] || fail 'existing private directory is not root:root mode 700.'
    else
        mkdir -m 700 "$directory"
    fi
}
safe_file() {
    [[ -f $1 && ! -L $1 && $(stat -c '%u:%g:%a:%h' "$1") == 0:0:600:1 && -s $1 ]] || fail 'existing private file is not root:root mode 600, single-link and nonempty.'
}
safe_directory "$config"
safe_directory /var/lib/sureneco-backup
safe_directory /var/lib/sureneco-backup/cache
work=$(mktemp -d "$config/.setup.XXXXXXXX")
trap 'rm -rf --one-file-system -- "$work"' EXIT
trap 'exit 1' HUP INT TERM
if [[ -e $config/backup.env || -L $config/backup.env ]]; then
    safe_file "$config/backup.env"
    [[ $(cat "$config/backup.env") == "RESTIC_REPOSITORY=$repository" ]] || fail 'refusing to change an existing repository configuration.'
else
    (set -o noclobber; printf 'RESTIC_REPOSITORY=%s\n' "$repository" >"$config/backup.env")
fi
if [[ -e $config/password || -L $config/password ]]; then
    safe_file "$config/password"
else
    # Random 256-bit recovery secret, never emitted to the terminal or journal.
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$work/password"
    printf '\n' >>"$work/password"
    [[ $(wc -c <"$work/password") == 65 ]] || fail 'password generation failed.'
    (set -o noclobber; cat "$work/password" >"$config/password")
fi
if [[ -e $config/id_ed25519 || -L $config/id_ed25519 ]]; then
    safe_file "$config/id_ed25519"
    ssh-keygen -y -P '' -f "$config/id_ed25519" >"$work/key.pub" 2>/dev/null || fail 'existing SSH key is invalid or requires a passphrase.'
    [[ $(cut -d ' ' -f 1 "$work/key.pub") == ssh-ed25519 ]] || fail 'existing dedicated key is not ed25519.'
else
    [[ ! -e $config/id_ed25519.pub && ! -L $config/id_ed25519.pub ]] || fail 'orphaned SSH public key exists; resolve manually without replacing credentials.'
    ssh-keygen -q -t ed25519 -N '' -C sureneco-backup -f "$work/id_ed25519"
    (set -o noclobber; cat "$work/id_ed25519" >"$config/id_ed25519")
    ssh-keygen -y -P '' -f "$config/id_ed25519" >"$work/key.pub"
fi
if [[ -e $config/id_ed25519.pub || -L $config/id_ed25519.pub ]]; then
    safe_file "$config/id_ed25519.pub"
    [[ $(cut -d ' ' -f 1-2 "$config/id_ed25519.pub") == "$(cut -d ' ' -f 1-2 "$work/key.pub")" ]] || fail 'existing public/private keys do not match.'
else
    (set -o noclobber; cat "$work/key.pub" >"$config/id_ed25519.pub")
fi
readonly public=/home/sureneco/sureneco-backup.pub
[[ -d /home/sureneco && ! -L /home/sureneco && $(stat -c '%U' /home/sureneco) == sureneco ]] || fail 'expected sureneco home is unavailable.'
if [[ -e $public || -L $public ]]; then
    [[ -f $public && ! -L $public && $(stat -c %h "$public") == 1 ]] || fail 'unsafe published public-key path.'
    [[ $(cut -d ' ' -f 1-2 "$public") == "$(cut -d ' ' -f 1-2 "$work/key.pub")" ]] || fail 'refusing to overwrite an unrelated published public key.'
else
    # Open exclusively and change ownership through the fd: the home is user-writable.
    /usr/bin/node --input-type=commonjs - "$public" "$work/key.pub" "$(id -u sureneco)" "$(id -g sureneco)" <<'NODE'
const fs = require('node:fs');
const fd = fs.openSync(process.argv[2], fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
try {
  fs.writeFileSync(fd, fs.readFileSync(process.argv[3]));
  fs.fchownSync(fd, Number(process.argv[4]), Number(process.argv[5]));
  fs.fchmodSync(fd, 0o644);
} finally { fs.closeSync(fd); }
NODE
fi
if [[ $phase == prepare ]]; then
    printf '%s\n' 'Prepared. Public key: /home/sureneco/sureneco-backup.pub' 'Install that public key on the restricted backup destination, pin its verified host key, and securely export the recovery password off this VPS before enable.'
    exit 0
fi
# Only accept a dedicated, preverified ed25519 host key, never opportunistic ssh-keyscan output.
known=$2
[[ -f $known && ! -L $known ]] || fail 'verified known_hosts must be a regular file.'
/usr/bin/node --input-type=commonjs - "$known" <<'NODE'
const fs = require('node:fs');
try {
  const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
  if (lines.length !== 1 || !/^141\.147\.175\.12 ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(lines[0])) throw Error();
} catch { console.error('Backup setup failed: expected exactly one verified 141.147.175.12 ed25519 known_hosts entry.'); process.exit(1); }
NODE
if [[ -e $config/known_hosts || -L $config/known_hosts ]]; then
    safe_file "$config/known_hosts"
    cmp -s "$known" "$config/known_hosts" || fail 'refusing to replace a pinned host key; resolve rotation manually.'
else
    (set -o noclobber; cat "$known" >"$config/known_hosts")
fi
readonly ssh_command='ssh -F /dev/null -i /etc/sureneco-backup/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/sureneco-backup/known_hosts -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 sureneco-backup@141.147.175.12 -s sftp'
export RESTIC_REPOSITORY=$repository RESTIC_PASSWORD_FILE=$config/password RESTIC_CACHE_DIR=/var/lib/sureneco-backup/cache
if ! restic -o "sftp.command=$ssh_command" snapshots --json >/dev/null 2>"$work/repository-error"; then
    # A successful mkdir proves the repository directory was absent and SFTP authenticated.
    # Existing/empty/corrupt repositories, wrong passwords, network and auth failures NEVER init.
    if ! printf 'mkdir /data/repository\n' | sftp -q -b - -F /dev/null -i "$config/id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$config/known_hosts" -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 sureneco-backup@141.147.175.12 >"$work/sftp-output" 2>&1; then
        fail 'cannot open repository, or repository directory already exists; no initialization attempted. Check destination, credentials and repository password.'
    fi
    restic -o "sftp.command=$ssh_command" init || fail 'initialization failed; repository directory preserved for manual inspection.'
fi
restic -o "sftp.command=$ssh_command" snapshots --json >/dev/null || fail 'repository validation failed.'
base=$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")
units=$base/../server
[[ -f $units/sureneco-backup.service && -f $units/sureneco-backup.timer && -f $units/sureneco-backup-status@.service ]] || units=$base
for file in "$base/vps-backup.sh" "$base/publish-backup-status.sh" "$units/sureneco-backup.service" "$units/sureneco-backup.timer" "$units/sureneco-backup-status@.service"; do
    [[ -f $file && ! -L $file ]] || fail 'bundle requires both runtime scripts and all three systemd units.'
    # A staged bundle is operator-supplied; the marker also protects unrelated installed paths.
    /usr/bin/node -e 'const fs=require("node:fs");if(!fs.readFileSync(process.argv[1],"utf8").split("\n").slice(0,2).includes(process.argv[2]))process.exit(1)' "$file" "$marker" || fail 'unrecognized installation bundle.'
done
managed_install() {
    local source=$1 target=$2 mode=$3
    if [[ -e $target || -L $target ]]; then
        [[ -f $target && ! -L $target && $(stat -c '%u:%h' "$target") == 0:1 ]] || fail 'unsafe existing installation target.'
        /usr/bin/node -e 'const fs=require("node:fs");if(!fs.readFileSync(process.argv[1],"utf8").split("\n").slice(0,2).includes(process.argv[2]))process.exit(1)' "$target" "$marker" || fail 'refusing to overwrite an unrelated installed file.'
    fi
    install -o root -g root -m "$mode" "$source" "$target"
}
# The installed runtime is self-contained and independent of this staging bundle.
managed_install "$base/vps-backup.sh" /usr/local/sbin/sureneco-backup 700
managed_install "$base/publish-backup-status.sh" /usr/local/sbin/sureneco-backup-status 700
managed_install "$units/sureneco-backup.service" /etc/systemd/system/sureneco-backup.service 644
managed_install "$units/sureneco-backup.timer" /etc/systemd/system/sureneco-backup.timer 644
managed_install "$units/sureneco-backup-status@.service" /etc/systemd/system/sureneco-backup-status@.service 644
systemctl daemon-reload
# Release the installation lock before the service acquires the same root-only lock.
flock -u 9
systemctl start sureneco-backup.service || fail 'first backup failed; timer was not enabled by this invocation.'
[[ $(systemctl show sureneco-backup.service -p Result --value) == success ]] || fail 'first backup did not succeed; timer was not enabled.'
systemctl enable --now sureneco-backup.timer
printf '%s\n' 'First encrypted backup succeeded. Daily 03:30 Asia/Tokyo persistent timer enabled.'
