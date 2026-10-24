"""Deterministic stdlib tests; run: python3 -m unittest discover -s tests -p test_notification_monitor.py."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "notification_monitor", Path(__file__).resolve().parents[1] / "scripts/notification-monitor.py"
)
monitor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = monitor
SPEC.loader.exec_module(monitor)
NOW = 2_000_000_000.0


def api(**changes):
    value = {
        "lastStartedAt": (NOW - 20) * 1000,
        "lastFinishedAt": (NOW - 10) * 1000,
        "error": None,
        "outbox": {"count": 0, "oldestCreatedAt": None},
        "monitoringReady": False,
    }
    value.update(changes)
    return value


class EvaluationTests(unittest.TestCase):
    def test_api_freshness_boundary_and_ignored_readiness(self):
        self.assertTrue(monitor.evaluate_api(api(lastFinishedAt=(NOW - 300) * 1000), NOW).healthy)
        result = monitor.evaluate_api(api(lastFinishedAt=(NOW - 300.001) * 1000), NOW)
        self.assertFalse(result.healthy)
        self.assertTrue(result.immediate)

    def test_bad_api_schema_timestamps_and_error_are_sustained(self):
        for value in [None, {}, api(lastFinishedAt=True), api(lastStartedAt=(NOW + 1) * 1000),
                      api(lastFinishedAt=float("nan")), api(lastFinishedAt=0),
                      api(lastStartedAt=10 ** 1000),
                      api(error="secret upstream text"), api(error=12),
                      api(outbox={"count": -1, "oldestCreatedAt": None}),
                      api(outbox={"count": 1, "oldestCreatedAt": (NOW + 1) * 1000})]:
            with self.subTest(value=value):
                result = monitor.evaluate_api(value, NOW)
                self.assertFalse(result.healthy)
                self.assertFalse(result.immediate)
                self.assertNotIn("secret", result.summary)

    def test_queue_metadata_does_not_invent_an_alert_threshold(self):
        result = monitor.evaluate_api(api(outbox={"count": 12, "oldestCreatedAt": (NOW - 900) * 1000}), NOW)
        self.assertTrue(result.healthy)
        self.assertEqual(result.details["outboxOldestAgeSeconds"], 900)

    def test_ntfy_requires_literal_true(self):
        self.assertTrue(monitor.evaluate_ntfy({"healthy": True}).healthy)
        for value in [{"healthy": 1}, {"healthy": "true"}, {}, None]:
            self.assertFalse(monitor.evaluate_ntfy(value).healthy)

    def test_backup_age_and_outcome_ordering(self):
        self.assertTrue(monitor.evaluate_backup(NOW - 26 * 3600, None, NOW).healthy)
        self.assertFalse(monitor.evaluate_backup(NOW - 26 * 3600 - .01, None, NOW).healthy)
        self.assertFalse(monitor.evaluate_backup(None, None, NOW).healthy)
        failure = {"version": 1, "outcome": "failure", "time": NOW - 1}
        self.assertFalse(monitor.evaluate_backup(NOW - 20, failure, NOW).healthy)
        self.assertTrue(monitor.evaluate_backup(NOW, failure, NOW).healthy)
        self.assertTrue(monitor.evaluate_backup(NOW - 20, dict(failure, outcome="success"), NOW).healthy)
        self.assertTrue(monitor.evaluate_backup(NOW - 1, failure, NOW).healthy)
        same_second_failure = {"version": 1, "outcome": "failure", "time": NOW - .25}
        self.assertFalse(monitor.evaluate_backup(NOW - .75, same_second_failure, NOW).healthy)

    def test_malformed_or_future_outcome_is_not_healthy(self):
        for outcome in [{}, {"version": True, "outcome": "success", "time": NOW},
                        {"version": 1, "outcome": "success", "time": NOW + 1},
                        {"version": 1, "outcome": "failure", "time": True},
                        {"version": 1, "outcome": "success", "time": NOW, "log": "secret"}]:
            self.assertFalse(monitor.evaluate_backup(NOW, outcome, NOW).healthy)
        self.assertFalse(monitor.evaluate_backup(NOW + 1, None, NOW).healthy)


class TransitionTests(unittest.TestCase):
    healthy = monitor.Observation(True, False, "正常")
    failed = monitor.Observation(False, False, "接続失敗")
    stale = monitor.Observation(False, True, "更新停止")

    def test_three_failures_reset_and_first_healthy_baseline(self):
        state, event = monitor.advance(None, self.healthy)
        self.assertIsNone(event)
        for _ in range(2):
            state, event = monitor.advance(state, self.failed)
            self.assertIsNone(event)
        state, event = monitor.advance(state, self.healthy)
        self.assertIsNone(event)
        self.assertEqual(state["failures"], 0)
        for index in range(3):
            state, event = monitor.advance(state, self.failed)
            self.assertEqual(event, "alert" if index == 2 else None)

    def test_failed_send_retries_then_deduplicates_and_recovers(self):
        state, event = monitor.advance(None, self.stale)
        self.assertEqual(event, "alert")
        # No acknowledgement means SMTP failed: the very next poll retries.
        state, event = monitor.advance(state, self.stale)
        self.assertEqual(event, "alert")
        state = monitor.delivered(state, event)
        state, event = monitor.advance(state, self.stale)
        self.assertIsNone(event)
        state, event = monitor.advance(state, self.healthy)
        self.assertEqual(event, "recovery")
        state, event = monitor.advance(state, self.healthy)
        self.assertEqual(event, "recovery")
        state = monitor.delivered(state, event)
        state, event = monitor.advance(state, self.healthy)
        self.assertIsNone(event)

    def test_unsent_alert_never_creates_recovery(self):
        state, _ = monitor.advance(None, self.stale)
        state, event = monitor.advance(state, self.healthy)
        self.assertIsNone(event)

    def test_recovery_requires_successful_check_not_subthreshold_failure(self):
        state, event = monitor.advance(None, self.stale)
        state = monitor.delivered(state, event)
        state, event = monitor.advance(state, self.failed)
        self.assertIsNone(event)
        self.assertTrue(state["alerted"])


@unittest.skipUnless(os.name == "posix", "Linux filesystem safety contract")
class FilesystemTests(unittest.TestCase):
    def test_snapshot_regular_names_and_status_atomic_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshots = root / "repository/snapshots"
            snapshots.mkdir(parents=True)
            valid = snapshots / ("a" * 64)
            valid.write_bytes(b"encrypted")
            os.utime(valid, (NOW - 10, NOW - 10))
            (snapshots / ("b" * 64)).symlink_to(valid)
            (snapshots / ("c" * 64)).mkdir()
            (snapshots / "unrelated").write_text("ignored")
            result = monitor.check_backup(root, NOW)
            self.assertTrue(result.healthy)
            status = root / "backup-status.pending"
            status.write_text(json.dumps({"version": 1, "outcome": "failure", "time": NOW - 1}))
            status.replace(root / "backup-status.json")
            self.assertFalse(monitor.check_backup(root, NOW).healthy)
            (root / "backup-status.json").unlink()
            (root / "backup-status.json").symlink_to(valid)
            self.assertFalse(monitor.check_backup(root, NOW).healthy)

    def test_oversized_status_and_symlink_snapshot_directory_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "repository/snapshots").mkdir(parents=True)
            (root / "backup-status.json").write_bytes(b" " * 4097)
            self.assertFalse(monitor.check_backup(root, NOW).healthy)
            (root / "repository/snapshots").rmdir()
            (root / "elsewhere").mkdir()
            (root / "repository/snapshots").symlink_to(root / "elsewhere", target_is_directory=True)
            self.assertFalse(monitor.check_backup(root, NOW).healthy)

    @unittest.skipUnless(hasattr(os, "getuid") and os.getuid() == 0, "root ownership contract")
    def test_atomic_state_roundtrip_is_private_and_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            path = root / "state.json"
            state = {"version": 1, "targets": {"api": {"failures": 2, "alerted": True}}}
            monitor.save_state(path, state)
            self.assertEqual(monitor.load_state(path), state)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            path.unlink()
            other = root / "other"
            other.write_text("{}")
            path.symlink_to(other)
            with self.assertRaises(monitor.MonitorError):
                monitor.save_state(path, state)
            self.assertEqual(other.read_text(), "{}")


if __name__ == "__main__":
    unittest.main()
