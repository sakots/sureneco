import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "../src/core/settings";
const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const now = Math.floor(Date.now() / 1000);
function registration(uid: string, token = `token-${uid}`) {
  const {
    launcher_mode,
    launcher_path,
    launcher_args,
    launcher_profile,
    launcher_user_data_dir,
    ...settings
  } = defaults;
  void [
    launcher_mode,
    launcher_path,
    launcher_args,
    launcher_profile,
    launcher_user_data_dir,
  ];
  return {
    uid,
    input: {
      settings: { ...settings, update_sec: 60 },
      watched: ["1792548000"],
      consent: true,
      fcmToken: token,
    },
  };
}
async function database() {
  const dir = await mkdtemp(join(tmpdir(), "sureneco-delivery-"));
  directories.push(dir);
  return join(dir, "monitor.sqlite");
}
interface Output {
  calls: {
    token: string;
    eventId: string;
    revision: number;
    timeout: number;
  }[];
  notification_outbox: {
    event_id: string;
    attempts: number;
    next_attempt_at: number;
    revision: number;
  }[];
  notification_events: { event_id: string }[];
  subscriptions: { uid: string; fcm_token: string }[];
  notification_delivery_state: {
    uid: string;
    error_code: string | null;
    last_success_at: number | null;
  }[];
}
async function step(db: string, input: object): Promise<Output> {
  const running = execute("php", ["tests/fixtures/delivery.php"], {
    env: { ...process.env, SURENECO_SERVER_DB: db },
    timeout: 10000,
  });
  running.child.stdin!.end(JSON.stringify(input));
  const { stdout, stderr } = await running;
  expect(stderr).toBe("");
  return JSON.parse(stdout) as Output;
}
it("persists retry deadlines across processes, honors Retry-After and acknowledges only after success", async () => {
  const db = await database();
  const first = await step(db, {
    now,
    register: [registration("one")],
    queue: [{ uid: "one" }],
    deliver: { "token-one": "unavailable" },
    retryAfter: 180,
  });
  expect(first.calls).toHaveLength(1);
  expect(first.notification_outbox[0].attempts).toBe(1);
  expect(first.notification_outbox[0].next_attempt_at).toBeGreaterThanOrEqual(
    now + 180,
  );
  const waiting = await step(db, { now: now + 60, deliver: {} });
  expect(waiting.calls).toEqual([]);
  const next = first.notification_outbox[0].next_attempt_at;
  const done = await step(db, { now: next, deliver: {} });
  expect(done.calls[0].eventId).toBe(first.calls[0].eventId);
  expect(done.notification_outbox).toEqual([]);
  expect(done.notification_events).toHaveLength(1);
  expect(done.notification_delivery_state[0].last_success_at).toBe(next);
});
it("recovers a crash before acknowledgement with the same event ID and preserves deduplication", async () => {
  const db = await database();
  await step(db, {
    now,
    register: [registration("one")],
    queue: [{ uid: "one" }],
  });
  await expect(
    step(db, { now, deliver: { "token-one": "crash" } }),
  ).rejects.toMatchObject({ code: 77 });
  const pending = await step(db, { now });
  expect(pending.notification_outbox).toHaveLength(1);
  expect(pending.notification_outbox[0].attempts).toBe(1);
  const done = await step(db, {
    now: pending.notification_outbox[0].next_attempt_at,
    deliver: {},
  });
  expect(done.calls[0].eventId).toBe(pending.notification_outbox[0].event_id);
  expect(done.notification_outbox).toEqual([]);
  const duplicate = await step(db, {
    now: now + 500,
    queue: [{ uid: "one" }],
    deliver: {},
  });
  expect(duplicate.calls).toEqual([]);
});
it("caps retries at five attempts without losing deduplication or deleting the subscriber", async () => {
  const db = await database();
  let current = await step(db, {
    now,
    register: [registration("one")],
    queue: [{ uid: "one", ttl: 5000 }],
  });
  let at = now;
  for (let attempt = 1; attempt <= 5; attempt++) {
    current = await step(db, {
      now: at,
      deliver: { "token-one": "unavailable" },
    });
    expect(current.calls).toHaveLength(1);
    if (attempt < 5) {
      expect(current.notification_outbox[0].attempts).toBe(attempt);
      at = current.notification_outbox[0].next_attempt_at;
    }
  }
  expect(current.notification_outbox).toEqual([]);
  expect(current.notification_events).toHaveLength(1);
  expect(current.subscriptions).toHaveLength(1);
});
it("discards stopped, changed, closed and expired work and leaves budget-deferred messages untouched", async () => {
  const db = await database();
  const owners = ["stopped", "changed", "closed", "expired", "valid"];
  await step(db, {
    now,
    register: owners.map((uid) => registration(uid)),
    queue: owners.map((uid) => ({ uid, ttl: uid === "expired" ? 10 : 3600 })),
  });
  await step(db, {
    now: now + 20,
    stop: "stopped",
    close: "closed",
    register: [registration("changed", "new-token")],
  });
  const deferred = await step(db, { now: now + 20, deliver: {}, budgetMs: 0 });
  expect(deferred.calls).toEqual([]);
  expect(deferred.notification_outbox.every((row) => row.attempts === 0)).toBe(
    true,
  );
  const delivered = await step(db, { now: now + 20, deliver: {} });
  expect(delivered.calls.map((call) => call.token)).toEqual(["token-valid"]);
  expect(delivered.notification_events).toHaveLength(4);
});
it("invalidates only UNREGISTERED tokens and continues other deliveries", async () => {
  const db = await database();
  const owners = ["invalid", "bad-data", "valid"];
  const done = await step(db, {
    now,
    register: owners.map((uid) => registration(uid)),
    queue: owners.map((uid) => ({ uid })),
    deliver: {
      "token-invalid": "unregistered",
      "token-bad-data": "invalid_argument",
    },
  });
  expect(done.calls).toHaveLength(3);
  expect(done.subscriptions.map((row) => row.uid).sort()).toEqual([
    "bad-data",
    "valid",
  ]);
  expect(done.notification_outbox).toEqual([]);
});
it("does not delete a replacement token or new subscription when an in-flight token is rejected", async () => {
  const db = await database();
  const result = await step(db, {
    now,
    register: [registration("one")],
    queue: [{ uid: "one" }],
    during: registration("one", "new-token"),
    deliver: { "token-one": "unregistered" },
  });
  expect(result.subscriptions).toHaveLength(1);
  expect(result.subscriptions[0].fcm_token).toBe("new-token");
});
