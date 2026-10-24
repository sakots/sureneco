#!/usr/bin/env python3
# Managed by scripts/install-notification-monitor.sh; stdlib-only Oracle monitor.
"""One poll per invocation. SMTP delivery is at-least-once, not exactly-once.

Probe performs no SMTP calls and no state/lock writes. Neither public response
bodies nor exception strings are logged: upstream errors can contain secrets.
"""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.message import EmailMessage
import json
import math
import os
from pathlib import Path
import re
import smtplib
import http.client
import ssl
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.request

ACCOUNT = "sakots8000@gmail.com"
API_URL = "https://api.oekakibbs.moe/healthz"
NTFY_URL = "https://push.oekakibbs.moe/v1/health"
DATA_DIR = Path("/var/lib/sureneco-backup/data")
STATE_DIR = Path("/var/lib/sureneco-monitor")
STATE_FILE = STATE_DIR / "state.json"
PASSWORD_FILE = Path("/etc/sureneco-monitor/gmail-app-password")
TARGETS = {
    "api": ("API監視処理", "https://api.oekakibbs.moe"),
    "ntfy": ("通知サーバー", "https://push.oekakibbs.moe"),
    "backup": ("暗号化バックアップ", None),
}


class MonitorError(Exception):
    """Only fixed, nonsecret diagnostic messages belong in this exception."""


@dataclass(frozen=True)
class Observation:
    healthy: bool
    immediate: bool
    summary: str
    details: dict = field(default_factory=dict)


def number(value):
    return type(value) is int or (type(value) is float and math.isfinite(value))


def timestamp(value, now, scale=1):
    return number(value) and 0 < value <= now * scale


def evaluate_api(value, now):
    invalid = Observation(False, False, "API応答の形式または時刻が不正です")
    if not isinstance(value, dict):
        return invalid
    if not all(timestamp(value.get(key), now, 1000) for key in ("lastStartedAt", "lastFinishedAt")):
        return invalid
    error = value.get("error")
    if "error" not in value or (error is not None and not isinstance(error, str)):
        return invalid
    queue = value.get("outbox")
    if not isinstance(queue, dict) or type(queue.get("count")) is not int or queue["count"] < 0:
        return invalid
    oldest = queue.get("oldestCreatedAt")
    if "oldestCreatedAt" not in queue or (queue["count"] == 0 and oldest is not None):
        return invalid
    if queue["count"] > 0 and not timestamp(oldest, now, 1000):
        return invalid
    age = now - value["lastFinishedAt"] / 1000
    details = {
        "lastStartedAgeSeconds": now - value["lastStartedAt"] / 1000,
        "lastFinishedAgeSeconds": age,
        "outboxCount": queue["count"],
        "outboxOldestAgeSeconds": None if oldest is None else now - oldest / 1000,
    }
    # monitoringReady is deliberately ignored: false is the existing API contract.
    if age > 300:
        return Observation(False, True, "API監視処理の完了から5分を超えています", details)
    if error is not None:
        return Observation(False, False, "API監視処理がエラーを報告しています", details)
    return Observation(True, False, "API監視処理は正常です", details)


def evaluate_ntfy(value):
    if not isinstance(value, dict) or value.get("healthy") is not True:
        return Observation(False, False, "通知サーバーが正常な応答を返していません")
    return Observation(True, False, "通知サーバーは正常です")


def evaluate_backup(newest, outcome, now):
    if outcome is not None:
        if (not isinstance(outcome, dict) or set(outcome) != {"version", "outcome", "time"}
                or type(outcome["version"]) is not int or outcome["version"] != 1
                or outcome["outcome"] not in ("success", "failure")
                or not timestamp(outcome["time"], now)):
            return Observation(False, True, "バックアップ結果ファイルの形式または時刻が不正です")
    if newest is None:
        return Observation(False, True, "暗号化バックアップのスナップショットがありません")
    if not timestamp(newest, now):
        return Observation(False, True, "バックアップの更新時刻が不正です")
    details = {"snapshotAgeSeconds": now - newest, "outcome": None if outcome is None else outcome["outcome"]}
    if outcome is not None and outcome["outcome"] == "failure" and outcome["time"] > newest:
        return Observation(False, True, "最新スナップショット以降にバックアップが失敗しました", details)
    if now - newest > 26 * 3600:
        return Observation(False, True, "暗号化バックアップの更新から26時間を超えています", details)
    return Observation(True, False, "暗号化バックアップは正常です", details)


