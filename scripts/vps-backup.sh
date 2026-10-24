#!/bin/bash
# Managed by sureneco encrypted backup installer.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset RESTIC_PASSWORD RESTIC_PASSWORD_COMMAND RESTIC_REPOSITORY RESTIC_REPOSITORY_FILE RESTIC_KEY_HINT RESTIC_OPTIONS
readonly config=/etc/sureneco-backup
readonly state=/var/lib/sureneco-backup
readonly stage=$state/snapshot
readonly recovery=sureneco-backup-recovery
readonly repository=sftp:sureneco-backup@141.147.175.12:/data/repository
readonly ssh_command='ssh -F /dev/null -i /etc/sureneco-backup/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/sureneco-backup/known_hosts -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 sureneco-backup@141.147.175.12 -s sftp'
readonly -a writers=(sureneco.service sureneco-ntfy-admin.service ntfy.service)
fail() { printf '%s\n' "Backup failed: $*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'root is required.'
[[ ${INVOCATION_ID:-} && $(systemctl show sureneco-backup.service -p MainPID --value) == $$ ]] || fail 'run with systemctl start sureneco-backup.service.'
exec 9>/run/sureneco-backup.lock
flock -n 9 || fail 'another backup or installation is running.'
[[ -d $config && ! -L $config && $(stat -c '%u:%g:%a' "$config") == 0:0:700 ]] || fail 'unsafe configuration directory.'
for file in backup.env password id_ed25519 known_hosts; do
    [[ -f $config/$file && ! -L $config/$file && $(stat -c '%u:%g:%a:%h' "$config/$file") == 0:0:600:1 && -s $config/$file ]] || fail 'unsafe or missing credential/configuration file.'
done
[[ $(cat "$config/backup.env") == "RESTIC_REPOSITORY=$repository" ]] || fail 'unsupported repository configuration.'
export RESTIC_REPOSITORY=$repository RESTIC_PASSWORD_FILE=$config/password
export RESTIC_CACHE_DIR=$state/cache
for directory in "$state" "$state/cache"; do
    [[ ! -L $directory ]] || fail 'unsafe staging/cache directory.'
    if [[ -e $directory ]]; then
        [[ -d $directory && $(stat -c '%u:%g:%a' "$directory") == 0:0:700 ]] || fail 'unsafe staging/cache permissions.'
    else
        mkdir -m 700 "$directory"
    fi
done
# A repository/authentication failure must be discovered before interrupting production.
restic -o "sftp.command=$ssh_command" snapshots --json >/dev/null || fail 'repository cannot be opened; no production services were stopped.'
for service in "${writers[@]}"; do
    systemctl is-active --quiet "$service" || fail 'all three production writer services must be active.'
    [[ -z $(systemctl show "$service" -p Environment --value) ]] || fail 'service Environment overrides are unsupported; keep configuration in captured files.'
    [[ -z $(systemctl show "$service" -p PassEnvironment --value) ]] || fail 'inherited service environment overrides are unsupported.'
done
all_writers_active() {
    local service
    for service in "${writers[@]}"; do
        systemctl is-active --quiet "$service" || return 1
    done
}
# Reject external DB/key locations instead of silently omitting them. Never execute env files.
/usr/bin/node --input-type=commonjs <<'NODE'
const fs = require('node:fs');
const cp = require('node:child_process');
function fail() { throw new Error('unsupported production configuration or uncaptured data/key path'); }
const roots = ['/var/lib/sureneco', '/var/lib/ntfy', '/etc/sureneco', '/etc/ntfy', '/etc/nginx', '/etc/letsencrypt', '/opt/sureneco'];
function captured(p, directory = false) {
  if (!p || !p.startsWith('/') || p.includes('\n')) fail();
  const actual = fs.realpathSync(p);
  if (!roots.some(root => actual === root || actual.startsWith(root + '/'))) fail();
  const stat = fs.statSync(actual);
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail();
}
function scalar(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  if (!s || /[\s\\$`"']/.test(s)) fail();
  return s;
}
function env(path) {
  const out = {};
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(out, match[1])) fail();
    out[match[1]] = scalar(match[2]);
  }
  return out;
}
try {
  for (const root of roots) if (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory()) fail();
  const app = env('/etc/sureneco/server.env');
  captured(app.SURENECO_SERVER_DB);
  captured(app.SURENECO_VAPID_FILE);
  const admin = env('/etc/sureneco/ntfy-admin.env');
  if (admin.SURENECO_NTFY_CONFIG !== '/etc/ntfy/server.yml' || admin.SURENECO_NTFY_BIN !== '/usr/bin/ntfy') fail();
  const yaml = fs.readFileSync('/etc/ntfy/server.yml', 'utf8');
  const paths = {};
  for (const line of yaml.split('\n')) {
    const match = /^([a-z][a-z-]*(?:file|dir)):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    if (Object.hasOwn(paths, match[1])) fail();
    paths[match[1]] = scalar(match[2]);
    captured(paths[match[1]], match[1].endsWith('dir'));
  }
  if (!paths['cache-file'] || !paths['auth-file']) fail();
  const expected = {
    'sureneco.service': ['/etc/sureneco/server.env', '/usr/bin/node /opt/sureneco/dist/server/main.mjs'],
    'sureneco-ntfy-admin.service': ['/etc/sureneco/ntfy-admin.env', '/usr/bin/node /opt/sureneco/dist/server/ntfy-admin-main.mjs'],
    'ntfy.service': ['', '/usr/bin/ntfy serve --no-log-dates']
  };
  for (const [service, [envFile, command]] of Object.entries(expected)) {
    const show = key => cp.execFileSync('/usr/bin/systemctl', ['show', service, '-p', key, '--value'], {encoding:'utf8'}).trim();
    const files = show('EnvironmentFiles');
    if (envFile ? !new RegExp('^' + envFile.replaceAll('.', '\\.') + '\\s*\\(ignore_errors=(yes|no)\\)$').test(files) : files !== '') fail();
    const start = show('ExecStart');
    if (!start.includes('argv[]=' + command + ' ;') || start.split('argv[]=').length !== 2) fail();
    if (show('ExecStartPre') || show('ExecStartPost') || show('ExecStopPost')) fail();
  }
} catch { console.error('Backup failed: unsupported production configuration or uncaptured data/key path.'); process.exit(1); }
NODE
sources=(/var/lib/sureneco /var/lib/ntfy /etc/sureneco /etc/ntfy /etc/nginx /etc/letsencrypt /opt/sureneco)
for service in "${writers[@]}" nginx.service; do
    fragment=$(systemctl show "$service" -p FragmentPath --value)
    [[ $fragment == /* && -f $fragment && $fragment != *[[:space:]]* ]] || fail 'missing or unsupported service definition.'
    sources+=("$fragment")
    drops=$(systemctl show "$service" -p DropInPaths --value)
    for drop in $drops; do
        [[ $drop == /* && -f $drop && $drop != *\\* ]] || fail 'unsupported service drop-in path.'
        sources+=("$drop")
    done
done
# Never reuse a copied tree: cp may otherwise traverse a symlink planted in an old copy.
rm -rf --one-file-system -- "$stage"
mkdir -m 700 "$stage"
recovery_armed=0
interrupted=0
cleanup() {
    result=$?
    trap - EXIT HUP INT TERM
    if (( interrupted )); then
        if systemctl start ntfy.service sureneco-ntfy-admin.service sureneco.service && all_writers_active; then
            interrupted=0
        else
            printf '%s\n' 'Backup failed: production restart failed; recovery timer remains armed.' >&2
            result=1
        fi
    fi
    if (( recovery_armed && ! interrupted )); then
        systemctl stop "$recovery.timer" || result=1
    fi
    rm -rf --one-file-system -- "$stage" || result=1
    exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
# Independent of this shell/cgroup: first stop any stalled copy, then restart writers.
systemd-run --quiet --collect --unit="$recovery" --on-active=3min --timer-property=AccuracySec=1s --property=Type=oneshot --property=TimeoutStartSec=180s /bin/sh -c '/usr/bin/systemctl stop sureneco-backup.service; /usr/bin/systemctl start ntfy.service sureneco-ntfy-admin.service sureneco.service'
recovery_armed=1
interrupted=1
systemctl stop "${writers[@]}"
for service in "${writers[@]}"; do
    [[ $(systemctl show "$service" -p ActiveState --value) == inactive ]] || fail 'writer service did not stop cleanly.'
done
cp -a --parents -- "${sources[@]}" "$stage/"
# Ownership-lock SQLite files are runtime artifacts, never part of a restore.
find "$stage/var/lib/sureneco" -name 'monitor.sqlite.owner.sqlite*' -delete
systemctl start ntfy.service sureneco-ntfy-admin.service sureneco.service
all_writers_active || fail 'production restart did not complete.'
interrupted=0
systemctl stop "$recovery.timer"
recovery_armed=0
# Stable absolute path, host and tag keep retention independent of deployment paths/hostnames.
restic -o "sftp.command=$ssh_command" backup --host sureneco-production --tag sureneco-daily "$stage" || fail 'encrypted transfer failed; retention was not run.'
restic -o "sftp.command=$ssh_command" forget --host sureneco-production --tag sureneco-daily --group-by host,tags --keep-within 7d --prune || fail 'retention/prune failed.'
printf '%s\n' 'Encrypted backup and seven-day retention completed.'
