import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaults } from "../src/core/settings";

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "sureneco-subscriptions-"));
  directories.push(directory);
  return join(directory, "subscriptions.sqlite");
}

function registration() {
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
    settings: { ...settings, update_sec: 60 },
    watched: ["1234567890"],
    fcmToken: "fixture-device-token-A",
    consent: true,
  };
}

async function run(database: string, code: string, input: unknown = null) {
  const inputPath = join(dirname(database), "request.json");
  await writeFile(inputPath, JSON.stringify(input));
  const result = await execute(
    "php",
    [
      "-r",
      `
    require 'server/subscriptions.php';
    $db = new PDO('sqlite:' . $argv[1], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    Sureneco\\initializeSubscriptionSchema($db);
    $input = json_decode(file_get_contents($argv[2]), false, 64, JSON_THROW_ON_ERROR);
    ${code}
  `,
      database,
      inputPath,
    ],
    { cwd: root, timeout: 5_000, maxBuffer: 2 * 1024 * 1024 },
  );
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function request(
  database: string,
  method: string,
  input: unknown = null,
  uid = "owner-A",
  path = "/v1/subscription",
) {
  return run(
    database,
    `echo json_encode(Sureneco\\subscriptionRequest($db, ${JSON.stringify(uid)}, ${JSON.stringify(method)}, ${JSON.stringify(path)}, $input), JSON_THROW_ON_ERROR);`,
    input,
  );
}

it("registers actual persisted mobile settings with defaults and canonical resend semantics", async () => {
  const database = await databasePath();
  expect(await request(database, "GET")).toEqual({
    status: 200,
    body: { subscription: null },
  });
  const input = registration();
  delete (input.settings as Partial<typeof input.settings>).update_sec;
  delete (input.settings as Partial<typeof input.settings>).thread_update_sec;
  input.settings.url = "https://EGG.5ch.io/mj";
  input.settings.ng_words = [" blocked ", "blocked", ""];
  input.watched = ["1234567890", "1234567890"];
  const first = await request(database, "PUT", input);
  expect(first.status).toBe(200);
  expect(first.body.subscription).toMatchObject({
    active: true,
    settings: {
      update_sec: 60,
      thread_update_sec: 300,
      url: "https://egg.5ch.io/mj/",
      ng_words: ["blocked"],
    },
    watched: ["1234567890"],
    lastFetchSuccessAt: null,
    error: null,
    monitoringReady: false,
  });
  expect(first.body.subscription.revision).toBeGreaterThan(0);
  expect(first.body.subscription).not.toHaveProperty("fcmToken");
  expect(first.body.subscription.settings).not.toHaveProperty("launcher_path");
  expect(await request(database, "PUT", input)).toEqual(first);
  expect(await request(database, "GET")).toEqual(first);
  expect(
    await run(
      database,
      "echo json_encode($db->query('SELECT COUNT(*) FROM subscriptions')->fetchColumn());",
    ),
  ).toBe(1);
});

it("rejects missing consent, foreign ownership, desktop settings and malformed or oversized settings", async () => {
  const database = await databasePath();
  const valid = registration();
  const invalid: unknown[] = [
    null,
    [],
    "settings",
    {},
    { ...valid, consent: false },
    { ...valid, uid: "owner-B" },
    { ...valid, ownerUid: "owner-B" },
    { ...valid, message: "caller-controlled notification" },
    { ...valid, fcmToken: "bad\nrecipient" },
    { ...valid, fcmToken: "" },
    { ...valid, watched: ["123"] },
    {
      ...valid,
      watched: Array.from({ length: 101 }, (_, n) => String(1234567890 + n)),
    },
    { ...valid, settings: [] },
    { ...valid, settings: { ...valid.settings, launcher_path: "/bin/sh" } },
    { ...valid, settings: { ...valid.settings, config_directory: "/tmp" } },
    { ...valid, settings: { ...valid.settings, update_sec: 59 } },
    { ...valid, settings: { ...valid.settings, thread_update_sec: 20 } },
    { ...valid, settings: { ...valid.settings, update_sec: 60.5 } },
    { ...valid, settings: { ...valid.settings, elapsed_days: 0 } },
    { ...valid, settings: { ...valid.settings, emphasis_sec: "600" } },
    {
      ...valid,
      settings: { ...valid.settings, url: "https://evil.example/mj/" },
    },
    {
      ...valid,
      settings: { ...valid.settings, url: "https://egg.5ch.io/mj/?key=x" },
    },
    {
      ...valid,
      settings: { ...valid.settings, url: "https://egg.5ch.io:443/mj/" },
    },
    { ...valid, settings: { ...valid.settings, ng_words: [5] } },
    { ...valid, settings: { ...valid.settings, ng_words: ["x".repeat(501)] } },
    { ...valid, settings: { ...valid.settings, allowed_watchois: null } },
    {
      ...valid,
      settings: { ...valid.settings, thread_title_regex: "x".repeat(1001) },
    },
  ];
  // Each identity is independently limited; validation cases must not exhaust that budget.
  for (const [index, input] of invalid.entries()) {
    const response = await request(database, "PUT", input, `invalid-${index}`);
    expect(response.status, JSON.stringify(input)).toBe(400);
    expect(response.body).toEqual({ error: "invalid_subscription" });
  }
  const oversize = {
    ...valid,
    settings: {
      ...valid.settings,
      ng_words: Array.from({ length: 1000 }, () => "x".repeat(500)),
    },
  };
  expect(await request(database, "PUT", oversize)).toEqual({
    status: 413,
    body: { error: "payload_too_large" },
  });
  expect(
    await run(
      database,
      "echo json_encode($db->query('SELECT COUNT(*) FROM subscriptions')->fetchColumn());",
    ),
  ).toBe(0);
});

it("preserves bounded JavaScript pattern text without pretending PCRE validates its semantics", async () => {
  const database = await databasePath();
  const input = registration();
  input.settings.yujinsen_regex = "(?<room>\\u0031{5})";
  const response = await request(database, "PUT", input);
  expect(response.status).toBe(200);
  expect(response.body.subscription.settings.yujinsen_regex).toBe(
    input.settings.yujinsen_regex,
  );
  expect(response.body.subscription.monitoringReady).toBe(false);
});

it("never reads or mutates another owner and rejects owner-selected paths and bodies", async () => {
  const database = await databasePath();
  const original = await request(database, "PUT", registration());
  expect(await request(database, "GET", null, "owner-B")).toEqual({
    status: 200,
    body: { subscription: null },
  });
  for (const method of ["GET", "DELETE", "POST"]) {
    const path =
      method === "POST" ? "/v1/subscription/stop" : "/v1/subscription";
    expect(
      (await request(database, method, { uid: "owner-A" }, "owner-B", path))
        .status,
    ).toBe(400);
  }
  expect(
    (
      await request(
        database,
        "DELETE",
        null,
        "owner-B",
        "/v1/subscription/owner-A",
      )
    ).status,
  ).toBe(404);
  expect((await request(database, "PUT", registration(), "")).status).toBe(401);
  expect(await request(database, "GET")).toEqual(original);
  expect((await request(database, "PATCH")).status).toBe(405);
});

it("increments revisions for settings and token replacement but never duplicates registration or steals a token", async () => {
  const database = await databasePath();
  const input = registration();
  const first = await request(database, "PUT", input);
  input.settings.ng_ids = ["blocked-id"];
  const changed = await request(database, "PUT", input);
  expect(changed.body.subscription.revision).toBeGreaterThan(
    first.body.subscription.revision,
  );
  input.fcmToken = "fixture-device-token-rotated";
  const rotated = await request(database, "PUT", input);
  expect(rotated.body.subscription.revision).toBeGreaterThan(
    changed.body.subscription.revision,
  );
  expect(await request(database, "PUT", input)).toEqual(rotated);
  expect(
    await run(
      database,
      "echo json_encode($db->query('SELECT fcm_token FROM subscriptions')->fetchAll(PDO::FETCH_COLUMN));",
    ),
  ).toEqual([input.fcmToken]);
  expect((await request(database, "PUT", input, "owner-B")).status).toBe(409);
  expect(await request(database, "GET")).toEqual(rotated);
});

it("transactionally clears only the owner's pending work on changes and stop, preserves history until deletion, and survives restart", async () => {
  const database = await databasePath();
  const inputA = registration();
  const inputB = { ...registration(), fcmToken: "fixture-device-token-B" };
  const a = await request(database, "PUT", inputA);
  await request(database, "PUT", inputB, "owner-B");
  await run(
    database,
    `
    foreach (['owner-A', 'owner-B'] as $uid) {
      $db->prepare('INSERT INTO subscription_cursors (uid, board_url, thread_id, last_post) VALUES (?, ?, ?, ?)')->execute([$uid, 'https://egg.5ch.io/mj/', '1234567890', 80]);
      $db->prepare('INSERT INTO notification_events (event_id, uid, expires_at) VALUES (?, ?, ?)')->execute(['event-' . $uid, $uid, time() + 600]);
      $db->prepare('INSERT INTO notification_outbox (event_id, uid, revision, expires_at, payload_json) VALUES (?, ?, ?, ?, ?)')->execute(['event-' . $uid, $uid, 1, time() + 600, '{}']);
    }
    echo 'null';
  `,
  );
  inputA.settings.ng_words = ["new-filter"];
  const changed = await request(database, "PUT", inputA);
  expect(changed.body.subscription.revision).toBeGreaterThan(
    a.body.subscription.revision,
  );
  expect(
    await run(
      database,
      "echo json_encode($db->query('SELECT uid FROM notification_outbox')->fetchAll(PDO::FETCH_COLUMN));",
    ),
  ).toEqual(["owner-B"]);
  await run(
    database,
    `
    $db->prepare('INSERT INTO notification_outbox (event_id, uid, revision, expires_at, payload_json) VALUES (?, ?, ?, ?, ?)')->execute(['event-owner-A', 'owner-A', 1, time() + 600, '{}']);
    $db->exec("UPDATE subscription_cursors SET needs_baseline = 0 WHERE uid = 'owner-A'");
    echo 'null';
  `,
  );
  const stopped = await request(
    database,
    "POST",
    null,
    "owner-A",
    "/v1/subscription/stop",
  );
  expect(stopped.body.subscription.active).toBe(false);
  expect(stopped.body.subscription.revision).toBeGreaterThan(
    changed.body.subscription.revision,
  );
  expect(
    await request(database, "POST", null, "owner-A", "/v1/subscription/stop"),
  ).toEqual(stopped);
  expect(
    await run(
      database,
      "echo json_encode($db->query('SELECT uid FROM notification_outbox')->fetchAll(PDO::FETCH_COLUMN));",
    ),
  ).toEqual(["owner-B"]);
  expect(await request(database, "GET")).toEqual(stopped);
  expect(
    (await request(database, "GET", null, "owner-B")).body.subscription.active,
  ).toBe(true);
  const restarted = await request(database, "PUT", inputA);
  expect(restarted.body.subscription.active).toBe(true);
  expect(restarted.body.subscription.revision).toBeGreaterThan(
    stopped.body.subscription.revision,
  );
  expect(
    await run(
      database,
      "echo json_encode($db->query(\"SELECT needs_baseline FROM subscription_cursors WHERE uid='owner-A'\")->fetchColumn());",
    ),
  ).toBe(1);
  expect(await request(database, "DELETE")).toEqual({
    status: 200,
    body: { subscription: null },
  });
  expect(await request(database, "DELETE")).toEqual({
    status: 200,
    body: { subscription: null },
  });
  expect(await request(database, "GET")).toEqual({
    status: 200,
    body: { subscription: null },
  });
  for (const table of [
    "subscriptions",
    "subscription_cursors",
    "notification_events",
    "notification_outbox",
  ]) {
    expect(
      await run(
        database,
        `echo json_encode($db->query('SELECT uid FROM ${table}')->fetchAll(PDO::FETCH_COLUMN));`,
      ),
    ).toEqual(["owner-B"]);
  }
});

it("persists per-owner rate limits across PHP processes and leaves stop/delete available after PUT exhaustion", async () => {
  const database = await databasePath();
  const input = registration();
  for (let index = 0; index < 10; index++)
    expect((await request(database, "PUT", input)).status).toBe(200);
  expect(await request(database, "PUT", input)).toEqual({
    status: 429,
    body: { error: "rate_limited" },
  });
  expect(
    (await request(database, "POST", null, "owner-A", "/v1/subscription/stop"))
      .status,
  ).toBe(200);
  expect((await request(database, "DELETE")).status).toBe(200);
  expect((await request(database, "PUT", input)).status).toBe(429);
  expect(
    (
      await request(
        database,
        "PUT",
        { ...input, fcmToken: "other-token" },
        "owner-B",
      )
    ).status,
  ).toBe(200);
  expect(
    await run(
      database,
      `
    $result = [];
    for ($n = 0; $n < 3; $n++) $result[] = Sureneco\\rateLimitSubscriptionRequest($db, 'ip', '192.0.2.1', 2);
    echo json_encode($result);
  `,
    ),
  ).toEqual([true, true, false]);
  expect(
    await run(
      database,
      "echo json_encode(Sureneco\\rateLimitSubscriptionRequest($db, 'ip', '192.0.2.1', 2));",
    ),
  ).toBe(false);
  expect(
    await run(
      database,
      "echo json_encode($db->query(\"SELECT COUNT(*) FROM subscription_rate_limits WHERE identity_hash LIKE '%192.0.2.1%' OR identity_hash LIKE '%owner-A%'\")->fetchColumn());",
    ),
  ).toBe(0);
});

it("rolls back a settings/token revision if clearing obsolete pending work fails", async () => {
  const database = await databasePath();
  const input = registration();
  const original = await request(database, "PUT", input);
  await run(
    database,
    `
    $db->exec("INSERT INTO notification_events (event_id, uid, expires_at) VALUES ('pending', 'owner-A', " . (time() + 600) . ")");
    $db->exec("INSERT INTO notification_outbox (event_id, uid, revision, expires_at, payload_json) VALUES ('pending', 'owner-A', 1, " . (time() + 600) . ", '{}')");
    $db->exec("CREATE TRIGGER fail_clear BEFORE DELETE ON notification_outbox WHEN OLD.uid = 'owner-A' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    echo 'null';
  `,
  );
  input.fcmToken = "replacement-token";
  const failed = await run(
    database,
    `
    try {
      Sureneco\\subscriptionRequest($db, 'owner-A', 'PUT', '/v1/subscription', $input);
      echo 'false';
    } catch (PDOException) {
      echo 'true';
    }
  `,
    input,
  );
  expect(failed).toBe(true);
  expect(await request(database, "GET")).toEqual(original);
  expect(
    await run(
      database,
      "echo json_encode($db->query('SELECT fcm_token FROM subscriptions')->fetchColumn());",
    ),
  ).toBe("fixture-device-token-A");
  expect(
    await run(
      database,
      "echo json_encode($db->query('SELECT COUNT(*) FROM notification_outbox')->fetchColumn());",
    ),
  ).toBe(1);
});

it("expires delivery data and rate windows without stopping a valid inactive-in-app subscription", async () => {
  const database = await databasePath();
  const original = await request(database, "PUT", registration());
  await run(
    database,
    `
    $db->exec("INSERT INTO notification_events (event_id, uid, expires_at) VALUES ('expired', 'owner-A', " . (time() - 1) . ")");
    $db->exec("INSERT INTO notification_outbox (event_id, uid, revision, expires_at, payload_json) VALUES ('expired', 'owner-A', 1, " . (time() - 1) . ", '{}')");
    echo 'null';
  `,
  );
  expect(await request(database, "GET")).toEqual(original);
  for (const table of ["notification_events", "notification_outbox"]) {
    expect(
      await run(
        database,
        `echo json_encode($db->query('SELECT COUNT(*) FROM ${table}')->fetchColumn());`,
      ),
    ).toBe(0);
  }
  expect(
    await run(
      database,
      `
    Sureneco\\rateLimitSubscriptionRequest($db, 'ip', '192.0.2.2', 1);
    $db->exec("UPDATE subscription_rate_limits SET expires_at = " . (time() - 1));
    echo json_encode(Sureneco\\rateLimitSubscriptionRequest($db, 'ip', '192.0.2.2', 1));
  `,
    ),
  ).toBe(true);
});