def advance(previous, observation):
    """Propose a transition, retaining delivered state until SMTP acknowledges it."""
    state = dict(previous) if previous is not None else {"failures": 0, "alerted": False}
    if observation.healthy:
        state["failures"] = 0
        return state, "recovery" if state["alerted"] else None
    state["failures"] = min(3, state["failures"] + 1)
    due = observation.immediate or state["failures"] >= 3
    return state, "alert" if due and not state["alerted"] else None


def delivered(state, event):
    return {**state, "alerted": event == "alert"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def strict_json(raw):
    def reject_constant(_):
        raise ValueError("non-finite JSON number")

    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate JSON key")
            value[key] = item
        return value

    return json.loads(raw, parse_constant=reject_constant, object_pairs_hook=unique_object)


def fetch_json(url):
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "sureneco-oracle-monitor/1"})
    with opener.open(request, timeout=10) as response:
        if response.status != 200:
            raise ValueError("unexpected HTTP status")
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("HTTP body exceeds limit")
    return strict_json(raw)


def check_http(url, evaluator):
    try:
        value = fetch_json(url)
        return evaluator(value, time.time()) if evaluator is evaluate_api else evaluator(value)
    except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException, RecursionError):
        return Observation(False, False, "HTTPS接続またはJSON応答の確認に失敗しました")


def read_json_fd(fd, limit):
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise MonitorError("invalid regular JSON file")
        raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise MonitorError("JSON file exceeds limit")
    return strict_json(raw)


