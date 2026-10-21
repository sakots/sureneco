import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaults } from "../src/core/settings";
import { scanPosts } from "../src/core/detection";
import { candidates, parseDat, parseSubject } from "../src/core/parser";
import type { Post, Settings } from "../src/core/types";
const executeFile = promisify(execFile);

function execute(args: string[], input: unknown, binary?: string) {
  const running = executeFile("php", args, {
    env: binary ? { ...process.env, SURENECO_WORKER_BIN: binary } : process.env,
    timeout: 5000,
    maxBuffer: 5 * 1024 * 1024,
  });
  running.child.stdin!.end(JSON.stringify(input));
  return running;
}
const now = Date.parse("2026-10-21T12:00:00+09:00");
const threadId = "1792548000";
const post = (
  number: number,
  body: string,
  changes: Partial<Post> = {},
): Post => ({
  number,
  body,
  name: "名無し",
  id: "author",
  watchoi: "ﾜｯﾁｮｲ abcd-1234",
  postedAt: now - 1000,
  ...changes,
});
const scan = (posts: Post[], settings: Settings = defaults) => ({
  operation: "scan",
  threadId,
  posts,
  previous: [],
  settings,
  now,
});

async function php(request: unknown, binary?: string) {
  const { stdout, stderr } = await execute(
    [
      "-r",
      `require 'server/detection.php';
      try {
        $request = json_decode(stream_get_contents(STDIN), true, 64, JSON_THROW_ON_ERROR);
        echo json_encode(['ok' => true, 'result' => Sureneco\\runDetectionWorker($request)], JSON_THROW_ON_ERROR);
      } catch (Sureneco\\DetectionWorkerException $error) {
        echo json_encode(['ok' => false, 'error' => $error->errorCode], JSON_THROW_ON_ERROR);
      }`,
    ],
    request,
    binary,
  );
  expect(stderr).toBe("");
  return JSON.parse(stdout);
}

it("preserves ECMAScript UTF-16, whitespace, lookbehind and unmatched-backreference semantics", async () => {
  for (const [pattern, body] of [
    ["^.{8}$", "😀 12345"],
    ["^\\s12345$", "\ufeff12345"],
    ["^(a|(b))\\2c 12345$", "ac 12345"],
    ["(?<![0-9])四東", "四東 ０１２３４"],
  ]) {
    const settings = { ...defaults, yujinsen_regex: pattern };
    const posts = [post(1, body)];
    const expected = scanPosts(threadId, posts, [], settings, now);
    expect(expected.notifications[0].roomIds).toEqual([
      body.includes("０") ? "01234" : "12345",
    ]);
    expect(await php(scan(posts, settings))).toEqual({
      ok: true,
      result: expected,
    });
  }
});

it("applies reference resolution, NG, allow-list, closing and expiry exactly as the core", async () => {
  const posts = [
    post(1, "友人戦 ０１２３４"),
    post(2, ">>1 続けて募集"),
    post(3, "友人戦 23456", { id: "blocked" }),
    post(4, "友人戦 34567", { watchoi: "not-allowed" }),
    post(5, "友人戦 45678", { postedAt: now - 601000 }),
    post(6, ">>1 〆", { id: "other" }),
    post(7, "四南 56789"),
  ];
  const settings = {
    ...defaults,
    ng_ids: ["blocked"],
    allowed_watchois: ["ﾜｯﾁｮｲ abcd-1234"],
  };
  const expected = scanPosts(threadId, posts, [], settings, now);
  expect(expected.notifications.map((item) => item.number)).toEqual([7]);
  expect(expected.items.find((item) => item.number === 1)?.closed).toBe(true);
  expect(await php(scan(posts, settings))).toEqual({
    ok: true,
    result: expected,
  });
});

it("rejects JavaScript syntax errors and PCRE-only syntax without executing caller code", async () => {
  for (const pattern of ["[", "(?>a)"]) {
    expect(await php({ operation: "validate", patterns: [pattern] })).toEqual({
      ok: false,
      error: "invalid_pattern",
    });
  }
  expect(await php({ operation: "eval", code: "while(true){}" })).toEqual({
    ok: false,
    error: "invalid_request",
  });
});

it("parses fetched dat with the exact core post semantics", async () => {
  for (const dat of [
    "",
    " \r\n",
    "名無し (ﾜｯﾁｮｲ abcd-1234)<>sage<>2026/10/21(水) 12:00:00.12 ID:author<>友人戦 &amp; １２３４５<br>次の行<>題名\r\n" +
      "&#x1f600;<>mail<>不明<> &lt;b&gt;本文&lt;/b&gt; <>",
  ]) {
    expect(await php({ operation: "dat", dat })).toEqual({
      ok: true,
      result: parseDat(dat),
    });
  }
});

