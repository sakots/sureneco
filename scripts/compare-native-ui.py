#!/usr/bin/env python3
"""Compare real Linux/X11 GUI process trees without touching application config.

Only Python's standard library and libX11 are required. Both executables MUST be
release builds with the comparison-fixture Cargo feature. The fixture marker is
required; an executable built without that feature cannot produce a success row.
"""

from __future__ import annotations

import argparse
import copy
import ctypes as C
import ctypes.util
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import signal
import statistics
import subprocess
import sys
import time


# Same Settings fields/defaults as src/core/settings.ts. No user config discovery.
DEFAULT_SETTINGS = {
    "update_sec": 20,
    "thread_update_sec": 300,
    "elapsed_days": 14,
    "emphasis_sec": 600,
    "thread_title_regex": "雀魂|じゃんたま|ジャンタマ|mahjongsoul|majsoul",
    "ng_thread_title_regex": "",
    "yujinsen_regex": (
        r"友人戦|友人部屋|(?:募集|部屋)[\s:：]*[0-9０-９]{5,6}|"
        r"[0-9０-９]{5,6}[\s　]*(?:募|＠|@)|四東|四南|三東|三南|三人半荘|"
        r"四人半[荘莊]|(?<![0-9０-９IVXLCDMⅠ-Ⅻⅰ-ⅻ])(?:[34３４]|III|IV|Ⅲ|Ⅳ)[東南]"
    ),
    "closed_yujinsen_regex": "〆|締め|しめ|締切|締め切|解散|埋まり|満員",
    "url": "https://egg.5ch.io/mj/",
    "ng_words": [],
    "ng_ids": [],
    "ng_watchois": [],
    "allowed_watchois": [],
    "launcher_mode": "default",
    "launcher_path": "",
    "launcher_args": [],
    "launcher_profile": "",
    "launcher_user_data_dir": "",
}
FIXTURE_MARKER = b"sureneco-comparison-fixture: active"
CAVEATS = [
    "Prototype comparison, not feature parity: Iced excludes Tauri tray, autostart, and updater parity; close exits.",
    "Startup means first observed viewable X11 window with _NET_WM_PID belonging to the launched tree, not first rendered content.",
    "Fixture activation is verified by the backend stderr marker; watched DAT consumption is verified by the saved cursor.",
    "Executables must be trusted, locally built artifacts. A prelaunch byte-marker scan is only a coarse feature-build guard, not cryptographic proof; the runtime marker and saved cursor are still required.",
    "Notification delivery is disabled identically via allowed_watchois=['comparison-no-notifications']; fixture posts have no watchoi. Recruitment detection/display remains enabled.",
    "Process memory is sampled sequentially, not atomically; short-lived processes may exit between discovery and reads and are reported per sample.",
    "RSS sums include shared pages more than once; PSS apportions them. Both totals include observed WebKit helpers.",
    "Tree membership uses /proc parent links, launch process group, and retained PID/start-time identities. Unobserved double-fork/session escapes and external shared services cannot be guaranteed covered.",
    "Only the newly launched process group is signaled. Observed processes escaping that group are reported, never killed individually.",
    "Virtual X11 displays and software rendering do not represent a physical desktop/GPU or Windows. Renderer descriptions are build declarations, not runtime GPU detection.",
    "Binary bytes exclude dynamically linked libraries and installed package assets. GUI mapping alone does not prove visual/font correctness; inspect the actual UI separately.",
]


class MeasurementError(RuntimeError):
    pass


class WindowAttributes(C.Structure):
    _fields_ = [
        ("x", C.c_int), ("y", C.c_int), ("width", C.c_int),
        ("height", C.c_int), ("border_width", C.c_int), ("depth", C.c_int),
        ("visual", C.c_void_p), ("root", C.c_ulong), ("window_class", C.c_int),
        ("bit_gravity", C.c_int), ("win_gravity", C.c_int),
        ("backing_store", C.c_int), ("backing_planes", C.c_ulong),
        ("backing_pixel", C.c_ulong), ("save_under", C.c_int),
        ("colormap", C.c_ulong), ("map_installed", C.c_int),
        ("map_state", C.c_int), ("all_event_masks", C.c_long),
        ("your_event_mask", C.c_long), ("do_not_propagate_mask", C.c_long),
        ("override_redirect", C.c_int), ("screen", C.c_void_p),
    ]


