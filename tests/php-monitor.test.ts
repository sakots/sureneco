import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "../src/core/settings";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number") throw new Error("Expected number");
  return value;
}
function pollOutput(json: string) {
  const value = object(JSON.parse(json));
  if (typeof value.failed !== "boolean")
    throw new Error("Expected failure flag");
  return {
    failed: value.failed,
    calls: array(value.calls).map(text),
    cursors: array(value.cursors).map((entry) => ({
      last_post: number(object(entry).last_post),
    })),
    events: array(value.events).map((entry) => ({
      event_id: text(object(entry).event_id),
    })),
    outbox: array(value.outbox).map((entry) => {
      const row = object(entry);
      const recruitment = object(object(row.payload).recruitment);
      return {
        uid: text(row.uid),
        event_id: text(row.event_id),
        payload: {
          recruitment: {
            number: number(recruitment.number),
            roomIds: array(recruitment.roomIds).map(text),
          },
        },
      };
    }),
    subscriptions: array(value.subscriptions).map((entry) => {
      const row = object(entry);
      return {
        uid: text(row.uid),
        active: number(row.active),
        error_code: row.error_code === null ? null : text(row.error_code),
      };
    }),
  };
}

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
const thread = "1792548000";
const board = "https://egg.5ch.io/mj/";
const subject = `${board}subject.txt`;
const dat = `${board}dat/${thread}.dat`;
const {
  launcher_mode,
  launcher_path,
  launcher_args,
  launcher_profile,
  launcher_user_data_dir,
  ...mobileSettings
} = defaults;
void [
  launcher_mode,
  launcher_path,
  launcher_args,
  launcher_profile,
  launcher_user_data_dir,
];
function registration(uid: string, changes = {}) {
  return {
    uid,
    input: {
      consent: true,
      watched: [thread],
      fcmToken: `token-${uid}`,
      settings: { ...mobileSettings, update_sec: 60, ...changes },
    },
  };
}
function posts(
  bodies: (
    string | { body: string; id?: string; seconds?: number; watchoi?: string }
  )[],
) {
  return bodies
    .map((entry) => {
      const item = typeof entry === "string" ? { body: entry } : entry;
      const date = new Date((now + (item.seconds ?? 0) + 9 * 3600) * 1000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ")
        .replaceAll("-", "/");
      return `名無し (${item.watchoi ?? "ﾜｯﾁｮｲ abcd-1234"})<>sage<>${date} ID:${item.id ?? "author"}<>${item.body}<>雀魂`;
    })
    .join("\n");
}
function responses(text: string) {
  return { [subject]: `${thread}.dat<>雀魂 - じゃんたま - (100)`, [dat]: text };
}
async function database() {
  const directory = await mkdtemp(join(tmpdir(), "sureneco-poll-"));
  directories.push(directory);
  return join(directory, "monitor.sqlite");
}
async function step(path: string, input: Record<string, unknown>) {
  const running = execute(
    "php",
    [
      "-r",
      String.raw`
    require 'server/bootstrap.php';
    require 'server/monitor.php';
    $db = Sureneco\openDatabase();
    Sureneco\initializeSubscriptionSchema($db);
    $input = json_decode(stream_get_contents(STDIN), true, 64, JSON_THROW_ON_ERROR);
    foreach ($input['register'] ?? [] as $registration) {
      $body = json_decode(json_encode($registration['input']), false, 64, JSON_THROW_ON_ERROR);
      $response = Sureneco\subscriptionRequest($db, $registration['uid'], 'PUT', '/v1/subscription', $body);
      if ($response['status'] !== 200) { throw new RuntimeException(json_encode($response)); }
    }
    if (isset($input['stop'])) { Sureneco\subscriptionRequest($db, $input['stop'], 'POST', '/v1/subscription/stop', null); }
    if (isset($input['queueFailure'])) {
      $db->exec('CREATE TRIGGER fail_outbox BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT, "unavailable"); END');
    }
    if (isset($input['clearQueueFailure'])) { $db->exec('DROP TRIGGER fail_outbox'); }
    $calls = [];
    $result = null;
    $failed = false;
    if (isset($input['now'])) {
      $fetch = function (string $url, int $timeoutMs) use (&$calls, &$input, $db): string {
        $calls[] = $url;
        if (isset($input['stopDuringFetch'])) {
          Sureneco\subscriptionRequest($db, $input['stopDuringFetch'], 'POST', '/v1/subscription/stop', null);
          unset($input['stopDuringFetch']);
        }
        $value = $input['responses'][$url] ?? null;
        if (!is_string($value)) { throw new Sureneco\BoardFetchException('http_error'); }
        return $value;
      };
      try { $result = Sureneco\runMonitoringBatch($db, $input['now'], $fetch, $input['budgetMs'] ?? 50000); }
      catch (Throwable) { $failed = true; }
    }
    echo json_encode([
      'calls' => $calls, 'result' => $result, 'failed' => $failed,
      'cursors' => $db->query('SELECT * FROM subscription_cursors ORDER BY uid, thread_id')->fetchAll(),
      'outbox' => array_map(function ($row) { $row['payload'] = json_decode($row['payload_json'], true); unset($row['payload_json']); return $row; }, $db->query('SELECT * FROM notification_outbox ORDER BY uid, event_id')->fetchAll()),
      'events' => $db->query('SELECT * FROM notification_events ORDER BY uid, event_id')->fetchAll(),
      'subscriptions' => $db->query('SELECT uid, active, last_fetch_success_at, error_code FROM subscriptions ORDER BY uid')->fetchAll(),
    ], JSON_THROW_ON_ERROR);
  `,
    ],
    {
      env: { ...process.env, SURENECO_SERVER_DB: path },
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  running.child.stdin!.end(JSON.stringify(input));
  const { stdout, stderr } = await running;
  expect(stderr).toBe("");
  const output = pollOutput(stdout);
  if (!input.queueFailure) expect(output.failed).toBe(false);
  return output;
}

it("shares subject/dat fetches, suppresses initial history and preserves events across separate cron processes", async () => {
  const db = await database();
  const initial = await step(db, {
    register: [registration("one"), registration("two")],
    now,
    responses: responses(posts(["友人戦 11111"])),
  });
  expect(initial.calls.sort()).toEqual([subject, dat].sort());
  expect(initial.outbox).toEqual([]);
  const updated = await step(db, {
    now: now + 60,
    responses: responses(
      posts(["友人戦 11111", { body: "友人戦 12345", seconds: 60 }]),
    ),
  });
  expect(updated.calls).toEqual([dat]);
  expect(
    updated.outbox.map((row) => [row.uid, row.payload.recruitment.roomIds]),
  ).toEqual([
    ["one", ["12345"]],
    ["two", ["12345"]],
  ]);
  expect(updated.cursors.map((row) => row.last_post)).toEqual([2, 2]);
  const restarted = await step(db, {
    now: now + 120,
    responses: responses(
      posts(["友人戦 11111", { body: "友人戦 12345", seconds: 60 }]),
    ),
  });
  expect(restarted.outbox.map((row) => row.event_id)).toEqual(
    updated.outbox.map((row) => row.event_id),
  );
  expect(restarted.events).toHaveLength(2);
});

it("honors 70-second intervals on minute ticks and does not reset cursors on a settings revision", async () => {
  const db = await database();
  await step(db, {
    register: [registration("slow", { update_sec: 70 })],
    now,
    responses: responses(posts(["通常レス"])),
  });
  const skipped = await step(db, { now: now + 60, responses: {} });
  expect(skipped.calls).toEqual([]);
  const text = posts(["通常レス", { body: "友人戦 12345", seconds: 100 }]);
  const due = await step(db, { now: now + 120, responses: responses(text) });
  expect(due.calls).toEqual([dat]);
  expect(due.outbox.map((row) => row.payload.recruitment.number)).toEqual([2]);
  const changed = await step(db, {
    register: [registration("slow", { update_sec: 70, ng_words: ["blocked"] })],
    now: now + 240,
    responses: responses(text),
  });
  expect(changed.outbox).toEqual([]);
  expect(changed.events).toHaveLength(1);
  expect(changed.cursors[0].last_post).toBe(2);
});

it("uses a fresh baseline after stopping or removing a watched thread without replaying downtime posts", async () => {
  const db = await database();
  await step(db, {
    register: [registration("one")],
    now,
    responses: responses(posts(["通常レス"])),
  });
  await step(db, { stop: "one" });
  const resumed = await step(db, {
    register: [registration("one")],
    now: now + 60,
    responses: responses(posts(["通常レス", "友人戦 12345"])),
  });
  expect(resumed.outbox).toEqual([]);
  expect(resumed.cursors[0].last_post).toBe(2);
  const removed = registration("one");
  removed.input.watched = [];
  await step(db, { register: [removed] });
  const readded = await step(db, {
    register: [registration("one")],
    now: now + 120,
    responses: responses(posts(["通常レス", "友人戦 12345", "友人戦 23456"])),
  });
  expect(readded.outbox).toEqual([]);
  expect(readded.cursors[0].last_post).toBe(3);
});

it("applies per-subscriber NG and allow lists, cancels known closing posts and expires pending events", async () => {
  const db = await database();
  await step(db, {
    register: [
      registration("allowed", { allowed_watchois: ["ﾜｯﾁｮｲ abcd-1234"] }),
      registration("blocked", { ng_ids: ["author"] }),
    ],
    now,
    responses: responses(posts(["通常レス"])),
  });
  const queued = await step(db, {
    now: now + 60,
    responses: responses(
      posts(["通常レス", { body: "友人戦 12345", seconds: 60 }]),
    ),
  });
  expect(queued.outbox.map((row) => row.uid)).toEqual(["allowed"]);
  const closed = await step(db, {
    now: now + 120,
    responses: responses(
      posts([
        "通常レス",
        { body: "友人戦 12345", seconds: 60 },
        { body: ">>2 〆", id: "other", seconds: 120 },
        { body: "友人戦 23456", seconds: 120 },
      ]),
    ),
  });
  expect(closed.outbox.map((row) => row.payload.recruitment.number)).toEqual([
    4,
  ]);
  const expired = await step(db, {
    now: now + 1000,
    responses: responses(posts(["通常レス"])),
  });
  expect(expired.outbox).toEqual([]);
});

it("shares failed fetches and isolates pathological subscription regex from other subscribers", async () => {
  const db = await database();
  await step(db, {
    register: [
      registration("bad", { yujinsen_regex: "^(a+)+$" }),
      registration("good"),
    ],
    now,
    responses: responses(posts(["通常レス"])),
  });
  const failed = await step(db, { now: now + 60, responses: {} });
  expect(failed.calls).toEqual([dat]);
  expect(failed.cursors.map((row) => row.last_post)).toEqual([1, 1]);
  expect(failed.subscriptions.map((row) => row.error_code)).toEqual([
    "http_error",
    "http_error",
  ]);
  const recovered = await step(db, {
    now: now + 120,
    responses: responses(
      posts([
        "通常レス",
        "a".repeat(100) + "!",
        { body: "友人戦 12345", seconds: 120 },
      ]),
    ),
  });
  expect(recovered.calls).toEqual([dat]);
  expect(recovered.outbox.map((row) => row.uid)).toEqual(["good"]);
  expect(
    recovered.subscriptions.find((row) => row.uid === "bad")?.error_code,
  ).toBe("execution_limit");
  expect(
    recovered.subscriptions.find((row) => row.uid === "good")?.error_code,
  ).toBeNull();
});

it("discards work fetched under a stopped revision and leaves budget-deferred work unconsumed", async () => {
  const db = await database();
  const initial = await step(db, {
    register: [registration("one")],
    now,
    budgetMs: 1,
    responses: {},
  });
  expect(initial.calls).toEqual([]);
  expect(initial.cursors).toEqual([]);
  const stopped = await step(db, {
    now: now + 60,
    stopDuringFetch: "one",
    responses: responses(posts(["友人戦 12345"])),
  });
  expect(stopped.subscriptions[0].active).toBe(0);
  expect(stopped.cursors).toEqual([]);
  expect(stopped.outbox).toEqual([]);
});

it("rolls back the cursor and event together when outbox persistence fails, then retries without loss", async () => {
  const db = await database();
  await step(db, {
    register: [registration("one")],
    now,
    responses: responses(posts(["通常レス"])),
  });
  const text = posts(["通常レス", { body: "友人戦 12345", seconds: 60 }]);
  const failed = await step(db, {
    now: now + 60,
    queueFailure: true,
    responses: responses(text),
  });
  expect(failed.failed).toBe(true);
  expect(failed.cursors[0].last_post).toBe(1);
  expect(failed.events).toEqual([]);
  const recovered = await step(db, {
    now: now + 120,
    clearQueueFailure: true,
    responses: responses(text),
  });
  expect(
    recovered.outbox.map((row) => row.payload.recruitment.roomIds),
  ).toEqual([["12345"]]);
  expect(recovered.cursors[0].last_post).toBe(2);
});

it("cancels a pending recruitment outside the UI's 200-item history window", async () => {
  const db = await database();
  await step(db, {
    register: [registration("one")],
    now,
    responses: responses(posts(["通常レス"])),
  });
  const recruitments = Array.from({ length: 201 }, () => ({
    body: "友人戦 12345",
    seconds: 60,
  }));
  const queued = await step(db, {
    now: now + 60,
    responses: responses(posts(["通常レス", ...recruitments])),
  });
  expect(queued.outbox.map((row) => row.payload.recruitment.number)).toContain(
    2,
  );
  const closed = await step(db, {
    now: now + 120,
    responses: responses(
      posts(["通常レス", ...recruitments, { body: ">>2 〆", seconds: 120 }]),
    ),
  });
  expect(
    closed.outbox.map((row) => row.payload.recruitment.number),
  ).not.toContain(2);
  expect(closed.outbox.map((row) => row.payload.recruitment.number)).toContain(
    202,
  );
});