it("filters subject candidates exactly as the core while retaining watched threads", async () => {
  const recent = String(Math.floor(now / 1000) - 60);
  const excluded = String(Number(recent) - 1);
  const old = String(Number(recent) - 30 * 86400);
  const future = String(Number(recent) + 120);
  const unrelated = String(Number(recent) - 2);
  const subject = [
    `${recent}.dat<>雀魂 &amp; 募集 (25)`,
    `${excluded}.dat<>雀魂 除外 (30)`,
    `${old}.dat<>別の話題 (100)`,
    `${future}.dat<>雀魂 未来 (1)`,
    `${unrelated}.dat<>別の話題 (2)`,
    "ignored line",
  ].join("\r\n");
  const settings = { ...defaults, ng_thread_title_regex: "除外" };
  const threads = parseSubject(subject);
  const eligible = candidates(threads, settings, now);
  expect(eligible.map((thread) => thread.id)).toEqual([recent]);
  for (const watched of [[], [old, excluded, future, old, "1000000000"]]) {
    expect(
      await php({ operation: "subject", subject, settings, watched, now }),
    ).toEqual({
      ok: true,
      result: threads.filter(
        (thread) => watched.includes(thread.id) || eligible.includes(thread),
      ),
    });
  }
  expect(
    await php({
      operation: "subject",
      subject: "",
      settings,
      watched: [],
      now,
    }),
  ).toEqual({ ok: true, result: [] });
});

it("rejects malformed parser operations and invalid title patterns", async () => {
  const subject = {
    operation: "subject",
    subject: `${threadId}.dat<>雀魂 (1)`,
    settings: defaults,
    watched: [],
    now,
  };
  for (const request of [
    { operation: "dat" },
    { operation: "dat", dat: 12 },
    { operation: "dat", dat: "malformed" },
    { ...subject, subject: null },
    { ...subject, subject: "malformed" },
    { ...subject, watched: null },
    { ...subject, watched: [123] },
    { ...subject, watched: ["not-an-id"] },
    { ...subject, now: "123" },
    { ...subject, now: 1.5 },
    { ...subject, settings: null },
    { ...subject, settings: { ...defaults, elapsed_days: "14" } },
    { ...subject, settings: { ...defaults, elapsed_days: 0 } },
    { ...subject, settings: { ...defaults, thread_title_regex: 1 } },
    { ...subject, settings: { ...defaults, ng_thread_title_regex: null } },
    {
      ...subject,
      settings: { ...defaults, thread_title_regex: "a".repeat(1001) },
    },
  ]) {
    expect(await php(request)).toEqual({ ok: false, error: "invalid_request" });
  }
  for (const key of ["thread_title_regex", "ng_thread_title_regex"]) {
    expect(
      await php({ ...subject, settings: { ...defaults, [key]: "[" } }),
    ).toEqual({ ok: false, error: "invalid_pattern" });
  }
});

it("bounds pathological title regex execution and recovers for the next request", async () => {
  const subject = `${threadId}.dat<>${"a".repeat(100)}! (1)`;
  expect(
    await php({
      operation: "subject",
      subject,
      settings: { ...defaults, thread_title_regex: "^(a+)+$" },
      watched: [threadId],
      now,
    }),
  ).toEqual({ ok: false, error: "execution_limit" });
  const dat = "名無し<><>不明<>友人戦 12345<>";
  expect(await php({ operation: "dat", dat })).toEqual({
    ok: true,
    result: parseDat(dat),
  });
  const settings = { ...defaults, thread_title_regex: "." };
  expect(
    await php({ operation: "subject", subject, settings, watched: [], now }),
  ).toEqual({
    ok: true,
    result: candidates(parseSubject(subject), settings, now),
  });
});

it("terminates pathological regex execution without poisoning subsequent subscriptions", async () => {
  const slow = scan([post(1, "a".repeat(100) + "!")], {
    ...defaults,
    yujinsen_regex: "^(a+)+$",
  });
  expect(await php(slow)).toEqual({ ok: false, error: "execution_limit" });
  const posts = [post(1, "友人戦 12345")];
  expect(await php(scan(posts))).toEqual({
    ok: true,
    result: scanPosts(threadId, posts, [], defaults, now),
  });
});

it("fails closed when the trusted worker executable is unavailable", async () => {
  expect(
    await php(scan([post(1, "友人戦 12345")]), "/nonexistent/sureneco-worker"),
  ).toEqual({ ok: false, error: "execution_failed" });
});

it("rejects invalid regex before persistence and fails closed when syntax validation is unavailable", async () => {
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
  const script = `require 'server/subscriptions.php';
    $db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    Sureneco\\initializeSubscriptionSchema($db);
    $input = json_decode(stream_get_contents(STDIN), false, 64, JSON_THROW_ON_ERROR);
    $response = Sureneco\\subscriptionRequest($db, 'test-owner', 'PUT', '/v1/subscription', $input);
    echo json_encode(['response' => $response, 'count' => (int)$db->query('SELECT COUNT(*) FROM subscriptions')->fetchColumn()], JSON_THROW_ON_ERROR);`;
  const input = {
    settings: { ...settings, update_sec: 60, yujinsen_regex: "[" },
    watched: [threadId],
    fcmToken: "test-token",
    consent: true,
  };
  const invalid = await execute(["-r", script], input);
  expect(JSON.parse(invalid.stdout)).toEqual({
    response: { status: 400, body: { error: "invalid_subscription" } },
    count: 0,
  });
  input.settings.yujinsen_regex = defaults.yujinsen_regex;
  const unavailable = await execute(
    ["-r", script],
    input,
    "/nonexistent/sureneco-worker",
  );
  expect(JSON.parse(unavailable.stdout)).toEqual({
    response: { status: 503, body: { error: "detection_unavailable" } },
    count: 0,
  });
});