class X11:
    def __init__(self, display: str):
        library = ctypes.util.find_library("X11")
        if not library:
            raise MeasurementError("libX11 is required for real mapped-window detection")
        self.lib = C.CDLL(library)
        signatures = {
            "XOpenDisplay": ([C.c_char_p], C.c_void_p),
            "XCloseDisplay": ([C.c_void_p], C.c_int),
            "XDefaultScreen": ([C.c_void_p], C.c_int),
            "XRootWindow": ([C.c_void_p, C.c_int], C.c_ulong),
            "XScreenCount": ([C.c_void_p], C.c_int),
            "XDisplayWidth": ([C.c_void_p, C.c_int], C.c_int),
            "XDisplayHeight": ([C.c_void_p, C.c_int], C.c_int),
            "XServerVendor": ([C.c_void_p], C.c_char_p),
            "XVendorRelease": ([C.c_void_p], C.c_int),
            "XInternAtom": ([C.c_void_p, C.c_char_p, C.c_int], C.c_ulong),
            "XFree": ([C.c_void_p], C.c_int),
            "XGetWindowAttributes": ([C.c_void_p, C.c_ulong, C.POINTER(WindowAttributes)], C.c_int),
            "XQueryTree": ([C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.POINTER(C.c_ulong)), C.POINTER(C.c_uint)], C.c_int),
            "XGetWindowProperty": ([C.c_void_p, C.c_ulong, C.c_ulong, C.c_long, C.c_long, C.c_int, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.POINTER(C.c_ubyte))], C.c_int),
        }
        for name, (argtypes, restype) in signatures.items():
            function = getattr(self.lib, name)
            function.argtypes, function.restype = argtypes, restype
        # Windows can disappear between queries: BadWindow must not terminate Python.
        handler_type = C.CFUNCTYPE(C.c_int, C.c_void_p, C.c_void_p)
        self.error_handler = handler_type(lambda _display, _event: 0)
        self.lib.XSetErrorHandler.argtypes = [handler_type]
        self.lib.XSetErrorHandler.restype = C.c_void_p
        self.previous_error_handler = self.lib.XSetErrorHandler(self.error_handler)
        self.display = self.lib.XOpenDisplay(display.encode())
        if not self.display:
            self.lib.XSetErrorHandler.argtypes = [C.c_void_p]
            self.lib.XSetErrorHandler(self.previous_error_handler)
            raise MeasurementError(f"Cannot open X11 display {display!r}; check DISPLAY and XAUTHORITY")
        self.pid_atom = self.lib.XInternAtom(self.display, b"_NET_WM_PID", 0)
        self.cardinal_atom = self.lib.XInternAtom(self.display, b"CARDINAL", 0)
        self.roots = [self.lib.XRootWindow(self.display, n) for n in range(self.lib.XScreenCount(self.display))]
        screen = self.lib.XDefaultScreen(self.display)
        self.info = {
            "name": display,
            "protocol": "X11 (GDK_BACKEND=x11; WINIT_UNIX_BACKEND=x11)",
            "vendor": self.lib.XServerVendor(self.display).decode(errors="replace"),
            "vendor_release": self.lib.XVendorRelease(self.display),
            "width": self.lib.XDisplayWidth(self.display, screen),
            "height": self.lib.XDisplayHeight(self.display, screen),
            "screen_count": len(self.roots),
        }

    def close(self):
        if self.display:
            self.lib.XCloseDisplay(self.display)
            self.display = None
        self.lib.XSetErrorHandler.argtypes = [C.c_void_p]
        self.lib.XSetErrorHandler(self.previous_error_handler)

    def window_pid(self, window: int):
        actual_type, count, remaining = C.c_ulong(), C.c_ulong(), C.c_ulong()
        actual_format = C.c_int()
        data = C.POINTER(C.c_ubyte)()
        status = self.lib.XGetWindowProperty(
            self.display, window, self.pid_atom, 0, 1, 0, self.cardinal_atom,
            C.byref(actual_type), C.byref(actual_format), C.byref(count),
            C.byref(remaining), C.byref(data),
        )
        try:
            if status == 0 and actual_type.value == self.cardinal_atom and actual_format.value == 32 and count.value == 1 and data:
                return C.cast(data, C.POINTER(C.c_ulong))[0]
            return None
        finally:
            if data:
                self.lib.XFree(data)

    def mapped_windows(self, pids: set[int]):
        found, stack, visited = [], list(self.roots), set()
        while stack:
            window = stack.pop()
            if window in visited:
                continue
            visited.add(window)
            if len(visited) > 100000:
                raise MeasurementError("X11 tree exceeded 100000 windows; cannot claim complete window detection")
            pid = self.window_pid(window)
            if pid in pids:
                attributes = WindowAttributes()
                if self.lib.XGetWindowAttributes(self.display, window, C.byref(attributes)) and attributes.map_state == 2 and attributes.width > 0 and attributes.height > 0:
                    found.append({"id": window, "pid": pid, "width": attributes.width, "height": attributes.height, "depth": attributes.depth})
            root, parent, count = C.c_ulong(), C.c_ulong(), C.c_uint()
            children = C.POINTER(C.c_ulong)()
            try:
                if self.lib.XQueryTree(self.display, window, C.byref(root), C.byref(parent), C.byref(children), C.byref(count)):
                    stack.extend(children[n] for n in range(count.value))
            finally:
                if children:
                    self.lib.XFree(children)
        return found