def check_backup(data_dir, now):
    descriptors = []
    try:
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        data = os.open(data_dir, directory_flags)
        descriptors.append(data)
        repository = os.open("repository", directory_flags, dir_fd=data)
        descriptors.append(repository)
        snapshots = os.open("snapshots", directory_flags, dir_fd=repository)
        descriptors.append(snapshots)
        newest = None
        with os.scandir(snapshots) as entries:
            for entry in entries:
                if not re.fullmatch(r"[0-9a-f]{64}", entry.name):
                    continue
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISREG(info.st_mode):
                    newest = info.st_mtime if newest is None else max(newest, info.st_mtime)
        try:
            fd = os.open("backup-status.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=data)
        except FileNotFoundError:
            outcome = None  # Existing snapshots remain valid before publisher rollout.
        else:
            outcome = read_json_fd(fd, 4096)
            if outcome is None:
                raise MonitorError("invalid outcome JSON")
        return evaluate_backup(newest, outcome, now)
    except (OSError, ValueError, MonitorError, RecursionError):
        return Observation(False, True, "バックアップの保存先または結果ファイルを安全に確認できません")
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def collect():
    return {
        "api": check_http(API_URL, evaluate_api),
        "ntfy": check_http(NTFY_URL, evaluate_ntfy),
        "backup": check_backup(DATA_DIR, time.time()),
    }


def require_private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise MonitorError("monitor directory must be root:root 0700")


def require_private_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise MonitorError("monitor file must be regular root:root 0600")


def load_state(path):
    try:
        require_private_file(path)
    except FileNotFoundError:
        return {"version": 1, "targets": {}}
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    state = read_json_fd(fd, 16384)
    if not isinstance(state, dict) or set(state) != {"version", "targets"} or type(state["version"]) is not int or state["version"] != 1:
        raise MonitorError("invalid monitor state")
    targets = state["targets"]
    if not isinstance(targets, dict) or not set(targets).issubset(TARGETS):
        raise MonitorError("invalid monitor state targets")
    for entry in targets.values():
        if (not isinstance(entry, dict) or set(entry) != {"failures", "alerted"}
                or type(entry["failures"]) is not int or not 0 <= entry["failures"] <= 3
                or type(entry["alerted"]) is not bool):
            raise MonitorError("invalid monitor target state")
    return state


def save_state(path, state):
    require_private_directory(path.parent)
    try:
        require_private_file(path)
    except FileNotFoundError:
        pass
    fd, temporary = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(state, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def locked():
    import fcntl  # Linux-only runtime; module import remains usable for pure tests.
    require_private_directory(STATE_DIR)
    path = STATE_DIR / "monitor.lock"
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        require_private_file(path)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise MonitorError("another monitor invocation is running") from None
        yield
    finally:
        os.close(fd)


def password():
    require_private_directory(PASSWORD_FILE.parent)
    require_private_file(PASSWORD_FILE)
    fd = os.open(PASSWORD_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        raw = stream.read(128)
    # The interactive helper normalizes Google's grouped display to 16 letters.
    if not re.fullmatch(rb"[a-zA-Z0-9]{16}\n?", raw):
        raise MonitorError("Gmail app password file has an invalid format")
    return raw.strip().decode("ascii")


def mail(event, key, observation, now):
    label, origin = TARGETS[key] if key is not None else ("メール通知テスト", None)
    title = {"alert": "障害", "recovery": "復旧", "test": "テスト（動作確認）"}[event]
    at = datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds")
    message = EmailMessage()
    message["From"] = ACCOUNT
    message["To"] = ACCOUNT
    message["Subject"] = f"[すれ猫監視] {title}: {label}"
    lines = [f"すれ猫監視からの{title}通知です。", f"対象: {label}",
             f"確認時刻: {at}", f"状態: {observation.summary}"]
    if origin:
        lines.append(f"公開接続先: {origin}")
    if event == "test":
        lines.append("これは利用者が実行したメール送信テストです。実際の障害通知ではありません。")
    message.set_content("\n".join(lines) + "\n")
    secret = password()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=10, context=ssl.create_default_context()) as smtp:
        smtp.login(ACCOUNT, secret)
        smtp.send_message(message)


def scheduled():
    with locked():
        state = load_state(STATE_FILE)
        observations = collect()
        now = time.time()
        events = []
        for key, observation in observations.items():
            entry, event = advance(state["targets"].get(key), observation)
            state["targets"][key] = entry
            if event:
                events.append((key, event, observation))
        save_state(STATE_FILE, state)
        failed = False
        for key, event, observation in events:
            try:
                mail(event, key, observation, now)
            except (OSError, smtplib.SMTPException, MonitorError, ValueError):
                # Do not include SMTP response text, addresses, password, or body.
                print(f"monitor: SMTP delivery failed ({key}); retry on next poll", file=sys.stderr)
                failed = True
                continue
            state["targets"][key] = delivered(state["targets"][key], event)
            save_state(STATE_FILE, state)
            print(f"monitor: {event} accepted by SMTP ({key})")
        return 1 if failed else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Independent Oracle Gmail health monitor")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--probe", action="store_true", help="read-only JSON checks; no SMTP or state writes")
    modes.add_argument("--test-email", action="store_true", help="send an explicitly labeled test to the fixed Gmail account")
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        print("monitor: run as root", file=sys.stderr)
        return 1
    os.umask(0o077)
    try:
        if args.probe:
            observations = collect()
            now = time.time()
            print(json.dumps({"version": 1, "time": now, "checks": {
                key: {"healthy": item.healthy, "immediate": item.immediate,
                      "summary": item.summary, **item.details}
                for key, item in observations.items()
            }}, ensure_ascii=False, allow_nan=False))
            return 0 if all(item.healthy for item in observations.values()) else 1
        if args.test_email:
            with locked():
                mail("test", None, Observation(True, False, "Gmail送信経路の動作確認です"), time.time())
            print("monitor: labeled test accepted by SMTP; confirm actual inbox separately")
            return 0
        return scheduled()
    except (OSError, ValueError, MonitorError, smtplib.SMTPException, RecursionError):
        print("monitor: operation failed; inspect file permissions, configuration and connectivity (details suppressed)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
