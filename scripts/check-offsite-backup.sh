#!/bin/bash
# Verify the actual offsite snapshot without restoring into production.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset RESTIC_PASSWORD RESTIC_PASSWORD_COMMAND RESTIC_REPOSITORY RESTIC_REPOSITORY_FILE RESTIC_KEY_HINT RESTIC_OPTIONS
[[ $EUID == 0 ]] || { echo 'root is required' >&2; exit 1; }
exec 9>/run/sureneco-backup.lock
flock -n 9 || { echo 'backup or verification is already running' >&2; exit 1; }
readonly config=/etc/sureneco-backup
readonly state=/var/lib/sureneco-backup
readonly repository=sftp:sureneco-backup@141.147.175.12:/data/repository
readonly report=/home/sureneco/sureneco-backup-verify-result-20261024.json
readonly ssh_command='ssh -F /dev/null -i /etc/sureneco-backup/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/sureneco-backup/known_hosts -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 sureneco-backup@141.147.175.12 -s sftp'
[[ -d $config && ! -L $config && $(stat -c '%u:%g:%a' "$config") == 0:0:700 ]] || exit 1
[[ -d $state && ! -L $state && $(stat -c '%u:%g:%a' "$state") == 0:0:700 ]] || exit 1
for file in backup.env password id_ed25519 known_hosts; do
    [[ -f $config/$file && ! -L $config/$file && $(stat -c '%u:%g:%a:%h' "$config/$file") == 0:0:600:1 ]] || exit 1
done
[[ $(cat "$config/backup.env") == "RESTIC_REPOSITORY=$repository" ]] || exit 1
[[ ! -e $report && ! -L $report ]] || { echo 'verification report already exists; preserve it before rerunning' >&2; exit 1; }
validator=$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")/verify-restored-backup.mjs
[[ -f $validator && ! -L $validator ]] || { echo 'missing restored backup validator' >&2; exit 1; }
export RESTIC_REPOSITORY=$repository RESTIC_PASSWORD_FILE=$config/password RESTIC_CACHE_DIR=$state/cache
work=$(mktemp -d "$state/verify.XXXXXXXX")
phase=repository_read_check
cleanup() {
    result=$?
    trap - EXIT HUP INT TERM
    rm -rf --one-file-system -- "$work" || result=1
    if (( result != 0 )); then printf 'Backup verification failed in %s; production data was not changed.\n' "$phase" >&2; fi
    exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
repo() { restic -o "sftp.command=$ssh_command" "$@"; }
repo check --read-data
repo snapshots --host sureneco-production --tag sureneco-daily --json > "$work/snapshots.json"
snapshot=$(/usr/bin/node - "$work/snapshots.json" <<'NODE'
const fs=require('node:fs'); const rows=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
rows.sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));
if(!rows.length||!/^[a-f0-9]{64}$/.test(rows[0].id)||!rows[0].paths.includes('/var/lib/sureneco-backup/snapshot'))process.exit(1);
console.log(rows[0].id);
NODE
)
phase=offsite_restore
repo restore "$snapshot" --target "$work/restored"
/usr/bin/node --no-warnings "$validator" "$work/restored/var/lib/sureneco-backup/snapshot" > "$work/restored-check.json"
phase=retention_boundary_check
# Use a separate LOCAL disposable repository: never invent old snapshots in production.
mkdir -m 700 "$work/retention-input"
printf 'retention boundary proof\n' > "$work/retention-input/data"
restic -r "$work/retention-repository" init
old_time=$(date -u -d '10 days ago' '+%Y-%m-%d %H:%M:%S')
restic -r "$work/retention-repository" backup --host retention-check --tag retention-check --time "$old_time" "$work/retention-input"
restic -r "$work/retention-repository" backup --host retention-check --tag retention-check "$work/retention-input"
restic -r "$work/retention-repository" forget --host retention-check --tag retention-check --group-by host,tags --keep-within 7d --prune
restic -r "$work/retention-repository" snapshots --json > "$work/retention.json"
phase=result
/usr/bin/node - "$work/snapshots.json" "$work/restored-check.json" "$work/retention.json" "$report" <<'NODE'
const fs=require('node:fs');const cp=require('node:child_process');
const snapshots=JSON.parse(fs.readFileSync(process.argv[2],'utf8')).sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));
const restored=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const retention=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));
if(retention.length!==1||Date.parse(retention[0].time)<Date.now()-3600000)throw Error('retention_boundary_failed');
const uid=Number(cp.execFileSync('/usr/bin/id',['-u','sureneco'],{encoding:'utf8'}).trim());
const gid=Number(cp.execFileSync('/usr/bin/id',['-g','sureneco'],{encoding:'utf8'}).trim());
const fd=fs.openSync(process.argv[5],fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
try{fs.writeFileSync(fd,JSON.stringify({verifiedAt:new Date().toISOString(),success:true,repositoryReadDataCheck:true,latestSnapshot:{id:snapshots[0].id,time:snapshots[0].time,host:snapshots[0].hostname,tags:snapshots[0].tags},snapshotCount:snapshots.length,restored,retentionBoundary:{separateDisposableRepository:true,tenDayOldRemoved:true,currentRetained:true},productionWrites:false},null,2)+'\n');fs.fsyncSync(fd);fs.fchownSync(fd,uid,gid);}finally{fs.closeSync(fd);}
NODE
printf 'Offsite read, restore, and retention checks succeeded. Report: %s\n' "$report"