def process_stat(pid: int):
    text = (Path("/proc") / str(pid) / "stat").read_text()
    head, _, rest = text.rpartition(") ")
    fields = rest.split()
    return {
        "pid": pid, "name": head.partition("(")[2], "state": fields[0],
        "ppid": int(fields[1]), "pgrp": int(fields[2]), "session": int(fields[3]),
        "start_ticks": int(fields[19]),
    }


class ProcessTree:
    def __init__(self, pid: int):
        self.pgid = pid
        root = process_stat(pid)
        self.root_identity = (pid, root["start_ticks"])
        self.known = {self.root_identity: root}
        self.unreadable_scan_pids = set()

    def refresh(self):
        snapshot = {}
        for entry in Path("/proc").iterdir():
            if not entry.name.isdecimal():
                continue
            pid = int(entry.name)
            try:
                snapshot[pid] = process_stat(pid)
            except (FileNotFoundError, ProcessLookupError):
                continue
            except PermissionError:
                self.unreadable_scan_pids.add(pid)
        leader = snapshot.get(self.pgid)
        group_reused = leader is not None and (leader["pid"], leader["start_ticks"]) != self.root_identity
        members = {
            pid: stat for pid, stat in snapshot.items()
            if (pid, stat["start_ticks"]) in self.known
            or (not group_reused and stat["pgrp"] == self.pgid and stat["session"] == self.pgid and stat["start_ticks"] >= self.root_identity[1])
        }
        while True:
            children = {pid: stat for pid, stat in snapshot.items() if pid not in members and stat["ppid"] in members}
            if not children:
                break
            members.update(children)
        for pid, stat in members.items():
            self.known[(pid, stat["start_ticks"])] = stat
        return {pid: stat for pid, stat in members.items() if stat["state"] not in ("Z", "X")}

    def history(self):
        return sorted(self.known.values(), key=lambda item: (item["start_ticks"], item["pid"]))


def memory_for(stat: dict):
    directory = Path("/proc") / str(stat["pid"])
    try:
        text = (directory / "smaps_rollup").read_text()
        source = "smaps_rollup"
    except FileNotFoundError:
        # Older kernels have smaps only. Missing process is handled by caller.
        text = (directory / "smaps").read_text()
        source = "smaps"
    totals = {"Rss:": 0, "Pss:": 0}
    present = set()
    for line in text.splitlines():
        fields = line.split()
        if fields and fields[0] in totals:
            if len(fields) != 3 or fields[2] != "kB":
                raise MeasurementError(f"Unexpected smaps units for PID {stat['pid']}")
            totals[fields[0]] += int(fields[1]) * 1024
            present.add(fields[0])
    current = process_stat(stat["pid"])
    if current["start_ticks"] != stat["start_ticks"]:
        raise ProcessLookupError("PID was reused while sampling")
    if present != {"Rss:", "Pss:"}:
        raise MeasurementError(f"RSS/PSS absent for live PID {stat['pid']}; no zero substitution")
    return {**stat, "rss_bytes": totals["Rss:"], "pss_bytes": totals["Pss:"], "memory_source": source}


