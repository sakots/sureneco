#!/usr/bin/env bash
# Run on Oracle as root. install never starts/enables the timer; enable probes
# all checks and sends a labeled Gmail test before activating the timer.
set +x
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

fail() { printf 'Notification monitor setup: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'run as root'
[[ $# -eq 1 && ( $1 = install || $1 = enable ) ]] || fail 'usage: bash scripts/install-notification-monitor.sh install|enable'
for command in python3 systemctl stat install cmp flock dirname realpath; do
    command -v "$command" >/dev/null || fail "missing prerequisite: $command"
done
[[ -x /usr/bin/python3 ]] || fail '/usr/bin/python3 is required'
exec 9>/run/lock/sureneco-monitor-install.lock
flock -n 9 || fail 'another monitor installer is running'

runtime=/usr/local/lib/sureneco-monitor/notification-monitor.py
config=/etc/sureneco-monitor
state=/var/lib/sureneco-monitor
password=$config/gmail-app-password

secure_parent() {
    local path=$1 mode
    [[ -d $path && ! -L $path ]] || fail "not a real directory: $path"
    [[ $(stat -c %u -- "$path") = 0 ]] || fail "directory must be root-owned: $path"
    mode=$(stat -c %a -- "$path")
    (( (8#$mode & 0022) == 0 )) || fail "directory is writable by non-root: $path"
}
private_directory() {
    local path=$1
    if [[ -e $path || -L $path ]]; then
        [[ -d $path && ! -L $path && $(stat -c '%u:%g:%a' -- "$path") = 0:0:700 ]] || fail "preserve and reconcile directory permissions manually: $path"
    else
        install -d -o root -g root -m 0700 -- "$path"
    fi
}
private_file() {
    [[ -f $1 && ! -L $1 && $(stat -c '%u:%g:%a' -- "$1") = 0:0:600 ]] || fail "file must be regular root:root 0600: $1"
}
for path in / /usr /usr/local /usr/local/lib /etc /etc/systemd /etc/systemd/system /var /var/lib; do
    secure_parent "$path"
done

source_dir=$(dirname -- "$(realpath -- "${BASH_SOURCE[0]}")")
repo_dir=$(dirname -- "$source_dir")
sources=("$source_dir/notification-monitor.py" "$repo_dir/server/sureneco-monitor.service" "$repo_dir/server/sureneco-monitor.timer")
targets=("$runtime" /etc/systemd/system/sureneco-monitor.service /etc/systemd/system/sureneco-monitor.timer)

if [[ $1 = install ]]; then
    # Preflight every destination before writing anything. A differing file is
    # never silently replaced, including an administrator's modified unit.
    for index in 0 1 2; do
        source=${sources[$index]}
        target=${targets[$index]}
        [[ -f $source && ! -L $source ]] || fail "missing regular staged input: $source"
        if [[ -e $target || -L $target ]]; then
            [[ -f $target && ! -L $target && $(stat -c '%u:%g:%a' -- "$target") = 0:0:644 ]] || fail "refusing unrecognized target file: $target"
            cmp -s -- "$source" "$target" || fail "existing target differs; preserve and reconcile manually: $target"
        fi
    done
    if [[ -e /usr/local/lib/sureneco-monitor || -L /usr/local/lib/sureneco-monitor ]]; then
        [[ -d /usr/local/lib/sureneco-monitor && ! -L /usr/local/lib/sureneco-monitor && $(stat -c '%u:%g:%a' /usr/local/lib/sureneco-monitor) = 0:0:755 ]] || fail 'runtime directory must be root:root 0755'
    fi
    # Existing credentials, state, and unrelated configuration are preserved.
    private_directory "$config"
    private_directory "$state"
    if [[ -e $password || -L $password ]]; then private_file "$password"; fi
    if [[ -e $state/state.json || -L $state/state.json ]]; then private_file "$state/state.json"; fi
    if [[ -e $state/monitor.lock || -L $state/monitor.lock ]]; then private_file "$state/monitor.lock"; fi
    if [[ ! -d /usr/local/lib/sureneco-monitor ]]; then
        install -d -o root -g root -m 0755 /usr/local/lib/sureneco-monitor
    fi
    for index in 0 1 2; do
        if [[ ! -e ${targets[$index]} ]]; then
            install -o root -g root -m 0644 -- "${sources[$index]}" "${targets[$index]}"
        fi
    done
    systemctl daemon-reload
    printf 'Installed without activating the timer. Configure the Gmail password privately, then run enable.\n'
else
    private_directory "$config"
    private_directory "$state"
    private_file "$password"
    secure_parent /usr/local/lib/sureneco-monitor
    for index in 0 1 2; do
        source=${sources[$index]}
        target=${targets[$index]}
        [[ -f $source && ! -L $source ]] || fail "missing regular staged input: $source"
        [[ -f $target && ! -L $target && $(stat -c '%u:%g:%a' -- "$target") = 0:0:644 ]] || fail "run install first; missing secure managed file: $target"
        cmp -s -- "$source" "$target" || fail "refusing unrecognized installed file: $target"
    done
    # A successful probe does not mutate monitor state or imply inbox delivery.
    /usr/bin/python3 -I "$runtime" --probe || fail 'probe is not healthy; timer remains unchanged'
    /usr/bin/python3 -I "$runtime" --test-email || fail 'SMTP test failed; timer remains unchanged'
    systemctl enable --now sureneco-monitor.timer
    printf 'Timer enabled after healthy probe and SMTP acceptance. Confirm the labeled test in the actual Gmail inbox separately.\n'
fi
