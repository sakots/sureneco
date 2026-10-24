#!/usr/bin/env bash
# Run on the Oracle destination as root with the source's single Ed25519 PUBLIC key.
# Creates only /data; restic on the source initializes /data/repository.
set +x
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

fail() { printf 'Backup storage setup: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'run as root'
[[ $# -eq 1 ]] || fail 'usage: bash install-backup-storage.sh /absolute/source-key.pub'
[[ $1 = /* && -f $1 && ! -L $1 ]] || fail 'public key input must be an absolute, regular, non-symlink file'
for command in sshd ssh-keygen getent useradd chage id stat install mktemp cmp flock systemctl find; do
    command -v "$command" >/dev/null || fail "missing prerequisite: $command"
done
[[ -x /usr/sbin/nologin ]] || fail '/usr/sbin/nologin is required'
exec 9>/run/lock/sureneco-backup-storage.lock
flock -n 9 || fail 'another storage installer is running'

account=sureneco-backup
chroot=/var/lib/sureneco-backup
key_file=/etc/ssh/authorized_keys/sureneco-backup
config_file=/etc/ssh/sshd_config.d/70-sureneco-backup.conf
work=$(mktemp -d /run/sureneco-backup-storage.XXXXXXXX)
key_added=false
config_added=false
reload_attempted=false
committed=false
cleanup() {
    local status=$?
    trap - EXIT HUP INT TERM
    if [[ $committed != true ]]; then
        # Only files installed by this invocation can be removed. The repository,
        # existing keys/configuration, and existing account are never touched.
        if [[ $config_added == true ]]; then rm -f -- "$config_file"; fi
        if [[ $key_added == true ]]; then rm -f -- "$key_file"; fi
        if [[ $reload_attempted == true ]]; then
            if sshd -t; then systemctl reload ssh.service || printf 'Failed to reload restored SSH configuration; inspect ssh.service.\n' >&2; fi
        fi
    fi
    rm -rf -- "$work"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Do not accept authorized_keys options, private keys, certificates, CRLF, or
# multiple lines. Strip the optional comment before installation and logging.
[[ $(stat -c %s -- "$1") -le 16384 ]] || fail 'public key input is too large'
install -o root -g root -m 0600 -- "$1" "$work/input.key"
mapfile -t public_lines < "$work/input.key"
[[ ${#public_lines[@]} -eq 1 ]] || fail 'expected exactly one public key line'
# Bash strings cannot represent NUL. Require a byte-for-byte round trip so a
# binary file cannot be silently normalized into an apparently valid key.
printf '%s' "${public_lines[0]}" > "$work/input.roundtrip"
if ! cmp -s "$work/input.key" "$work/input.roundtrip"; then
    printf '\n' >> "$work/input.roundtrip"
    cmp -s "$work/input.key" "$work/input.roundtrip" || fail 'public key contains unsupported bytes'
fi
public_pattern='^ssh-ed25519[[:blank:]]+([A-Za-z0-9+/]+={0,2})([[:blank:]]+[ -~]*)?$'
[[ ${public_lines[0]} =~ $public_pattern ]] || fail 'expected an unadorned ssh-ed25519 public key'
key_blob=${BASH_REMATCH[1]}
printf 'ssh-ed25519 %s\n' "$key_blob" > "$work/public.key"
fingerprint_output=$(ssh-keygen -l -E sha256 -f "$work/public.key" 2>/dev/null) || fail 'invalid Ed25519 public key'
read -r key_bits fingerprint _ <<< "$fingerprint_output"
[[ $key_bits = 256 && $fingerprint = SHA256:* && $fingerprint_output = *'(ED25519)' ]] || fail 'invalid Ed25519 public key'
printf 'restrict ssh-ed25519 %s sureneco-backup\n' "$key_blob" > "$work/authorized_keys"
unset key_blob public_lines fingerprint_output

cat > "$work/sshd.conf" <<'CONFIG'
# Managed by scripts/install-backup-storage.sh. Do not add unrelated settings.
Match User sureneco-backup
    ChrootDirectory /var/lib/sureneco-backup
    ForceCommand internal-sftp -d /data -u 0077
    AuthorizedKeysFile /etc/ssh/authorized_keys/sureneco-backup
    # The public key is root-owned but readable as the login UID before chroot.
    AuthorizedKeysCommand none
    AuthorizedPrincipalsFile none
    AuthorizedPrincipalsCommand none
    TrustedUserCAKeys none
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PubkeyAcceptedAlgorithms ssh-ed25519
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitEmptyPasswords no
    DisableForwarding yes
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitTTY no
    PermitUserRC no
Match all
CONFIG

secure_root_directory() {
    local path=$1 mode
    [[ -d $path && ! -L $path ]] || fail "not a real directory: $path"
    [[ $(stat -c %u -- "$path") = 0 ]] || fail "directory must be root-owned: $path"
    mode=$(stat -c %a -- "$path")
    (( (8#$mode & 0022) == 0 )) || fail "directory must not be group/world writable: $path"
}
for directory in / /var /var/lib /etc /etc/ssh /etc/ssh/sshd_config.d; do
    secure_root_directory "$directory"
done
[[ -f /etc/ssh/sshd_config && ! -L /etc/ssh/sshd_config ]] || fail 'unsupported sshd_config path'
[[ $(stat -c %u /etc/ssh/sshd_config) = 0 ]] || fail 'sshd_config must be root-owned'
config_mode=$(stat -c %a /etc/ssh/sshd_config)
(( (8#$config_mode & 0022) == 0 )) || fail 'sshd_config is writable by non-root'
# Never change the administrator's main configuration to add an Include.
include_found=false
while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line =~ ^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf[[:space:]]*(#.*)?$ ]]; then
        include_found=true
    fi
done < /etc/ssh/sshd_config
[[ $include_found == true ]] || fail 'sshd_config must already Include /etc/ssh/sshd_config.d/*.conf'
sshd -t || fail 'existing SSH configuration is invalid'
systemctl is-active --quiet ssh.service || fail 'ssh.service must already be active'
# Ensure a user-only Match does not change the administrator's effective config.
admin_context='user=ubuntu,host=localhost,addr=162.43.74.250,laddr=141.147.175.12,lport=22'
sshd -T -C "$admin_context" > "$work/admin.before"

for pair in "$key_file:$work/authorized_keys" "$config_file:$work/sshd.conf"; do
    target=${pair%%:*}
    expected=${pair#*:}
    if [[ -e $target || -L $target ]]; then
        [[ -f $target && ! -L $target ]] || fail "refusing non-regular existing file: $target"
        [[ $(stat -c %u -- "$target") = 0 ]] || fail "existing file must be root-owned: $target"
        target_mode=$(stat -c %a -- "$target")
        (( (8#$target_mode & 0022) == 0 )) || fail "existing file writable by non-root: $target"
        cmp -s -- "$target" "$expected" || fail "existing file differs; preserve and reconcile manually: $target"
    fi
done
if [[ -e /etc/ssh/authorized_keys || -L /etc/ssh/authorized_keys ]]; then
    secure_root_directory /etc/ssh/authorized_keys
    [[ $(stat -c '%u:%g:%a' /etc/ssh/authorized_keys) = 0:0:755 ]] || fail 'existing authorized_keys directory must be root:root 0755'
fi
if [[ -e $chroot || -L $chroot ]]; then
    secure_root_directory "$chroot"
    [[ $(stat -c '%u:%g:%a' -- "$chroot") = 0:0:755 ]] || fail 'existing chroot must be root:root 0755'
    [[ -z $(find "$chroot" -mindepth 1 -maxdepth 1 ! -name data -print -quit) ]] || fail 'existing chroot contains unrelated data'
fi

if entry=$(getent passwd "$account"); then
    IFS=: read -r name _ uid gid description home shell <<< "$entry"
    [[ $uid != 0 && $home = /data && $shell = /usr/sbin/nologin ]] || fail 'existing account has incompatible identity, home, or shell'
    group_entry=$(getent group "$account") || fail 'existing account lacks its dedicated group'
    IFS=: read -r _ _ group_gid group_members <<< "$group_entry"
    [[ $group_gid = "$gid" && -z $group_members && $(id -G "$account") = "$gid" ]] || fail 'existing account/group has unrelated memberships'
    shadow_entry=$(getent shadow "$account") || fail 'cannot inspect existing account password state'
    IFS=: read -r _ password_hash _ _ maximum _ inactive expires _ <<< "$shadow_entry"
    # '*' is an impossible password, not Ubuntu/OpenSSH's '!' account lock.
    # This permits public keys even if UsePAM is disabled, without a password.
    [[ $password_hash = '*' && ( -z $maximum || $maximum = -1 ) && ( -z $inactive || $inactive = -1 ) && ( -z $expires || $expires = -1 ) ]] || fail 'existing account must have non-expiring impossible (*) password, not an account lock'
    unset shadow_entry password_hash
else
    if getent group "$account" >/dev/null; then fail 'dedicated group already exists without the dedicated account'; fi
    useradd --system --user-group --no-create-home --home-dir /data --shell /usr/sbin/nologin --password '*' "$account"
    chage -M -1 -I -1 -E -1 "$account"
    uid=$(id -u "$account")
    gid=$(id -g "$account")
fi
if [[ ! -d $chroot ]]; then install -d -o root -g root -m 0755 -- "$chroot"; fi
if [[ -e $chroot/data || -L $chroot/data ]]; then
    [[ -d $chroot/data && ! -L $chroot/data ]] || fail 'existing /data is not a real directory'
    [[ $(stat -c '%u:%g:%a' -- "$chroot/data") = "$uid:$gid:700" ]] || fail 'existing /data must be dedicated-user:dedicated-group 0700'
    [[ -z $(find "$chroot/data" -mindepth 1 -maxdepth 1 ! -name repository ! -name backup-status.json ! -name backup-status.pending -print -quit) ]] || fail 'existing /data contains unrelated data'
    if [[ -e $chroot/data/repository || -L $chroot/data/repository ]]; then
        [[ -d $chroot/data/repository && ! -L $chroot/data/repository ]] || fail 'existing repository must be a real directory'
    fi
    for status in "$chroot/data/backup-status.json" "$chroot/data/backup-status.pending"; do
        if [[ -e $status || -L $status ]]; then
            [[ -f $status && ! -L $status ]] || fail 'existing backup status must be a regular non-symlink file'
            [[ $(stat -c '%u:%g:%a:%h' -- "$status") = "$uid:$gid:600:1" ]] || fail 'existing backup status must be dedicated-user:dedicated-group 0600 and single-link'
        fi
    done
else
    install -d -o "$uid" -g "$gid" -m 0700 -- "$chroot/data"
fi
if [[ ! -d /etc/ssh/authorized_keys ]]; then install -d -o root -g root -m 0755 /etc/ssh/authorized_keys; fi
if [[ ! -e $key_file ]]; then
    key_added=true
    install -o root -g root -m 0644 -- "$work/authorized_keys" "$key_file"
else
    [[ $(stat -c '%u:%g:%a' -- "$key_file") = 0:0:644 ]] || fail 'existing authorized key must be root:root 0644'
fi
if [[ ! -e $config_file ]]; then
    config_added=true
    install -o root -g root -m 0600 -- "$work/sshd.conf" "$config_file"
fi

# Validation failure exits through cleanup BEFORE the running daemon is reloaded.
sshd -t || fail 'new SSH configuration failed validation; rolling back'
sshd -T -C "$admin_context" > "$work/admin.after"
cmp -s "$work/admin.before" "$work/admin.after" || fail 'administrator SSH configuration changed; rolling back'
for address in 162.43.74.250 127.0.0.1 ::1; do
    sshd -T -C "user=$account,host=localhost,addr=$address,laddr=141.147.175.12,lport=22" > "$work/effective"
    while IFS= read -r expected; do
        [[ -z $expected ]] && continue
        found=false
        while IFS= read -r actual; do
            if [[ $actual = "$expected" ]]; then found=true; break; fi
        done < "$work/effective"
        [[ $found == true ]] || fail "effective SSH restriction missing ($expected); rolling back"
    done <<'EXPECTED'
chrootdirectory /var/lib/sureneco-backup
forcecommand internal-sftp -d /data -u 0077
authorizedkeysfile /etc/ssh/authorized_keys/sureneco-backup
authorizedkeyscommand none
authorizedprincipalsfile none
authorizedprincipalscommand none
trustedusercakeys none
authenticationmethods publickey
pubkeyauthentication yes
pubkeyacceptedalgorithms ssh-ed25519
passwordauthentication no
kbdinteractiveauthentication no
permitemptypasswords no
disableforwarding yes
allowtcpforwarding no
allowstreamlocalforwarding no
allowagentforwarding no
x11forwarding no
permittunnel no
permittty no
permituserrc no
EXPECTED
done
reload_attempted=true
systemctl reload ssh.service || fail 'SSH reload failed; restoring previous configuration'
committed=true
printf 'Restricted SFTP storage configured; source public key fingerprint: %s\n' "$fingerprint"
printf 'Repository (initialized by the source): sftp:sureneco-backup@141.147.175.12:/data/repository\n'
printf 'Pin the host Ed25519 public key obtained over your already authenticated administrator SSH connection.\n'