def sample_memory(tree: ProcessTree, started: float):
    processes, exited = [], []
    members = tree.refresh()
    if tree.unreadable_scan_pids:
        raise MeasurementError("/proc/stat scan denied access; cannot establish complete observed process tree")
    for pid, stat in sorted(members.items()):
        try:
            processes.append(memory_for(stat))
        except (FileNotFoundError, ProcessLookupError):
            exited.append(pid)
        except PermissionError as error:
            raise MeasurementError(f"PSS inaccessible for PID {pid}: {error}; no RSS-only substitution") from error
        except MeasurementError:
            # A task can become a zombie between stat and smaps reads.
            try:
                if process_stat(pid)["state"] in ("Z", "X"):
                    exited.append(pid)
                    continue
            except (FileNotFoundError, ProcessLookupError):
                exited.append(pid)
                continue
            raise
    if not processes:
        raise MeasurementError("No live processes remained to sample")
    return {
        "elapsed_seconds": time.monotonic() - started,
        "rss_bytes": sum(p["rss_bytes"] for p in processes),
        "pss_bytes": sum(p["pss_bytes"] for p in processes),
        "process_count": len(processes), "processes": processes,
        "exited_during_sample": exited,
    }


def binary_has_fixture_marker(executable: Path):
    """Bounded-memory preflight, including literals crossing chunk boundaries."""
    overlap = b""
    with executable.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            combined = overlap + chunk
            if FIXTURE_MARKER in combined:
                return True
            overlap = combined[-(len(FIXTURE_MARKER) - 1):]
    return False


