import { createECDH, randomBytes } from "node:crypto";
import { challenge, confirm } from "../server/channels";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { subscriptions } from "../server/subscriptions";
import { defaults } from "../src/core/settings";
import { runDetection } from "../server/detection";
import { monitor, type Payload } from "../server/monitor";
import { deliver, DeliveryError } from "../server/delivery";
import { Scheduler } from "../server/scheduler";

// Integration cases perform many durable writes and worker starts on VPS disks.
// Keep the production worker/HTTP deadlines independent of this suite timeout.
vi.setConfig({ testTimeout: 30000 });

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const now = Date.parse("2026-10-22T12:00:00+09:00");
const thread = "1792548000";
function store() {
  const dir = mkdtempSync(join(tmpdir(), "sureneco-node-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Store(join(dir, "monitor.sqlite"));
  cleanup.push(() => db.close());
  return db;
}
const {
  launcher_mode,
  launcher_path,
  launcher_args,
  launcher_profile,
  launcher_user_data_dir,
  ...settings
} = defaults;
const pushKeys = new Map<string, { p256dh: string; auth: string }>();
function registration(token = "token-one", overrides = {}) {
  if (!pushKeys.has(token)) {
    const key = createECDH("prime256v1");
    key.generateKeys();
    pushKeys.set(token, {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    });
  }
  return {
    settings: { ...settings, update_sec: 60, ...overrides },
    watched: [thread],
    pushSubscription: {
      endpoint: "https://push.example/up" + token,
      keys: pushKeys.get(token)!,
    },
    consent: true,
  };
}
async function register(db: Store, uid = "one", input = registration()) {
  db.run(
    "INSERT OR IGNORE INTO devices(uid,token_hash,created) VALUES(?,?,?)",
    uid,
    "test-hash-" + uid,
    now,
  );
  const result = await subscriptions(
    db,
    uid,
    "PUT",
    input,
    now,
    "https://push.example",
  );
  expect(result.status).toBe(200);
  let message: any;
  await challenge(
    db,
    uid,
    {
      origin: "https://push.example",
      publicKey: "",
      send: async (_s, m) => {
        message = m;
      },
    },
    now,
  );
  if (message)
    return (
      await confirm(
        db,
        uid,
        { challenge: message.challenge, generation: message.generation },
        now,
      )
    ).body.subscription!;
  return result.body.subscription!;
}
const dat = (bodies: string[], at = now) =>
  bodies
    .map(
      (body, index) =>
        `名無し<>sage<>${new Date(at).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).replaceAll("-", "/")} 12:00:00 ID:author${index}<>${body}<>雀魂`,
    )
    .join("\n");

it("owns the database exclusively and restores subscriptions after restart", async () => {
  const db = store();
  const first = await register(db);
  expect(() => new Store(db.path)).toThrow();
  db.close();
  const reopened = new Store(db.path);
  cleanup.push(() => reopened.close());
  expect(
    (await subscriptions(reopened, "one", "GET", null, now)).body.subscription
      ?.revision,
  ).toBe(first.revision);
});
it("keeps revisions idempotent, separates owners, rejects token theft and marks resumed targets for a new baseline", async () => {
  const db = store();
  const first = await register(db);
  expect((await register(db)).revision).toBe(first.revision);
  expect(
    (await subscriptions(db, "other", "GET", null, now)).body.subscription,
  ).toBeNull();
  db.run(
    "INSERT OR IGNORE INTO devices(uid,token_hash,created) VALUES(?,?,?)",
    "other",
    "test-hash-other",
    now,
  );
  expect(
    (
      await subscriptions(
        db,
        "other",
        "PUT",
        registration(),
        now,
        "https://push.example",
      )
    ).status,
  ).toBe(409);
  const changed = await register(db, "one", registration("replacement"));
  expect(changed.revision).toBeGreaterThan(first.revision);
  const stopped = await subscriptions(db, "one", "POST", {}, now);
  expect(stopped.body.subscription?.active).toBe(false);
  expect(
    (await subscriptions(db, "one", "POST", {}, now)).body.subscription
      ?.revision,
  ).toBe(stopped.body.subscription?.revision);
  const resumed = await register(db, "one", registration("replacement"));
  expect(resumed.active).toBe(true);
  await subscriptions(db, "one", "DELETE", null, now);
  expect(
    (await subscriptions(db, "one", "GET", null, now)).body.subscription,
  ).toBeNull();
});
it("validates server settings, ownership fields, limits and consent before persisting", async () => {
  const db = store();
  for (const invalid of [
    registration("x", { update_sec: 20 }),
    registration("x", { update_sec: null }),
    registration("x", { launcher_path: "/bin/sh" }),
    registration("x", { yujinsen_regex: "[" }),
    registration("bad\n"),
    { ...registration(), consent: false },
    { ...registration(), uid: "victim" },
    { ...registration(), watched: [thread + "\n"] },
    { ...registration(), watched: Array(101).fill(thread) },
  ]) {
    expect(
      (
        await subscriptions(
          db,
          "invalid",
          "PUT",
          invalid,
          now,
          "https://push.example",
        )
      ).status,
    ).toBe(400);
  }
  const input = registration();
  delete (input.settings as Partial<typeof input.settings>).update_sec;
  const saved = await register(db, "defaults", input);
  expect(saved.settings.update_sec).toBe(60);
  expect(saved.settings.thread_update_sec).toBe(300);
  expect(JSON.stringify(saved)).not.toContain("token-one");
  for (let i = 0; i < 9; i++)
    await subscriptions(db, "defaults", "PUT", input, now);
  expect((await subscriptions(db, "defaults", "PUT", input, now)).status).toBe(
    429,
  );
});
it("notifies unwatched candidate additions once, retaining seen IDs after disappearance, expiry and restart", async () => {
  let db = store();
  const input = {
    ...registration("candidates", {
      thread_update_sec: 60,
      elapsed_days: 14,
      ng_thread_title_regex: "除外",
    }),
    watched: [],
  };
  const saved = await register(db, "one", input);
  const added = String(Number(thread) + 1);
  const excluded = String(Number(thread) + 2);
  const nonmatching = String(Number(thread) + 3);
  const old = String(Math.floor(now / 1000) - 15 * 86400);
  let subject = `${thread}.dat<>雀魂 (1)`;
  const fetcher = vi.fn(async () => subject);
  await monitor(db, { now, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
  subject += [
    "",
    `${added}.dat<>雀魂 &amp; 新スレ (1)`,
    `${excluded}.dat<>雀魂 除外 (1)`,
    `${nonmatching}.dat<>別の話題 (1)`,
    `${old}.dat<>雀魂 古いスレ (1)`,
  ].join("\n");
  await monitor(db, { now: now + 60000, fetcher });
  const queued = JSON.parse(
    db.get<{ payload: string }>("SELECT payload FROM outbox")!.payload,
  );
  expect(queued).toEqual({
    type: "new_thread",
    eventId: expect.stringMatching(/^[0-9a-f]{64}$/),
    revision: saved.revision,
    boardUrl: saved.settings.url,
    threadId: added,
    threadTitle: "雀魂 & 新スレ",
    expiresAt: Math.floor((now + 60000 + 86400000) / 1000),
  });
  expect(db.get("SELECT watched FROM subscriptions")?.watched).toBe("[]");
  const sent: Payload[] = [];
  await deliver(
    db,
    async (_token, payload) => {
      sent.push(payload);
    },
    { now: now + 60000 },
  );
  expect(sent).toEqual([{ ...queued, generation: saved.generation }]);
  subject = "";
  await monitor(db, { now: now + 120000, fetcher });
  db.prune(now + 86460001);
  expect(db.get("SELECT COUNT(*) AS n FROM events")?.n).toBe(0);
  const path = db.path;
  db.close();
  db = new Store(path);
  cleanup.push(() => db.close());
  subject = `${added}.dat<>雀魂 &amp; 新スレ (1)\n${thread}.dat<>雀魂 (1)`;
  await monitor(db, { now: now + 86460001, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
  expect(fetcher.mock.calls).toHaveLength(4);
});
it("establishes the first successful candidate baseline only after fetch and parse recovery, including an empty list", async () => {
  const db = store();
  await register(db, "one", {
    ...registration("recovery", { thread_update_sec: 60 }),
    watched: [],
  });
  let subject = "invalid subject";
  const fetcher = async () => subject;
  await monitor(db, {
    now,
    fetcher: async () => {
      throw new Error("offline");
    },
  });
  await monitor(db, { now: now + 60000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM candidate_state")?.n).toBe(0);
  subject = `${thread}.dat<>雀魂 (1)`;
  await monitor(db, { now: now + 120000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
  await subscriptions(db, "one", "DELETE", null, now + 120000);
  await register(db, "one", {
    ...registration("empty", { thread_update_sec: 60 }),
    watched: [],
  });
  subject = "";
  await monitor(db, { now: now + 180000, fetcher });
  subject = `${thread}.dat<>雀魂 (1)`;
  await monitor(db, { now: now + 240000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(1);
});
it("rolls back candidate seen IDs and polling with the new-thread outbox event", async () => {
  const db = store();
  await register(db, "one", {
    ...registration("transaction", { thread_update_sec: 60 }),
    watched: [],
  });
  let subject = "";
  const fetcher = async () => subject;
  await monitor(db, { now, fetcher });
  subject = `${thread}.dat<>雀魂 (1)`;
  db.run(
    "CREATE TRIGGER fail_candidate_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'save failure'); END",
  );
  await expect(monitor(db, { now: now + 60000, fetcher })).rejects.toThrow();
  expect(db.get("SELECT COUNT(*) AS n FROM candidate_seen")?.n).toBe(0);
  expect(db.get("SELECT attempted FROM fetch_state")?.attempted).toBe(now);
  expect(db.get("SELECT COUNT(*) AS n FROM events")?.n).toBe(0);
  db.run("DROP TRIGGER fail_candidate_outbox");
  await monitor(db, { now: now + 60000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(1);
});
it("preserves candidate history across same-board updates and resume, but resets it for a board switch", async () => {
  const db = store();
  const input = {
    ...registration("lifecycle", { thread_update_sec: 60 }),
    watched: [],
  };
  await register(db, "one", input);
  let subject = `${thread}.dat<>雀魂 (1)`;
  const fetcher = async () => subject;
  await monitor(db, { now, fetcher });
  const added = String(Number(thread) + 1);
  const changed = {
    ...input,
    settings: { ...input.settings, ng_words: ["blocked"] },
  };
  await register(db, "one", changed);
  subject += `\n${added}.dat<>雀魂 新スレ (1)`;
  await monitor(db, { now: now + 60000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(1);
  await subscriptions(db, "one", "POST", {}, now + 60000);
  await register(db, "one", changed);
  const resumed = String(Number(thread) + 2);
  subject += `\n${resumed}.dat<>雀魂 再開後 (1)`;
  await monitor(db, { now: now + 120000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(1);
  expect(
    JSON.parse(
      db.get<{ payload: string }>("SELECT payload FROM outbox")!.payload,
    ).threadId,
  ).toBe(resumed);
  const switched = {
    ...changed,
    settings: { ...changed.settings, url: "https://egg.5ch.io/test/" },
  };
  await register(db, "one", switched);
  await monitor(db, { now: now + 180000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
  expect(db.get("SELECT COUNT(*) AS n FROM candidate_state")?.n).toBe(1);
  expect(db.get("SELECT board FROM candidate_state")?.board).toBe(
    switched.settings.url,
  );
  const next = String(Number(thread) + 3);
  subject += `\n${next}.dat<>雀魂 別板の新スレ (1)`;
  await monitor(db, { now: now + 240000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(1);
  await subscriptions(db, "one", "DELETE", null, now + 240000);
  expect(db.get("SELECT COUNT(*) AS n FROM candidate_state")?.n).toBe(0);
  expect(db.get("SELECT COUNT(*) AS n FROM candidate_seen")?.n).toBe(0);
});
it("keeps new-thread events out of recruitment detection and applies filters even to watched threads", async () => {
  const db = store();
  const excluded = String(Number(thread) + 1);
  await register(db, "one", {
    ...registration("mixed", {
      thread_update_sec: 60,
      ng_thread_title_regex: "除外",
    }),
    watched: [thread, excluded],
  });
  let subject = "";
  let bodies = ["挨拶"];
  const fetcher = async (url: string) =>
    url.endsWith("subject.txt") ? subject : dat(bodies);
  await monitor(db, { now, fetcher });
  subject = `${thread}.dat<>雀魂 (2)\n${excluded}.dat<>雀魂 除外 (2)`;
  bodies.push("友人戦 12345");
  await monitor(db, { now: now + 60000, fetcher });
  const payloads = db
    .all<{ payload: string }>("SELECT payload FROM outbox")
    .map((row) => JSON.parse(row.payload) as Payload);
  expect(
    payloads
      .filter((item) => item.type === "new_thread")
      .map((item) => item.threadId),
  ).toEqual([thread]);
  expect(payloads.filter((item) => item.type === "recruitment")).toHaveLength(
    2,
  );
  bodies.push(">>2 〆");
  await monitor(db, { now: now + 120000, fetcher });
  const remaining = db
    .all<{ payload: string }>("SELECT payload FROM outbox")
    .map((row) => JSON.parse(row.payload) as Payload);
  expect(remaining.map((item) => item.type)).toEqual(["new_thread"]);
});
it("shares fetches, baselines old posts, respects 70 seconds, closes pending notices and survives restart", async () => {
  const db = store();
  await register(db, "one", registration("one", { update_sec: 70 }));
  await register(db, "two", registration("two", { update_sec: 70 }));
  let bodies = ["友人戦 12345"];
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    return url.endsWith("subject.txt")
      ? `${thread}.dat<>雀魂 (4)`
      : dat(bodies);
  };
  await monitor(db, { now, fetcher });
  expect(calls).toHaveLength(2);
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
  bodies.push("四東 23456");
  calls.length = 0;
  await monitor(db, { now: now + 60000, fetcher });
  expect(calls).toHaveLength(0);
  await monitor(db, { now: now + 70000, fetcher });
  expect(calls).toHaveLength(1);
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(2);
  bodies.push(">>2 〆");
  await monitor(db, { now: now + 140000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
  expect(db.get("SELECT COUNT(*) AS n FROM events")?.n).toBe(2);
});
it("does not commit a fetch that raced with stop, and resumes without sending old posts", async () => {
  const db = store();
  await register(db);
  let stopped = false;
  const fetcher = async (url: string) => {
    if (!stopped) {
      stopped = true;
      await subscriptions(db, "one", "POST", {}, now);
    }
    return url.endsWith("subject.txt")
      ? `${thread}.dat<>雀魂 (1)`
      : dat(["友人戦 12345"]);
  };
  await monitor(db, { now, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM fetch_state")?.n).toBe(0);
  expect(db.get("SELECT COUNT(*) AS n FROM candidate_state")?.n).toBe(0);
  await register(db);
  await monitor(db, { now: now + 60000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
});
it("persists a delivery attempt before send, retries with a bound, and preserves deduplication", async () => {
  const db = store();
  await register(db);
  let bodies = ["挨拶"];
  const fetcher = async (url: string) =>
    url.endsWith("subject.txt") ? `${thread}.dat<>雀魂 (2)` : dat(bodies);
  await monitor(db, { now, fetcher });
  bodies.push("友人戦 12345");
  await monitor(db, { now: now + 60000, fetcher });
  let attempts = 0;
  const sender = async () => {
    attempts++;
    expect(db.get("SELECT attempts FROM outbox")?.attempts).toBe(attempts);
    throw new DeliveryError("delivery_unavailable", true, 70);
  };
  await deliver(db, sender, { now: now + 60000, random: () => 0 });
  const nextAttempt = Number(
    db.get("SELECT next_attempt FROM outbox")?.next_attempt,
  );
  expect(nextAttempt).toBeGreaterThanOrEqual(now + 130000);
  expect(nextAttempt).toBeLessThan(now + 131000);
  await deliver(db, sender, { now: now + 129000 });
  expect(attempts).toBe(1);
  await deliver(db, async () => {}, { now: nextAttempt });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
  expect(db.get("SELECT COUNT(*) AS n FROM events")?.n).toBe(1);
});
it("isolates heavy regex and keeps the worker usable afterward", async () => {
  await expect(
    runDetection(
      {
        operation: "subject",
        subject: `${thread}.dat<>${"a".repeat(20000)}! (1)`,
        watched: [],
        settings: {
          ...defaults,
          thread_title_regex: "(a+)+$",
          elapsed_days: 1000,
        },
        now,
      },
      150,
    ),
  ).rejects.toMatchObject({ code: "execution_limit" });
  expect(
    await runDetection({ operation: "validate", patterns: ["(?<![0-9])四東"] }),
  ).toBeNull();
});
it("does not overlap scheduler runs and waits for in-flight work on shutdown", async () => {
  let finish!: () => void;
  let count = 0;
  const scheduler = new Scheduler(async () => {
    count++;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  }, 5);
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(count).toBe(1);
  const stopped = scheduler.stop();
  finish();
  await stopped;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(count).toBe(1);
});

it("uses the same core for reference rooms, allow-lists, NG and expired/closed targets", async () => {
  const { scanPosts } = await import("../src/core/detection");
  const post = (number: number, body: string, changes = {}) => ({
    number,
    body,
    name: "名無し",
    id: String(number),
    watchoi: "ﾜｯﾁｮｲ ok",
    postedAt: now - 1000,
    ...changes,
  });
  const posts = [
    post(1, "四東 ０１２３４"),
    post(2, ">>1 続けて募集"),
    post(3, "四南 23456 NG"),
    post(4, "友人戦 34567", { watchoi: "ﾜｯﾁｮｲ no" }),
    post(5, "友人戦 45678", { postedAt: now - 700000 }),
    post(6, ">>5 続けて募集"),
    post(7, "友人戦 56789"),
    post(8, ">>7 〆"),
    post(9, ">>7 続けて募集"),
  ];
  const filters = {
    ...defaults,
    ng_words: ["NG"],
    allowed_watchois: ["ﾜｯﾁｮｲ ok"],
  };
  const expected = scanPosts(thread, posts, [], filters, now);
  const result = await runDetection<{ notifications: { roomIds: string[] }[] }>(
    {
      operation: "scan",
      threadId: thread,
      posts,
      previous: [],
      sourcePosts: posts,
      settings: filters,
      now,
    },
  );
  expect(result).toEqual(expected);
  expect(result.notifications.map((x) => x.roomIds)).toEqual([
    ["01234"],
    ["01234"],
  ]);
});
it("rolls back cursor and event together on save failure, then recovers without losing notices", async () => {
  const db = store();
  await register(db);
  let bodies = ["挨拶"];
  const fetcher = async (url: string) =>
    url.endsWith("subject.txt") ? `${thread}.dat<>雀魂 (2)` : dat(bodies);
  await monitor(db, { now, fetcher });
  bodies.push("友人戦 12345");
  db.run(
    "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'save failure'); END",
  );
  await expect(monitor(db, { now: now + 60000, fetcher })).rejects.toThrow();
  expect(db.get("SELECT last_post FROM cursors")?.last_post).toBe(1);
  expect(db.get("SELECT COUNT(*) AS n FROM events")?.n).toBe(0);
  db.run("DROP TRIGGER fail_outbox");
  await monitor(db, { now: now + 60000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(1);
});
it("retains delivery attempts and deduplication across process restarts and configuration updates", async () => {
  let db = store();
  await register(db);
  let bodies = ["挨拶"];
  const fetcher = async (url: string) =>
    url.endsWith("subject.txt") ? `${thread}.dat<>雀魂 (3)` : dat(bodies);
  await monitor(db, { now, fetcher });
  bodies.push("友人戦 12345");
  await monitor(db, { now: now + 60000, fetcher });
  await deliver(
    db,
    async () => {
      throw new DeliveryError("delivery_unavailable");
    },
    { now: now + 60000, random: () => 0 },
  );
  db.run("UPDATE outbox SET payload=json_remove(payload,'$.type')");
  const path = db.path;
  db.close();
  db = new Store(path);
  cleanup.push(() => db.close());
  expect(db.get("SELECT attempts FROM outbox")?.attempts).toBe(1);
  expect(
    JSON.parse(
      db.get<{ payload: string }>("SELECT payload FROM outbox")!.payload,
    ).type,
  ).toBe("recruitment");
  await deliver(db, async () => {}, { now: now + 121000 });
  await register(db, "one", registration("changed", { ng_words: ["blocked"] }));
  await monitor(db, { now: now + 180000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
  expect(db.get("SELECT COUNT(*) AS n FROM events")?.n).toBe(1);
});
it("limits retries, expires notices, and cannot delete a replacement token on in-flight invalid endpoint", async () => {
  const db = store();
  await register(db);
  let bodies = ["挨拶"];
  const fetcher = async (url: string) =>
    url.endsWith("subject.txt") ? `${thread}.dat<>雀魂 (2)` : dat(bodies);
  await monitor(db, { now, fetcher });
  bodies.push("友人戦 12345");
  await monitor(db, { now: now + 60000, fetcher });
  await deliver(
    db,
    async () => {
      await register(db, "one", registration("new-token"));
      throw new DeliveryError("invalid_endpoint", false);
    },
    { now: now + 60000 },
  );
  expect(db.get("SELECT token FROM subscriptions")?.token).toContain(
    "upnew-token",
  );
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
  const id = "retry";
  const owner = db.get<{ revision: number }>(
    "SELECT revision FROM subscriptions",
  )!;
  db.run("INSERT INTO events VALUES(?,?,?)", id, "one", now + 10000000);
  const payload: Payload = {
    type: "new_thread",
    eventId: id,
    revision: owner.revision,
    boardUrl: settings.url,
    threadId: thread,
    threadTitle: "雀魂",
    expiresAt: (now + 10000000) / 1000,
  };
  db.run(
    "INSERT INTO outbox(id,uid,revision,expires,payload,created) VALUES(?,?,?,?,?,?)",
    id,
    "one",
    owner.revision,
    now + 10000000,
    JSON.stringify(payload),
    now,
  );
  let count = 0;
  for (let i = 0; i < 5; i++) {
    await deliver(
      db,
      async () => {
        count++;
        throw new DeliveryError("delivery_unavailable");
      },
      { now: now + i * 1000000, random: () => 0 },
    );
  }
  expect(count).toBe(5);
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
  expect(db.get("SELECT COUNT(*) AS n FROM events")?.n).toBeGreaterThan(0);
  db.prune(now + 10000001);
  expect(db.get("SELECT COUNT(*) AS n FROM events")?.n).toBe(0);
});
it("cancels every known closing event beyond the 200-item UI history limit", async () => {
  const db = store();
  await register(db);
  let bodies = ["挨拶"];
  const fetcher = async (url: string) =>
    url.endsWith("subject.txt") ? `${thread}.dat<>雀魂 (210)` : dat(bodies);
  await monitor(db, { now, fetcher });
  bodies.push(
    ...Array.from({ length: 205 }, (_, i) => `友人戦 ${String(10000 + i)}`),
  );
  await monitor(db, { now: now + 60000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(205);
  bodies.push(">>2 〆");
  await monitor(db, { now: now + 120000, fetcher });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(204);
});

it.each(["closed", "expired"])(
  "cancels referenced pending replies beyond the history limit when the source is %s",
  async (ended) => {
    const db = store();
    await register(db);
    const line = (body: string, time: string) =>
      `名無し<>sage<>2026/10/22(木) ${time} ID:author<>${body}<>雀魂`;
    let content = line("友人戦 12345", "12:00:00");
    const fetcher = async (url: string) =>
      url.endsWith("subject.txt") ? `${thread}.dat<>雀魂 (208)` : content;
    await monitor(db, { now, fetcher });
    content +=
      "\n" +
      [
        ...Array.from({ length: 205 }, () =>
          line("&gt;&gt;1 あと1人", "12:01:00"),
        ),
        line("友人戦 56789", "12:01:00"),
      ].join("\n");
    await monitor(db, { now: now + 60000, fetcher });
    expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(206);

    if (ended === "closed") {
      content += "\n" + line("&gt;&gt;1 〆", "12:02:00");
      await monitor(db, { now: now + 120000, fetcher });
    }
    const sent: string[][] = [];
    await deliver(
      db,
      async (_token, payload) => {
        if (payload.type === "recruitment")
          sent.push(payload.recruitment.roomIds);
      },
      { now: ended === "closed" ? now + 120000 : now + 600001 },
    );
    expect(sent).toEqual([["56789"]]);
    expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
  },
);
it("shares fetch failures and leaves cursors unchanged until a successful retry", async () => {
  const db = store();
  await register(db, "one", registration("one"));
  await register(db, "two", registration("two"));
  let calls = 0;
  await monitor(db, {
    now,
    fetcher: async () => {
      calls++;
      throw new Error("private transport details");
    },
  });
  expect(calls).toBe(2);
  expect(db.get("SELECT COUNT(*) AS n FROM cursors")?.n).toBe(0);
  const state = await subscriptions(db, "one", "GET", null, now);
  expect(state.body.subscription?.error).toBe("fetch_failed");
  expect(JSON.stringify(state)).not.toContain("private transport details");
  await monitor(db, {
    now: now + 300000,
    fetcher: async (url) =>
      url.endsWith("subject.txt")
        ? `${thread}.dat<>雀魂 (1)`
        : dat(["友人戦 12345"]),
  });
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
});

it("bounds worker input/output without blocking subsequent subscriptions", async () => {
  await expect(
    runDetection({ operation: "dat", dat: "x".repeat(17 * 1024 * 1024) }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  const large = dat(Array(4500).fill("x".repeat(1000)));
  await expect(
    runDetection({ operation: "dat", dat: large }),
  ).rejects.toMatchObject({ code: "execution_limit" });
  expect(
    await runDetection({ operation: "validate", patterns: ["四東"] }),
  ).toBeNull();
});
it("drops expired events before send and removes only a proven invalid recipient", async () => {
  const db = store();
  await register(db, "one", registration("one"));
  await register(db, "two", registration("two"));
  let bodies = ["挨拶"];
  const fetcher = async (url: string) =>
    url.endsWith("subject.txt") ? `${thread}.dat<>雀魂 (2)` : dat(bodies);
  await monitor(db, { now, fetcher });
  bodies.push("友人戦 12345");
  await monitor(db, { now: now + 60000, fetcher });
  const sent: string[] = [];
  await deliver(
    db,
    async (token) => {
      if (JSON.parse(token).endpoint.endsWith("upone"))
        throw new DeliveryError("invalid_endpoint", false);
      sent.push(JSON.parse(token).endpoint);
    },
    { now: now + 60000 },
  );
  expect(sent).toEqual(["https://push.example/uptwo"]);
  expect(
    db.get("SELECT active FROM subscriptions WHERE uid='one'"),
  ).toMatchObject({ active: 0 });
  bodies.push("友人戦 23456");
  await monitor(db, { now: now + 120000, fetcher });
  let expiredSends = 0;
  await deliver(
    db,
    async () => {
      expiredSends++;
    },
    { now: now + 700000 },
  );
  expect(expiredSends).toBe(0);
});
it("does not advance polling or cursors when the batch budget cannot fit detection", async () => {
  const db = store();
  await register(db);
  let calls = 0;
  const result = await monitor(db, {
    now,
    budget: 0,
    fetcher: async () => {
      calls++;
      return "";
    },
  });
  expect(result.deferred).toBe(true);
  expect(calls).toBe(0);
  expect(db.get("SELECT COUNT(*) AS n FROM fetch_state")?.n).toBe(0);
});

it("recovers after FCM accepts a message but saving success fails, using the same event ID", async () => {
  let db = store();
  await register(db);
  let bodies = ["挨拶"];
  const fetcher = async (url: string) =>
    url.endsWith("subject.txt") ? `${thread}.dat<>雀魂 (2)` : dat(bodies);
  await monitor(db, { now, fetcher });
  bodies.push("友人戦 12345");
  await monitor(db, { now: now + 60000, fetcher });
  db.run(
    "CREATE TRIGGER fail_success BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT,'disk failure'); END",
  );
  const ids: string[] = [];
  await expect(
    deliver(
      db,
      async (_token, payload) => {
        ids.push(payload.eventId);
      },
      { now: now + 60000, random: () => 0 },
    ),
  ).rejects.toThrow();
  expect(db.get("SELECT attempts FROM outbox")?.attempts).toBe(1);
  db.run("DROP TRIGGER fail_success");
  const path = db.path;
  db.close();
  db = new Store(path);
  cleanup.push(() => db.close());
  await deliver(
    db,
    async (_token, payload) => {
      ids.push(payload.eventId);
    },
    { now: now + 121000 },
  );
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(db.get("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(0);
});
it("continues healthy subscriptions after a regex timeout in the same monitoring pass", async () => {
  const db = store();
  await register(db, "bad", registration("bad", { yujinsen_regex: "(a+)+$" }));
  await register(db, "good", registration("good"));
  let bodies = ["挨拶"];
  const fetcher = async (url: string) =>
    url.endsWith("subject.txt") ? `${thread}.dat<>雀魂 (3)` : dat(bodies);
  await monitor(db, { now, fetcher });
  bodies.push("a".repeat(20000) + "!", "友人戦 12345");
  const result = await monitor(db, { now: now + 60000, fetcher });
  expect(result.errors).toBe(1);
  expect(db.get("SELECT uid FROM outbox")?.uid).toBe("good");
  expect(
    (await subscriptions(db, "bad", "GET", null, now)).body.subscription?.error,
  ).toBe("execution_limit");
});
