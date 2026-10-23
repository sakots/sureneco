import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DeviceAuth } from "../server/device-auth";
import {
  NtfyRegistration,
  ntfyDeliveryAllowed,
  type NtfyAdminPort,
} from "../server/ntfy-registration";
import { Store } from "../server/store";

type Operation = "ensure" | "grant" | "revoke" | "remove";
class Admin implements NtfyAdminPort {
  readonly calls: string[] = [];
  readonly accounts = new Map<string, string>();
  readonly topics = new Map<string, Set<string>>();
  before?: (operation: Operation, uid: string, topic?: string) => Promise<void>;
  after?: (operation: Operation, uid: string, topic?: string) => Promise<void>;
  private async invoke(
    operation: Operation,
    uid: string,
    topic?: string,
    password?: string,
  ) {
    this.calls.push(operation + (topic ? ":" + topic : ""));
    await this.before?.(operation, uid, topic);
    if (operation === "ensure") {
      if (!this.accounts.has(uid)) this.accounts.set(uid, password!);
    } else if (operation === "grant") {
      const topics = this.topics.get(uid) ?? new Set<string>();
      topics.add(topic!);
      this.topics.set(uid, topics);
    } else if (operation === "revoke") this.topics.get(uid)?.delete(topic!);
    else {
      this.accounts.delete(uid);
      this.topics.delete(uid);
    }
    await this.after?.(operation, uid, topic);
  }
  ensureAccount(uid: string, password: string) {
    return this.invoke("ensure", uid, undefined, password);
  }
  grantRead(uid: string, topic: string) {
    return this.invoke("grant", uid, topic);
  }
  revokeRead(uid: string, topic: string) {
    return this.invoke("revoke", uid, topic);
  }
  removeAccount(uid: string) {
    return this.invoke("remove", uid);
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function pause(admin: Admin, operation: Operation) {
  const entered = deferred();
  const release = deferred();
  admin.before = async (current) => {
    if (current !== operation) return;
    admin.before = undefined;
    entered.resolve();
    await release.promise;
  };
  return { entered: entered.promise, release: release.resolve };
}
let db: Store;
let dir: string;
let admin: Admin;
let registration: NtfyRegistration;
let auth: DeviceAuth;
let deviceNumber = 0;
afterEach(() => {
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  dir = mkdtempSync(join(tmpdir(), "sureneco-ntfy-registration-"));
  db = new Store(join(dir, "db"));
  admin = new Admin();
  registration = new NtfyRegistration(db, admin);
  auth = new DeviceAuth(db);
  return device();
}
function device() {
  return auth.issue("device-" + ++deviceNumber, 1000).deviceId;
}
function reopen() {
  db.close();
  db = new Store(join(dir, "db"));
  auth = new DeviceAuth(db);
  registration = new NtfyRegistration(db, admin);
}
function legacySubscription(uid: string, topic: string) {
  db.run(
    "INSERT INTO subscriptions(uid,revision,active,settings,watched,token,endpoint,generation,consented,created,updated) VALUES(?,1,0,'{}','[]',?,?,?,1,1,1)",
    uid,
    "token-" + uid,
    "https://push.example/" + topic,
    "generation-" + uid,
  );
}

it("persists stable credentials and desired ownership before provisioning, then becomes ready idempotently", async () => {
  const uid = setup();
  expect(registration.get(uid)).toBeNull();
  const view = registration.put(uid, "upFirst");
  expect(view).toEqual({
    topic: "upFirst",
    username: "sur_" + uid.replaceAll("-", ""),
    password: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    state: "pending",
    error: null,
  });
  expect(admin.calls).toEqual([]);
  expect(
    db.get("SELECT password FROM ntfy_registrations WHERE uid=?", uid),
  ).toMatchObject({ password: view.password });
  admin.before = async () => {
    expect(registration.get(uid)?.password).toBe(view.password);
    expect(
      db.get("SELECT uid FROM ntfy_topics WHERE topic='upFirst'"),
    ).toMatchObject({ uid });
    expect(db.get("SELECT uid FROM ntfy_jobs WHERE uid=?", uid)).toMatchObject({
      uid,
    });
  };
  await registration.tick(1000);
  expect(admin.calls).toEqual(["ensure", "grant:upFirst"]);
  expect(registration.get(uid)).toEqual({ ...view, state: "ready" });
  expect(admin.accounts.get(uid)).toBe(view.password);
  expect(registration.put(uid, "upFirst")).toEqual({ ...view, state: "ready" });
  await registration.tick(2000);
  expect(admin.calls).toHaveLength(2);
  expect(db.get("SELECT uid FROM ntfy_jobs WHERE uid=?", uid)).toBeUndefined();
});

it("rejects unsafe topics, unknown or tombstoned devices, and cross-device reservations without mutation", async () => {
  const uid = setup();
  const other = device();
  for (const topic of [
    "",
    "up",
    "UPx",
    "up*",
    "up/a",
    "up x",
    "up\nx",
    "https://push.example/upx",
    "up" + "a".repeat(63),
  ])
    expect(() => registration.put(uid, topic)).toThrow("invalid_ntfy_topic");
  expect(registration.get(uid)).toBeNull();
  const current = registration.put(uid, "upOwned");
  expect(() => registration.put(other, "upOwned")).toThrow("topic_conflict");
  expect(registration.get(other)).toBeNull();
  expect(registration.get(uid)).toEqual(current);
  await registration.tick(1000);
  expect(() => registration.put(other, "upOwned")).toThrow("topic_conflict");
  for (const call of [
    () => registration.get("unknown"),
    () => registration.put("unknown", "upOther"),
    () => registration.stop("unknown"),
    () => registration.removeDevice("unknown"),
  ])
    expect(call).toThrow("unauthorized");
  registration.removeDevice(uid);
  expect(() => registration.put(uid, "upOther")).toThrow("unauthorized");
  expect(() => registration.get(uid)).toThrow("unauthorized");
});

it("respects legacy topic ownership but lets its own device adopt its existing endpoint", () => {
  const uid = setup();
  const other = device();
  legacySubscription(uid, "upLegacy");
  expect(() => registration.put(other, "upLegacy")).toThrow("topic_conflict");
  expect(registration.put(uid, "upLegacy").topic).toBe("upLegacy");
});

it("revokes the old topic before granting the new one and retains old ownership until cleanup", async () => {
  const uid = setup();
  const other = device();
  const initial = registration.put(uid, "upOld");
  await registration.tick(1000);
  const changed = registration.put(uid, "upNew");
  expect(changed).toEqual({ ...initial, topic: "upNew", state: "pending" });
  expect(() => registration.put(other, "upOld")).toThrow("topic_conflict");
  const waiting = pause(admin, "revoke");
  const work = registration.tick(2000);
  await waiting.entered;
  expect(ntfyDeliveryAllowed(db, uid, "https://push.example/upOld")).toBe(
    false,
  );
  expect(ntfyDeliveryAllowed(db, uid, "https://push.example/upNew")).toBe(
    false,
  );
  waiting.release();
  await work;
  expect(admin.calls).toEqual([
    "ensure",
    "grant:upOld",
    "revoke:upOld",
    "grant:upNew",
  ]);
  expect([...admin.topics.get(uid)!]).toEqual(["upNew"]);
  expect(registration.put(other, "upOld").state).toBe("pending");
  expect(registration.get(uid)?.state).toBe("ready");
});

it("persists sanitized failures and bounded retries across restart without changing credentials", async () => {
  const uid = setup();
  const initial = registration.put(uid, "upRetry");
  admin.before = async () => {
    throw new Error("secret password and raw CLI output");
  };
  await registration.tick(1000);
  expect(registration.get(uid)).toEqual({
    ...initial,
    error: "ntfy_admin_failed",
  });
  const first = db.get<{ attempts: number; next_attempt: number }>(
    "SELECT attempts,next_attempt FROM ntfy_jobs WHERE uid=?",
    uid,
  )!;
  expect(first.attempts).toBe(1);
  expect(first.next_attempt).toBeGreaterThan(1000);
  expect(
    JSON.stringify(db.get("SELECT * FROM ntfy_jobs WHERE uid=?", uid)),
  ).not.toContain("secret");
  reopen();
  await registration.tick(first.next_attempt - 1);
  expect(admin.calls).toEqual(["ensure"]);
  await registration.tick(first.next_attempt);
  const second = db.get<{ attempts: number; next_attempt: number }>(
    "SELECT attempts,next_attempt FROM ntfy_jobs WHERE uid=?",
    uid,
  )!;
  expect(second.attempts).toBe(2);
  expect(second.next_attempt - first.next_attempt).toBeGreaterThan(
    first.next_attempt - 1000,
  );
  admin.before = undefined;
  await registration.tick(second.next_attempt);
  expect(registration.get(uid)).toEqual({ ...initial, state: "ready" });
  expect(admin.accounts.get(uid)).toBe(initial.password);
});

it("never grants a replacement while revocation fails, including after a restart", async () => {
  const uid = setup();
  registration.put(uid, "upBefore");
  await registration.tick(1000);
  registration.put(uid, "upAfter");
  admin.before = async (operation) => {
    if (operation === "revoke") throw new Error("private failure");
  };
  await registration.tick(2000);
  expect(admin.calls).not.toContain("grant:upAfter");
  const retry = db.get<{ next_attempt: number }>(
    "SELECT next_attempt FROM ntfy_jobs WHERE uid=?",
    uid,
  )!.next_attempt;
  reopen();
  admin.before = undefined;
  await registration.tick(retry);
  expect(admin.calls.slice(-2)).toEqual(["revoke:upBefore", "grant:upAfter"]);
  expect([...admin.topics.get(uid)!]).toEqual(["upAfter"]);
});

it("supersedes a failed uncertain grant with account deletion immediately rather than waiting for its backoff", async () => {
  const uid = setup();
  const initial = registration.put(uid, "upUncertain");
  admin.after = async (operation) => {
    if (operation === "grant")
      throw new Error("connection lost after applying ACL");
  };
  await registration.tick(1000);
  expect(admin.topics.get(uid)?.has("upUncertain")).toBe(true);
  expect(registration.stop(uid)).toEqual({ ...initial, state: "pending" });
  admin.after = undefined;
  await registration.tick(1001);
  expect(admin.calls).toEqual(["ensure", "grant:upUncertain", "remove"]);
  expect(registration.get(uid)).toEqual({ ...initial, state: "stopped" });
  expect(admin.accounts.has(uid)).toBe(false);
});

it("does not grant a stale topic after account creation finishes during a desired-state change", async () => {
  const uid = setup();
  registration.put(uid, "upStale");
  const waiting = pause(admin, "ensure");
  const work = registration.tick(1000);
  await waiting.entered;
  registration.put(uid, "upCurrent");
  waiting.release();
  await work;
  expect(admin.calls).toEqual(["ensure", "grant:upCurrent"]);
  expect(registration.get(uid)).toMatchObject({
    topic: "upCurrent",
    state: "ready",
  });
});

it("cleans up a stale in-flight grant before provisioning the newest topic", async () => {
  const uid = setup();
  const other = device();
  registration.put(uid, "upStale");
  const waiting = pause(admin, "grant");
  const work = registration.tick(1000);
  await waiting.entered;
  registration.put(uid, "upCurrent");
  expect(() => registration.put(other, "upStale")).toThrow("topic_conflict");
  expect(registration.get(uid)?.state).toBe("pending");
  waiting.release();
  await work;
  expect(admin.calls).toEqual([
    "ensure",
    "grant:upStale",
    "revoke:upStale",
    "grant:upCurrent",
  ]);
  expect([...admin.topics.get(uid)!]).toEqual(["upCurrent"]);
});

it("does not adopt a stale grant completion even when the newest desired topic has the same name", async () => {
  const uid = setup();
  registration.put(uid, "upRepeated");
  const first = pause(admin, "grant");
  const work = registration.tick(1000);
  await first.entered;
  registration.put(uid, "upIntermediate");
  registration.put(uid, "upRepeated");
  const second = pause(admin, "grant");
  first.release();
  await second.entered;
  expect(registration.get(uid)?.state).toBe("pending");
  expect(ntfyDeliveryAllowed(db, uid, "https://push.example/upRepeated")).toBe(
    false,
  );
  second.release();
  await work;
  expect(admin.calls).toEqual([
    "ensure",
    "grant:upRepeated",
    "grant:upRepeated",
  ]);
  expect(registration.get(uid)?.state).toBe("ready");
});

it("stops durably, retries account deletion, releases ownership only on success, and resumes with stable credentials", async () => {
  const uid = setup();
  const other = device();
  const initial = registration.put(uid, "upStopped");
  await registration.tick(1000);
  expect(registration.stop(uid)).toEqual(initial);
  admin.before = async (operation) => {
    if (operation === "remove") throw new Error("private DB path");
  };
  await registration.tick(2000);
  expect(() => registration.put(other, "upStopped")).toThrow("topic_conflict");
  expect(registration.get(uid)).toEqual({
    ...initial,
    error: "ntfy_admin_failed",
  });
  const retry = db.get<{ next_attempt: number }>(
    "SELECT next_attempt FROM ntfy_jobs WHERE uid=?",
    uid,
  )!.next_attempt;
  reopen();
  admin.before = undefined;
  await registration.tick(retry);
  expect(registration.get(uid)).toEqual({ ...initial, state: "stopped" });
  expect(registration.stop(uid)?.state).toBe("stopped");
  expect(registration.put(other, "upStopped").state).toBe("pending");
  expect(registration.put(uid, "upResumed")).toEqual({
    ...initial,
    topic: "upResumed",
  });
  await registration.tick(retry + 1);
  expect(admin.accounts.get(uid)).toBe(initial.password);
  expect(registration.get(uid)?.state).toBe("ready");
});

it("preserves deletion tombstones and cleanup jobs through device cascades and restart", async () => {
  const uid = setup();
  registration.put(uid, "upDeleted");
  await registration.tick(1000);
  registration.removeDevice(uid);
  auth.remove(uid);
  expect(
    db.get("SELECT uid FROM ntfy_registrations WHERE uid=?", uid),
  ).toMatchObject({ uid });
  expect(db.get("SELECT uid FROM ntfy_jobs WHERE uid=?", uid)).toMatchObject({
    uid,
  });
  expect(ntfyDeliveryAllowed(db, uid, "https://push.example/upDeleted")).toBe(
    false,
  );
  admin.before = async () => {
    throw new Error("temporarily unavailable");
  };
  await registration.tick(2000);
  const retry = db.get<{ next_attempt: number }>(
    "SELECT next_attempt FROM ntfy_jobs WHERE uid=?",
    uid,
  )!.next_attempt;
  reopen();
  admin.before = undefined;
  await registration.tick(retry);
  expect(admin.accounts.has(uid)).toBe(false);
  expect(db.get("SELECT uid FROM ntfy_jobs WHERE uid=?", uid)).toBeUndefined();
  expect(
    db.get("SELECT * FROM ntfy_registrations WHERE uid=?", uid),
  ).toBeUndefined();
  expect(
    db.get("SELECT topic FROM ntfy_topics WHERE uid=?", uid),
  ).toBeUndefined();
  expect(registration.put(device(), "upDeleted").state).toBe("pending");
});

it("removes a grant that finishes after device deletion without ever making the tombstone ready", async () => {
  const uid = setup();
  registration.put(uid, "upRemovedInflight");
  const waiting = pause(admin, "grant");
  const work = registration.tick(1000);
  await waiting.entered;
  registration.removeDevice(uid);
  auth.remove(uid);
  waiting.release();
  await work;
  expect(admin.calls).toEqual(["ensure", "grant:upRemovedInflight", "remove"]);
  expect(admin.accounts.has(uid)).toBe(false);
  expect(
    db.get("SELECT * FROM ntfy_registrations WHERE uid=?", uid),
  ).toBeUndefined();
});

it("recreates the account if a stop is reversed while deletion is in flight", async () => {
  const uid = setup();
  const initial = registration.put(uid, "upResumeInflight");
  await registration.tick(1000);
  registration.stop(uid);
  const waiting = pause(admin, "remove");
  const work = registration.tick(2000);
  await waiting.entered;
  expect(registration.put(uid, "upResumeInflight")).toEqual(initial);
  waiting.release();
  await work;
  expect(admin.calls).toEqual([
    "ensure",
    "grant:upResumeInflight",
    "remove",
    "ensure",
    "grant:upResumeInflight",
  ]);
  expect(admin.accounts.get(uid)).toBe(initial.password);
  expect(registration.get(uid)?.state).toBe("ready");
});

it("recovers from an uncertain deletion failure when registration resumes during the call", async () => {
  const uid = setup();
  const initial = registration.put(uid, "upUncertainRemove");
  await registration.tick(1000);
  registration.stop(uid);
  const waiting = pause(admin, "remove");
  const work = registration.tick(2000);
  await waiting.entered;
  registration.put(uid, "upAfterUncertainRemove");
  admin.after = async (operation) => {
    if (operation === "remove") {
      admin.after = undefined;
      throw new Error("connection lost after deletion");
    }
  };
  waiting.release();
  await work;
  expect(admin.calls).toEqual([
    "ensure",
    "grant:upUncertainRemove",
    "remove",
    "remove",
    "ensure",
    "grant:upAfterUncertainRemove",
  ]);
  expect(admin.accounts.get(uid)).toBe(initial.password);
  expect(registration.get(uid)).toMatchObject({
    topic: "upAfterUncertainRemove",
    state: "ready",
  });
});

it("retains an account-deletion job even if registration is stopped before the first tick", async () => {
  const uid = setup();
  expect(registration.stop(uid)).toBeNull();
  registration.put(uid, "upNeverStarted");
  registration.stop(uid);
  reopen();
  await registration.tick(1000);
  expect(admin.calls).toEqual(["remove"]);
  expect(registration.get(uid)?.state).toBe("stopped");
});

it("finishes an interrupted deletion before recreating a newly requested account after restart", async () => {
  const uid = setup();
  const initial = registration.put(uid, "upBeforeInterruptedDelete");
  await registration.tick(1000);
  registration.stop(uid);
  db.run("UPDATE ntfy_registrations SET account_ready=0 WHERE uid=?", uid);
  db.run("UPDATE ntfy_jobs SET operation='remove' WHERE uid=?", uid);
  admin.accounts.delete(uid);
  admin.topics.delete(uid);
  registration.put(uid, "upAfterInterruptedDelete");
  admin.calls.length = 0;
  reopen();
  await registration.tick(2000);
  expect(admin.calls).toEqual([
    "remove",
    "ensure",
    "grant:upAfterInterruptedDelete",
  ]);
  expect(admin.accounts.get(uid)).toBe(initial.password);
  expect(registration.get(uid)?.state).toBe("ready");
});

it("replays an interrupted durable operation and ignores obsolete replay work after a desired-state change", async () => {
  const uid = setup();
  const initial = registration.put(uid, "upInterrupted");
  // Reproduce a process exit after persisting invocation intent and applying the
  // ACL, but before acknowledging its successful completion in SQLite.
  db.run(
    "UPDATE ntfy_registrations SET account_ready=1,account_may_exist=1 WHERE uid=?",
    uid,
  );
  db.run(
    "UPDATE ntfy_topics SET granted=1,applied_generation=NULL WHERE uid=?",
    uid,
  );
  db.run(
    "UPDATE ntfy_jobs SET operation='grant',topic='upInterrupted' WHERE uid=?",
    uid,
  );
  admin.accounts.set(uid, initial.password);
  admin.topics.set(uid, new Set(["upInterrupted"]));
  reopen();
  await registration.tick(1000);
  expect(admin.calls).toEqual(["grant:upInterrupted"]);
  expect(registration.get(uid)).toEqual({ ...initial, state: "ready" });
  registration.put(uid, "upNext");
  db.run(
    "UPDATE ntfy_jobs SET generation=generation-1,operation='grant',topic='upInterrupted' WHERE uid=?",
    uid,
  );
  reopen();
  await registration.tick(2000);
  expect(admin.calls).toEqual([
    "grant:upInterrupted",
    "revoke:upInterrupted",
    "grant:upNext",
  ]);
});

it("serializes overlapping ticks even when a second reconciler shares the store", async () => {
  const uid = setup();
  registration.put(uid, "upSerialized");
  const waiting = pause(admin, "ensure");
  const work = registration.tick(1000);
  await waiting.entered;
  await registration.tick(1000);
  await new NtfyRegistration(db, admin).tick(1000);
  expect(admin.calls).toEqual(["ensure"]);
  waiting.release();
  await work;
  expect(admin.calls).toEqual(["ensure", "grant:upSerialized"]);
});

it("allows legacy delivery only without a registration and otherwise requires the exact ready topic", async () => {
  const uid = setup();
  expect(ntfyDeliveryAllowed(db, uid, "https://push.example/upLegacy")).toBe(
    true,
  );
  registration.put(uid, "upReady");
  expect(ntfyDeliveryAllowed(db, uid, "https://push.example/upReady")).toBe(
    false,
  );
  await registration.tick(1000);
  expect(ntfyDeliveryAllowed(db, uid, "https://push.example/upReady")).toBe(
    true,
  );
  expect(
    ntfyDeliveryAllowed(db, uid, "https://push.example/upReady?up=1"),
  ).toBe(true);
  for (const endpoint of [
    "https://push.example/upOther",
    "https://push.example/upReady/extra",
    "https://push.example/%75pReady",
    "https://user:password@push.example/upReady",
    "https://push.example/upReady#fragment",
    "http://push.example/upReady",
    "not a URL",
  ])
    expect(ntfyDeliveryAllowed(db, uid, endpoint)).toBe(false);
  registration.stop(uid);
  expect(ntfyDeliveryAllowed(db, uid, "https://push.example/upReady")).toBe(
    false,
  );
  await registration.tick(2000);
  expect(ntfyDeliveryAllowed(db, uid, "https://push.example/upReady")).toBe(
    false,
  );
});

it("removes an account created after stop was requested without ever granting its topic", async () => {
  const uid = setup();
  registration.put(uid, "upStopDuringEnsure");
  const waiting = pause(admin, "ensure");
  const work = registration.tick(1000);
  await waiting.entered;
  registration.stop(uid);
  waiting.release();
  await work;
  expect(admin.calls).toEqual(["ensure", "remove"]);
  expect(registration.get(uid)?.state).toBe("stopped");
  expect(admin.accounts.has(uid)).toBe(false);
});

it("bounds repeated retry delays and keeps one failing device from blocking another", async () => {
  const failing = setup();
  const healthy = device();
  registration.put(failing, "upFailing");
  registration.put(healthy, "upHealthy");
  admin.before = async (_operation, uid) => {
    if (uid === failing) throw new Error("administrator unavailable");
  };
  let now = 1000;
  for (let attempt = 1; attempt <= 12; attempt++) {
    await registration.tick(now);
    const job = db.get<{ attempts: number; next_attempt: number }>(
      "SELECT attempts,next_attempt FROM ntfy_jobs WHERE uid=?",
      failing,
    )!;
    expect(job.attempts).toBe(attempt);
    expect(job.next_attempt - now).toBeLessThanOrEqual(300000);
    expect(job.next_attempt - now).toBeGreaterThan(0);
    if (attempt >= 10) expect(job.next_attempt - now).toBe(300000);
    now = job.next_attempt;
  }
  expect(registration.get(healthy)?.state).toBe("ready");
  expect(registration.get(failing)).toMatchObject({
    state: "pending",
    error: "ntfy_admin_failed",
  });
});