def make_fixture(directory: Path, settings: dict):
    directory.mkdir()
    (directory / "dat").mkdir()
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=9)))
    thread_id = str(int(now.timestamp()) - 3600)
    ids = [str(int(thread_id) - n * 60) for n in range(3)]
    title = "【雀魂】じゃんたま mahjongsoul 比較用友人戦"
    posted = now - dt.timedelta(seconds=5)
    timestamp = posted.strftime("%Y/%m/%d") + "(" + "月火水木金土日"[posted.weekday()] + ") " + posted.strftime("%H:%M:%S.00")
    posts = [
        ("fixtureA", "四東 12345 友人戦 お待ちしています"),
        ("fixtureB", "三南 23456 友人部屋 募集"),
        ("fixtureA", "&gt;&gt;1 〆 満員です"),
        ("fixtureC", "四南 34567 友人戦 募集しています"),
    ]
    dat = "".join(f"名無しさん<>sage<>{timestamp} ID:{author}<>{body}<>{title}\n" for author, body in posts)
    (directory / "subject.txt").write_text("".join(f"{tid}.dat<>{title} {index + 1} ({len(posts)})\n" for index, tid in enumerate(ids)), encoding="utf-8")
    for tid in ids:
        (directory / "dat" / f"{tid}.dat").write_text(dat, encoding="utf-8")
    state = {"settings": settings, "watched": [thread_id], "cursors": {thread_id: 0}}
    return state, {
        "directory": str(directory), "generated_at_jst": now.isoformat(),
        "watched_thread": thread_id, "post_count": len(posts), "thread_count": len(ids),
        "subject_sha256": hashlib.sha256((directory / "subject.txt").read_bytes()).hexdigest(),
        "dat_sha256": hashlib.sha256(dat.encode()).hexdigest(),
        "state_sha256": hashlib.sha256(json.dumps(state, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
    }


def stop_group(process: subprocess.Popen, tree: ProcessTree | None):
    result = {"signals": [], "escaped_survivors": [], "group_survivors": []}
    # start_new_session=True guarantees the newly allocated group is process.pid.
    for sig, grace in ((signal.SIGTERM, 3.0), (signal.SIGKILL, 2.0)):
        members = tree.refresh() if tree is not None else {}
        if not any(p["pgrp"] == process.pid for p in members.values()):
            if process.poll() is not None:
                break
        try:
            os.killpg(process.pid, sig)
            result["signals"].append(sig.name)
        except ProcessLookupError:
            break
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            process.poll()  # Reap the root so zombies do not hold the group open.
            if tree is not None:
                if not any(p["pgrp"] == process.pid for p in tree.refresh().values()):
                    break
            else:
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    break
            time.sleep(0.05)
        else:
            continue
        break
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        result["root_wait_timed_out"] = True
    if tree is not None:
        survivors = tree.refresh().values()
        for item in survivors:
            key = "group_survivors" if item["pgrp"] == process.pid else "escaped_survivors"
            result[key].append(item)
    result["returncode_after_cleanup"] = process.returncode
    return result


def consume_fixture_marker(path: Path, offset: int, overlap: bytes):
    with path.open("rb") as handle:
        handle.seek(offset)
        chunk = handle.read()
        offset = handle.tell()
    combined = overlap + chunk
    return FIXTURE_MARKER in combined, offset, combined[-len(FIXTURE_MARKER):]


def measure(name: str, executable: Path, index: int, args, artifacts: Path, seed: dict, fixture: dict, x11: X11):
    directory = artifacts / f"{index:02d}-{name}"
    directory.mkdir()
    environment = os.environ.copy()
    home = directory / "home"
    home.mkdir()
    for key, relative in (("HOME", "home"), ("XDG_CONFIG_HOME", "config"), ("XDG_CACHE_HOME", "cache"), ("XDG_DATA_HOME", "data"), ("XDG_STATE_HOME", "state"), ("TMPDIR", "tmp")):
        path = directory / relative
        path.mkdir(exist_ok=True)
        environment[key] = str(path)
    # Forward X authentication to GUI libraries without reading its contents.
    environment["XAUTHORITY"] = os.environ.get("XAUTHORITY", str(Path.home() / ".Xauthority"))
    environment.update({
        "DISPLAY": args.display, "GDK_BACKEND": "x11", "WINIT_UNIX_BACKEND": "x11",
        "SURENECO_COMPARISON_FIXTURE": fixture["directory"],
    })
    environment.pop("WAYLAND_DISPLAY", None)
    state_paths = []
    for config_name in ("sureneco", "sureneco-iced"):
        state_path = directory / "config" / config_name / "state.json"
        state_path.parent.mkdir()
        state_path.write_text(json.dumps(seed, ensure_ascii=False), encoding="utf-8")
        state_paths.append(state_path)
    state_path = state_paths[0 if name == "tauri" else 1]
    stdout_path, stderr_path = directory / "stdout.log", directory / "stderr.log"
    result = {
        "index": index, "application": name, "executable": str(executable),
        "status": "failed", "directory": str(directory),
        "stdout": str(stdout_path), "stderr": str(stderr_path),
        "config_directory": str(state_path.parent), "samples": [],
        "fixture_marker_seen": False, "mapped_window_seconds": None,
    }
    process, tree = None, None
    started = time.monotonic()
    marker_offset, marker_overlap = 0, b""
    try:
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            process = subprocess.Popen([str(executable)], cwd=directory, env=environment, stdout=stdout, stderr=stderr, start_new_session=True)
            result["pid"] = process.pid
            tree = ProcessTree(process.pid)
            deadline = started + args.startup_timeout
            while True:
                if process.poll() is not None:
                    raise MeasurementError(f"Application exited before readiness (code {process.returncode}); inspect stderr")
                members = tree.refresh()
                if result["mapped_window_seconds"] is None:
                    windows = x11.mapped_windows(set(members))
                    if windows:
                        result["mapped_window_seconds"] = time.monotonic() - started
                        result["windows_at_mapping"] = windows
                marker, marker_offset, marker_overlap = consume_fixture_marker(stderr_path, marker_offset, marker_overlap)
                result["fixture_marker_seen"] |= marker
                if result["mapped_window_seconds"] is not None and result["fixture_marker_seen"]:
                    break
                if time.monotonic() >= deadline:
                    missing = []
                    if result["mapped_window_seconds"] is None:
                        missing.append("a mapped X11 window associated with the launched tree")
                    if not result["fixture_marker_seen"]:
                        missing.append("backend fixture activation marker (build both binaries with --features comparison-fixture)")
                    raise MeasurementError("Startup timed out waiting for " + " and ".join(missing))
                time.sleep(min(0.05, args.interval))
            result["fixture_ready_seconds"] = time.monotonic() - started
            settle_deadline = time.monotonic() + args.settle
            while time.monotonic() < settle_deadline:
                if process.poll() is not None:
                    raise MeasurementError("Application exited while settling")
                tree.refresh()
                time.sleep(min(0.05, max(0, settle_deadline - time.monotonic())))
            sample_start = time.monotonic()
            next_sample = sample_start
            while True:
                if process.poll() is not None:
                    raise MeasurementError(f"Application exited during measurement (code {process.returncode})")
                sample = sample_memory(tree, started)
                if not x11.mapped_windows({p["pid"] for p in sample["processes"]}):
                    raise MeasurementError("No launched-tree window remains viewable during sampling")
                result["samples"].append(sample)
                next_sample = max(next_sample + args.interval, time.monotonic())
                deadline = sample_start + args.duration
                if next_sample >= deadline:
                    remaining = deadline - time.monotonic()
                    if remaining > 0:
                        time.sleep(remaining)
                    break
                time.sleep(max(0, next_sample - time.monotonic()))
            result["sample_duration_seconds"] = time.monotonic() - sample_start
            if process.poll() is not None:
                raise MeasurementError("Application exited before the measurement duration finished")
            saved = json.loads(state_path.read_text(encoding="utf-8"))
            cursor = saved.get("cursors", {}).get(fixture["watched_thread"])
            result["fixture_saved_cursor"] = cursor
            if not isinstance(cursor, int) or cursor < fixture["post_count"]:
                raise MeasurementError("Watched fixture DAT was not consumed/saved; no comparable workload established")
            result["metrics"] = {
                "mapped_window_seconds": result["mapped_window_seconds"],
                "rss_median_bytes": statistics.median(s["rss_bytes"] for s in result["samples"]),
                "pss_median_bytes": statistics.median(s["pss_bytes"] for s in result["samples"]),
                "rss_peak_bytes": max(s["rss_bytes"] for s in result["samples"]),
                "pss_peak_bytes": max(s["pss_bytes"] for s in result["samples"]),
                "process_count_max": max(s["process_count"] for s in result["samples"]),
            }
            result["status"] = "ok"
    except KeyboardInterrupt as error:
        result["interrupted"] = True
        result["error"] = str(error) or "Interrupted"
    except (OSError, ValueError, MeasurementError) as error:
        result["error"] = f"{type(error).__name__}: {error}"
    finally:
        if process is not None:
            result["cleanup"] = stop_group(process, tree)
            if tree is not None:
                result["observed_processes"] = tree.history()
                result["unreadable_stat_scan_pids"] = sorted(tree.unreadable_scan_pids)
            if result["cleanup"]["escaped_survivors"] or result["cleanup"]["group_survivors"]:
                result["status"] = "failed"
                result["error"] = "Launched processes survived cleanup; see cleanup (escaped processes are not signaled)"
        result["total_elapsed_seconds"] = time.monotonic() - started
    return result


def positive_float(value: str):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("must be a finite number greater than zero")
    return number


def nonnegative_float(value: str):
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise argparse.ArgumentTypeError("must be a finite nonnegative number")
    return number


def positive_int(value: str):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return number


def parser():
    result = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Example:
  scripts/compare-native-ui.py --tauri src-tauri/target/release/sureneco \\
    --iced src-tauri/target/release/sureneco-iced --display :99 --output comparison.json

Requires Linux /proc with readable smaps[_rollup], libX11, an accessible X11
server (existing desktop or separately started Xvfb), and both comparison-fixture
release builds. This tool neither starts a virtual display nor builds binaries.
Uses fresh per-run config/data/cache/home directories, never discovers user app
settings. --state is an explicit seed only: settings are copied, watched/cursors
are replaced with the fixture thread. Custom settings can filter fixture content.
Both stdout/stderr and isolated state remain in OUTPUT.artifacts. Exit 0 requires
all requested runs to succeed; failed/partial runs are not included as successes.
PSS is mandatory. Process trees are observed, not an absolute containment claim.
""",
    )
    result.add_argument("--tauri", required=True, type=Path, help="Tauri release executable built with comparison-fixture")
    result.add_argument("--iced", required=True, type=Path, help="Iced release executable built with comparison-fixture")
    result.add_argument("--output", type=Path, default=Path("native-ui-comparison-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".json"), help="raw JSON report; must not exist (default: timestamped name)")
    result.add_argument("--display", default=os.environ.get("DISPLAY"), help="X11 display, default: DISPLAY; Wayland-only is unsupported")
    result.add_argument("--display-kind", choices=("desktop", "virtual", "unknown"), default="unknown", help="declare whether this is a real desktop or virtual display; not guessed")
    result.add_argument("--repeats", type=positive_int, default=3, help="runs per executable (default: 3), alternating first app per pair")
    result.add_argument("--duration", type=positive_float, default=10.0, help="memory sampling duration after readiness/settling (default: 10 seconds)")
    result.add_argument("--interval", type=positive_float, default=0.5, help="memory sampling interval (default: .5 seconds)")
    result.add_argument("--settle", type=nonnegative_float, default=2.0, help="settling time after mapped window AND fixture marker (default: 2 seconds)")
    result.add_argument("--startup-timeout", type=positive_float, default=30.0, help="timeout for mapped window AND fixture marker (default: 30 seconds)")
    result.add_argument("--state", type=Path, help="explicit SavedState JSON seed; omit to use current source defaults, never user config")
    result.add_argument("--iced-renderer", default="Iced tiny-skia software renderer (declared build contract, not runtime-detected)", help="record actual Iced build renderer; no runtime inference")
    result.add_argument("--tauri-renderer", default="WebKitGTK (GPU/compositor mode not runtime-detected)", help="record Tauri rendering/build configuration")
    return result


def write_report(path: Path, report: dict):
    # The output is reserved exclusively before any processes are started.
    with path.open("w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")


def main():
    args = parser().parse_args()
    args.output = args.output.resolve()
    artifacts = args.output.with_name(args.output.name + ".artifacts")
    try:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8"):
            pass
    except OSError as error:
        print(f"Cannot reserve output {args.output}: {error}", file=sys.stderr)
        return 2
    report = {
        "schema_version": 1, "status": "failed", "runs": [], "summary": {},
        "created_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "system": {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version()},
        "display": {"name": args.display, "kind": args.display_kind},
        "parameters": {
            "repeats": args.repeats, "duration_seconds": args.duration,
            "interval_seconds": args.interval, "settle_seconds": args.settle,
            "startup_timeout_seconds": args.startup_timeout,
            "order": "tauri,iced on odd pairs; iced,tauri on even pairs",
            "build_requirement": "Both binaries: release, comparison-fixture feature; no build-mode autodetection",
            "state_source": "explicit --state" if args.state else "embedded src/core/settings.ts defaults",
            "procfs_visibility": "Read permission to every observed live process smaps[_rollup] is required",
        },
        "rendering": {"iced": args.iced_renderer, "tauri": args.tauri_renderer},
        "rendering_environment": {key: os.environ[key] for key in ("LIBGL_ALWAYS_SOFTWARE", "WEBKIT_DISABLE_COMPOSITING_MODE", "WEBKIT_DISABLE_DMABUF_RENDERER", "GDK_SCALE", "GDK_DPI_SCALE", "WINIT_X11_SCALE_FACTOR", "ICED_BACKEND") if key in os.environ},
        "caveats": CAVEATS, "binaries": {}, "artifacts": str(artifacts),
    }
    x11 = None
    exit_code = 1
    old_handlers = {}
    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f"Interrupted by signal {signum}")
    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            old_handlers[sig] = signal.signal(sig, interrupted)
        if sys.platform != "linux":
            raise MeasurementError("This measurement tool requires Linux /proc")
        if not args.display:
            raise MeasurementError("No GUI display: supply --display or DISPLAY; no successful measurements can be produced")
        if args.interval > args.duration:
            raise MeasurementError("--interval must not exceed --duration")
        artifacts.mkdir(mode=0o700)
        executables = {}
        for name in ("tauri", "iced"):
            executable = getattr(args, name).resolve(strict=True)
            if not executable.is_file() or not os.access(executable, os.X_OK):
                raise MeasurementError(f"{name}: not an executable file: {executable}")
            marker_present = binary_has_fixture_marker(executable)
            report["binaries"][name] = {
                "path": str(executable), "size_bytes": executable.stat().st_size,
                "fixture_marker_literal_present": marker_present,
            }
            if not marker_present:
                raise MeasurementError(
                    f"{name}: fixture marker literal absent; refusing to launch a potentially "
                    "network-enabled ordinary build. Rebuild with --features comparison-fixture"
                )
            executables[name] = executable
        settings = copy.deepcopy(DEFAULT_SETTINGS)
        if args.state:
            supplied = json.loads(args.state.read_text(encoding="utf-8"))
            if not isinstance(supplied, dict):
                raise MeasurementError("--state must be a SavedState JSON object")
            supplied_settings = supplied.get("settings")
            if not isinstance(supplied_settings, dict):
                raise MeasurementError("--state must be a SavedState JSON object containing settings")
            missing = set(DEFAULT_SETTINGS) - set(supplied_settings)
            if missing:
                raise MeasurementError("--state settings missing fields: " + ", ".join(sorted(missing)))
            settings = {key: supplied_settings[key] for key in DEFAULT_SETTINGS}
        settings["allowed_watchois"] = ["comparison-no-notifications"]
        report["parameters"]["settings_overrides"] = {"allowed_watchois": settings["allowed_watchois"]}
        seed, fixture = make_fixture(artifacts / "fixture", settings)
        report["fixture"] = fixture
        horizon = 2 * args.repeats * (args.startup_timeout + args.settle + args.duration + 5)
        emphasis = settings.get("emphasis_sec")
        if isinstance(emphasis, (int, float)) and horizon >= emphasis:
            report["caveats"] = CAVEATS + ["Requested worst-case runtime can exceed emphasis_sec: fixture messages may age out. Consider a larger emphasis_sec in an explicit synthetic --state seed."]
        x11 = X11(args.display)
        report["display"].update(x11.info)
        write_report(args.output, report)
        for repeat in range(args.repeats):
            order = ("tauri", "iced") if repeat % 2 == 0 else ("iced", "tauri")
            for name in order:
                run = measure(name, executables[name], len(report["runs"]) + 1, args, artifacts, seed, fixture, x11)
                run["repeat"] = repeat + 1
                report["runs"].append(run)
                write_report(args.output, report)
                if run["status"] == "ok":
                    metrics = run["metrics"]
                    print(f"{name} #{repeat + 1}: mapped {metrics['mapped_window_seconds']:.3f}s; RSS {metrics['rss_median_bytes'] / 1048576:.2f} MiB; PSS {metrics['pss_median_bytes'] / 1048576:.2f} MiB", flush=True)
                else:
                    print(f"{name} #{repeat + 1}: FAILED: {run.get('error', 'unknown error')}", file=sys.stderr, flush=True)
                if run.get("interrupted"):
                    raise KeyboardInterrupt(run["error"])
                cleanup = run.get("cleanup", {})
                if cleanup.get("escaped_survivors") or cleanup.get("group_survivors"):
                    raise MeasurementError("Stopping remaining runs to avoid overlap with surviving launched processes")
        for name in ("tauri", "iced"):
            successes = [run for run in report["runs"] if run["application"] == name and run["status"] == "ok"]
            summary = {"successful_runs": len(successes), "requested_runs": args.repeats, "complete": len(successes) == args.repeats}
            if successes:
                summary["median_of_successful_run_metrics"] = {
                    key: statistics.median(run["metrics"][key] for run in successes)
                    for key in successes[0]["metrics"]
                }
            report["summary"][name] = summary
        if all(item["complete"] for item in report["summary"].values()):
            report["status"] = "ok"
            exit_code = 0
    except KeyboardInterrupt as error:
        report["error"] = str(error) or "Interrupted"
        exit_code = 130
    except (OSError, ValueError, TypeError, AttributeError, MeasurementError) as error:
        report["error"] = f"{type(error).__name__}: {error}"
        print(report["error"], file=sys.stderr)
    finally:
        if x11 is not None:
            x11.close()
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        write_report(args.output, report)
    print(f"Report: {args.output} ({report['status']})", flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
