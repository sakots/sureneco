import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request, type ClientRequest, type IncomingMessage } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNtfyCredentials, NtfyAdmin } from "../server/ntfy-admin";

// Throwaway diagnostic. Only the private temporary directory and literal loopback
// listener are touched. Never serialize an exception, response body, or raw log.
const CAPACITY = 50;
const SETUP_MS = 120_000;
const ROUND_MS = 15_000;
const variants = ["same-ip", "distinct-ip", "direct-ip", "sequential-same-ip"] as const;
type Variant = (typeof variants)[number];
type Identity = {
  username: string;
  password: string;
  id: string;
  topic: string;
  authorization: string;
};
type Meta = { requestId: string; role: string; index: number; topicIndex: number; authenticated: boolean };
type Outcome = Meta & {
  status: number | null;
  errorCode: number | null;
  openEvents: number;
  failure: string | null;
  authorizationChallengePresent: boolean;
  elapsedMs: number;
};
type AclState = {
  index: number;
  accountExists: boolean;
  ordinaryRole: boolean;
  untiered: boolean;
  active: boolean;
  exactRows: number;
  readOnly: boolean;
  otherReaders: number;
  extraGrants: number;
};
type Snapshot = {
  ok: boolean;
  consistent: boolean;
  anonymousWriteOnly: boolean;
  userCount: number;
  grantCount: number;
  identities: AclState[];
  failure?: string;
};

function emit(value: unknown) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function failureKind(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "deadline";
    if (error.message === "ntfy_admin_failed") return "admin_failed";
    if (error.message === "setup_deadline") return "setup_deadline";
    if (error.message === "server_exited") return "server_exited";
    if (error.message === "preflight_failed") return "preflight_failed";
  }
  return "operation_failed";
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(new DOMException("", "AbortError"));
    return promise;
  }
  const abort = () => {
    clearTimeout(timer);
    reject(new DOMException("", "AbortError"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", abort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", abort, { once: true });
  return promise;
}
async function reservePort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("port_unavailable");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  listener.close((error) => error ? reject(error) : resolve());
  await promise;
  return address.port;
}
async function stop(child: ChildProcess): Promise<boolean> {
  if (!child.pid || (child.exitCode !== null || child.signalCode !== null) && child.stderr?.readableEnded) return true;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const finish = () => {
    clearTimeout(term);
    clearTimeout(kill);
    child.removeListener("close", finish);
    resolve(child.exitCode !== null || child.signalCode !== null);
  };
  const term = setTimeout(() => child.kill("SIGKILL"), 1000);
  const kill = setTimeout(finish, 2000);
  child.once("close", finish);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  return await promise;
}

async function scenario(binary: string, variant: Variant, round: number) {
  const started = Date.now();
  const directory = mkdtempSync(join(tmpdir(), "sureneco-ntfy-auth-diagnose-"));
  const configPath = join(directory, "server.yml");
  const authPath = join(directory, "auth.db");
  const cachePath = join(directory, "cache.db");
  const identities: Identity[] = Array.from({ length: CAPACITY }, () => {
    const id = randomUUID();
    const credentials = createNtfyCredentials(id);
    return {
      id,
      ...credentials,
      topic: "up" + randomBytes(16).toString("hex"),
      authorization: "Basic " + Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64"),
    };
  });
  const usernameIndex = new Map(identities.map((identity, index) => [identity.username, index]));
  const userIdIndex = new Map<string, number>();
  const requests = new Map<string, Meta>();
  const active = new Set<ClientRequest>();
  const heldResponses = new Set<IncomingMessage>();
  const outcomes: Outcome[] = [];
  const diagnostics: unknown[] = [];
  const serverEvents: Record<string, unknown>[] = [];
  const logCategories: Record<string, number> = {};
  let droppedLogEvents = 0;
  let unparsedLogLines = 0;
  let wrongUserEvents = 0;
  let unexpected403 = 0;
  let anomaly = false;
  let stage = "setup";
  let child: ChildProcess | undefined;
  let spawnFailed = false;
  let setupTimer: NodeJS.Timeout | undefined;
  let roundTimer: NodeJS.Timeout | undefined;
  const shutdown = new AbortController();
  const setup = new AbortController();
  const measurement = new AbortController();
  const agent = new Agent({ keepAlive: true, maxSockets: CAPACITY * 3 });
  let requestSequence = 0;
  let phaseStarted = started;
  let baseline: Snapshot | undefined;
  let postflight: Snapshot | undefined;
  let cleanupFailure = false;
  let scenarioFailure: string | null = null;
  const interrupted = () => shutdown.abort();
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);

  const runtimeConfig = {
    listenHost: "127.0.0.1",
    freshProcessAndDatabases: true,
    startupBeforeProvisioning: true,
    defaultAccess: "deny-all",
    anonymousUpPrefixAccess: "write-only",
    subscriptionLimit: 100,
    requestBurst: 10_000,
    requestReplenish: "1s",
    logLevel: "debug",
    logFormat: "json",
    behindProxy: variant !== "direct-ip",
    forwardedHeader: variant === "direct-ip" ? null : "X-Forwarded-For",
    forwardedIdentity: variant === "distinct-ip" ? "one-documentation-IP-per-index" : variant === "direct-ip" ? "none" : "one-shared-documentation-IP",
    streamLaunch: variant === "sequential-same-ip" ? "sequential-held-open" : "parallel",
    forwardedVariantsAreDiagnosticOnly: true,
    setupAllowanceMs: SETUP_MS,
    measurementDeadlineMs: ROUND_MS,
    streamDeadlineMs: 8000,
    requestCorrelation: "unique-request-id-and-diagnostic-query",
  };

  function snapshot(): Snapshot {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(authPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout=25; BEGIN");
      const users = db.prepare("SELECT id, user, role, tier_id, deleted FROM user").all() as { id: string; user: string; role: string; tier_id: string | null; deleted: number | null }[];
      const grants = db.prepare('SELECT user_id, topic, "read" AS can_read, "write" AS can_write FROM user_access').all() as { user_id: string; topic: string; can_read: number; can_write: number }[];
      db.exec("COMMIT");
      for (const user of users) {
        const index = usernameIndex.get(user.user);
        if (index !== undefined) userIdIndex.set(user.id, index);
      }
      const states = identities.map((identity, index): AclState => {
        const account = users.find((user) => user.user === identity.username);
        const exact = grants.filter((grant) => grant.user_id === account?.id && grant.topic === identity.topic);
        return {
          index,
          accountExists: !!account,
          ordinaryRole: account?.role === "user",
          untiered: !!account && account.tier_id === null,
          active: !!account && account.deleted === null,
          exactRows: exact.length,
          readOnly: exact.length === 1 && exact[0].can_read === 1 && exact[0].can_write === 0,
          otherReaders: grants.filter((grant) => grant.topic === identity.topic && grant.user_id !== account?.id && grant.can_read !== 0).length,
          extraGrants: grants.filter((grant) => grant.user_id === account?.id && grant.topic !== identity.topic).length,
        };
      });
      const anonymous = users.find((user) => user.user === "*");
      const anonymousRows = grants.filter((grant) => grant.user_id === anonymous?.id);
      // ntfy stores its wildcard SQL pattern as up%, not the CLI's up* spelling.
      const anonymousWriteOnly = anonymousRows.length === 1 &&
        ["up%", "up*"].includes(anonymousRows[0].topic) &&
        anonymousRows[0].can_read === 0 && anonymousRows[0].can_write === 1;
      return {
        ok: true,
        consistent: users.length === CAPACITY + 1 && grants.length === CAPACITY + 1 && anonymousWriteOnly && states.every((state) => state.accountExists && state.ordinaryRole && state.untiered && state.active && state.readOnly && state.exactRows === 1 && state.otherReaders === 0 && state.extraGrants === 0),
        anonymousWriteOnly,
        userCount: users.length,
        grantCount: grants.length,
        identities: states,
      };
    } catch {
      return { ok: false, consistent: false, anonymousWriteOnly: false, userCount: 0, grantCount: 0, identities: [], failure: "acl_inspection_failed" };
    } finally {
      db?.close();
    }
  }

  function projectLog(line: string) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; }
    catch { unparsedLogLines++; return; }
    const message = typeof entry.message === "string" ? entry.message : "";
    const category = message.includes("not authorized") ? "authorization_denied" :
      message.includes("Authentication failed") ? "authentication_failed" :
      message.includes("Connection closed with HTTP") ? "http_error" :
      message === "HTTP request started" ? "request_started" :
      message === "HTTP request finished" ? "request_finished" :
      message === "HTTP stream connection opened" ? "stream_opened" :
      message === "HTTP stream connection closed" ? "stream_closed" : "other";
    logCategories[category] = (logCategories[category] ?? 0) + 1;
    if (typeof entry.http_path !== "string") return;
    let meta: Meta | undefined;
    try {
      const id = new URL(entry.http_path, "http://127.0.0.1").searchParams.get("diagnostic_request");
      if (id) meta = requests.get(id);
    } catch { return; }
    if (!meta) return;
    const matchedIndex = typeof entry.user_name === "string" ? usernameIndex.get(entry.user_name) :
      typeof entry.user_id === "string" ? userIdIndex.get(entry.user_id) : undefined;
    const userFieldPresent = typeof entry.user_name === "string" || typeof entry.user_id === "string";
    const mismatch = matchedIndex !== undefined && (!meta.authenticated || matchedIndex !== meta.index);
    if (mismatch) wrongUserEvents++;
    const numericErrorCode = typeof entry.error_code === "number" ? entry.error_code : null;
    const statusMatch = /Connection closed with HTTP (\d{3}) \(ntfy error (\d+)\)/.exec(message);
    const projected = {
      requestId: meta.requestId,
      role: meta.role,
      index: meta.index,
      category,
      matchedUserIndex: matchedIndex ?? null,
      userFieldPresent,
      matchedUserState: matchedIndex !== undefined ? "known-index" : "unknown",
      wrongUser: mismatch,
      evidence: "suggestive-mutable-visitor-not-authorization-principal-snapshot",
      errorCode: numericErrorCode ?? (statusMatch ? Number(statusMatch[2]) : null),
      status: statusMatch ? Number(statusMatch[1]) : null,
      elapsedMs: Date.now() - phaseStarted,
    };
    if (serverEvents.length < 6000) serverEvents.push(projected);
    else droppedLogEvents++;
  }

  async function http(role: string, index: number, topicIndex: number, signal: AbortSignal, options: { stream?: boolean; anonymous?: boolean; write?: boolean; health?: boolean } = {}): Promise<Outcome> {
    const requestId = `${role}-${round}-${index}-${requestSequence++}`;
    const meta: Meta = { requestId, role, index, topicIndex, authenticated: !options.anonymous && !options.health };
    requests.set(requestId, meta);
    const sent = Date.now();
    const result: Outcome = { ...meta, status: null, errorCode: null, openEvents: 0, failure: null, authorizationChallengePresent: false, elapsedMs: 0 };
    const { promise, resolve } = Promise.withResolvers<Outcome>();
    let finished = false;
    let req: ClientRequest;
    const finish = (failure: string | null = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      result.failure = failure;
      result.elapsedMs = Date.now() - sent;
      if (!options.health) outcomes.push(result);
      resolve(result);
    };
    const headers: Record<string, string> = { "X-Request-ID": requestId };
    if (meta.authenticated) headers.Authorization = identities[index].authorization;
    if (variant !== "direct-ip") headers["X-Forwarded-For"] = variant === "distinct-ip" ? `192.0.2.${index + 1}` : "192.0.2.1";
    const suffix = options.health ? "/v1/health" : `/${identities[topicIndex].topic}${options.write ? "" : "/json"}`;
    const query = new URLSearchParams({ diagnostic_request: requestId });
    if (!options.stream && !options.write && !options.health) query.set("poll", "1");
    const timer = setTimeout(() => { finish("request_deadline"); req?.destroy(); }, options.stream ? 8000 : 2000);
    req = request({ hostname: "127.0.0.1", port, path: suffix + "?" + query, method: options.write ? "POST" : "GET", agent, headers, signal: AbortSignal.any([signal, shutdown.signal]) }, (response) => {
      result.status = response.statusCode ?? null;
      result.authorizationChallengePresent = response.headers["www-authenticate"] !== undefined;
      let buffer = "";
      let totalBytes = 0;
      const decoder = new TextDecoder();
      if (options.stream && result.status === 200) heldResponses.add(response);
      response.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > 65_536) { finish("response_too_large"); response.destroy(); return; }
        buffer += decoder.decode(chunk, { stream: true });
        if (!options.stream || result.status !== 200) return;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as { event?: string };
            if (event.event === "open") { result.openEvents++; finish(); }
          } catch { finish("invalid_stream_json"); response.destroy(); }
        }
      });
      response.on("end", () => {
        heldResponses.delete(response);
        if (options.stream && result.status === 200) { finish("stream_ended_before_open"); return; }
        if (result.status !== null && result.status >= 400) {
          try {
            const body = JSON.parse(buffer) as { code?: unknown };
            if (typeof body.code === "number" && Number.isSafeInteger(body.code)) result.errorCode = body.code;
          } catch { /* Non-JSON error bodies are intentionally not emitted. */ }
        }
        finish();
      });
      response.on("error", () => finish("response_io_error"));
      response.on("aborted", () => finish("response_aborted"));
    });
    active.add(req);
    req.on("close", () => active.delete(req));
    req.on("error", () => finish(signal.aborted || shutdown.signal.aborted ? "deadline" : "request_io_error"));
    req.end(options.write ? "isolated-authorization-negative-check" : undefined);
    return await promise;
  }

  async function diagnose(index: number, origin: Outcome, signal: AbortSignal) {
    const failureAt = Date.now();
    // Neither probe replaces or mutates the failed original request.
    const immediate = http("failure-ownpoll-immediate", index, index, signal);
    const aclAtFailure = snapshot();
    const delayed = (async () => {
      await delay(Math.max(0, failureAt + 1000 - Date.now()), AbortSignal.any([signal, shutdown.signal]));
      return http("failure-ownpoll-delayed", index, index, signal);
    })();
    const probes = await Promise.allSettled([immediate, delayed]);
    for (const probe of probes) {
      if (probe.status === "fulfilled" && probe.value.status === 403) unexpected403++;
    }
    diagnostics.push({
      index,
      originalRequestId: origin.requestId,
      originalStatus: origin.status,
      originalErrorCode: origin.errorCode,
      sameCredentialObject: true,
      delayedTargetMs: 1000,
      immediate: probes[0].status === "fulfilled" ? probes[0].value : { failure: "diagnostic_deadline" },
      delayed: probes[1].status === "fulfilled" ? probes[1].value : { failure: "diagnostic_deadline" },
      aclAtFailure,
      aclMatchesBaseline: !!baseline && JSON.stringify(aclAtFailure) === JSON.stringify(baseline),
    });
  }

  let port = 0;
  try {
    setupTimer = setTimeout(() => setup.abort(), SETUP_MS);
    port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    writeFileSync(configPath, [
      `base-url: ${base}`,
      `listen-http: 127.0.0.1:${port}`,
      `auth-file: ${authPath}`,
      `cache-file: ${cachePath}`,
      "auth-default-access: deny-all",
      "auth-access:",
      '  - "*:up*:write-only"',
      "visitor-subscription-limit: 100",
      "visitor-request-limit-burst: 10000",
      "visitor-request-limit-replenish: 1s",
      `behind-proxy: ${runtimeConfig.behindProxy}`,
      'proxy-forwarded-header: "X-Forwarded-For"',
      "log-level: debug",
      "log-format: json",
      "",
    ].join("\n"), { mode: 0o600 });
    child = spawn(binary, ["serve", "--config", configPath], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    child.on("error", () => { spawnFailed = true; });
    for (const output of [child.stdout!, child.stderr!]) {
      let pending = "";
      output.setEncoding("utf8");
      output.on("data", (chunk: string) => {
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.length <= 65_536) projectLog(line);
          else unparsedLogLines++;
        }
        if (pending.length > 65_536) { pending = ""; unparsedLogLines++; }
      });
      output.on("end", () => { if (pending.trim()) projectLog(pending); });
    }
    const startupDeadline = Date.now() + 5000;
    while (true) {
      if (spawnFailed || child.exitCode !== null || child.signalCode !== null) throw new Error("server_exited");
      if (Date.now() > startupDeadline || setup.signal.aborted) throw new Error("setup_deadline");
      const response = await http("health", 0, 0, setup.signal, { health: true });
      if (response.status === 200) break;
      await delay(50, AbortSignal.any([setup.signal, shutdown.signal]));
    }
    const admin = new NtfyAdmin({ binary, config: configPath });
    for (const identity of identities) {
      if (setup.signal.aborted || shutdown.signal.aborted) throw new Error("setup_deadline");
      await admin.ensureAccount(identity.id, identity.password);
      if (setup.signal.aborted || shutdown.signal.aborted) throw new Error("setup_deadline");
      await admin.grantRead(identity.id, identity.topic);
    }
    baseline = snapshot();
    if (!baseline.consistent) { anomaly = true; scenarioFailure = "baseline_acl_inconsistent"; }
    stage = "preflight";
    let preflightFailed = false;
    // Deliberately sequential: establish ACL correctness without mixing users in flight.
    for (let index = 0; index < CAPACITY; index++) {
      for (const check of [
        { role: "ownpoll", topic: index, expected: 200, options: {} },
        { role: "foreignpoll", topic: (index + 1) % CAPACITY, expected: 403, options: {} },
        { role: "anonymouspoll", topic: index, expected: 403, options: { anonymous: true } },
        { role: "devicewrite", topic: index, expected: 403, options: { write: true } },
      ]) {
        const observed = await http(check.role, index, check.topic, setup.signal, check.options);
        if (observed.status !== check.expected || observed.failure !== null) {
          anomaly = true;
          preflightFailed = true;
          if (observed.status === 403 && check.expected !== 403) unexpected403++;
          await diagnose(index, observed, setup.signal);
        }
        if (setup.signal.aborted || shutdown.signal.aborted) throw new Error("setup_deadline");
      }
    }
    if (preflightFailed) throw new Error("preflight_failed");
    // Discard intentional-negative logs before the concurrent measurement. The
    // request map is cleared too, so late preflight stderr cannot be misattributed.
    serverEvents.length = 0;
    for (const category of Object.keys(logCategories)) delete logCategories[category];
    requests.clear();
    droppedLogEvents = 0;
    unparsedLogLines = 0;
    wrongUserEvents = 0;
    clearTimeout(setupTimer);
    stage = "streams";
    phaseStarted = Date.now();
    roundTimer = setTimeout(() => measurement.abort(), ROUND_MS);
    const openOne = async (index: number) => {
      const result = await http("capacity", index, index, measurement.signal, { stream: true });
      if (result.status !== 200 || result.openEvents !== 1 || result.failure !== null) {
        anomaly = true;
        if (result.status === 403) unexpected403++;
        await diagnose(index, result, measurement.signal);
      }
    };
    if (variant === "sequential-same-ip") {
      for (let index = 0; index < CAPACITY; index++) await openOne(index);
    } else {
      await Promise.all(identities.map((_, index) => openOne(index)));
    }
    postflight = snapshot();
    if (!postflight.consistent) anomaly = true;
    stage = "complete";
  } catch (error) {
    anomaly = true;
    scenarioFailure = failureKind(error);
  } finally {
    clearTimeout(setupTimer);
    clearTimeout(roundTimer);
    shutdown.abort();
    for (const response of heldResponses) response.destroy();
    for (const req of active) req.destroy();
    agent.destroy();
    if (child && !await stop(child)) { cleanupFailure = true; anomaly = true; }
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { cleanupFailure = true; anomaly = true; }
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
  const streams = outcomes.filter((outcome) => outcome.role === "capacity");
  const statuses: Record<string, number> = {};
  for (const stream of streams) {
    const key = `${stream.status ?? "no-response"}/${stream.errorCode ?? "no-error-code"}`;
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  emit({
    type: "round",
    variant,
    round,
    config: runtimeConfig,
    durationMs: Date.now() - started,
    stage,
    anomaly,
    unexpected403,
    failure: scenarioFailure,
    cleanupComplete: !cleanupFailure,
    preflightChecks: outcomes.filter((outcome) => ["ownpoll", "foreignpoll", "anonymouspoll", "devicewrite"].includes(outcome.role)).length,
    streamRequests: streams.length,
    streamOpenEvents: streams.reduce((total, stream) => total + stream.openEvents, 0),
    streamStatusAndErrorCodes: statuses,
    baseline,
    postflight,
    outcomes,
    diagnostics,
    serverLogs: { categories: logCategories, unparsedLines: unparsedLogLines, droppedEvents: droppedLogEvents, wrongUserEvents, events: serverEvents },
  });
  return { anomaly, unexpected403, wrongUserEvents, variant, round, openEvents: streams.reduce((total, stream) => total + stream.openEvents, 0) };
}

async function main() {
  const args = process.argv.slice(2);
  let binary = process.env.SURENECO_TEST_NTFY_BIN ?? "";
  let variant: Variant | "all" = "all";
  let rounds = 5;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (!value) throw new Error("invalid_arguments");
    if (args[index] === "--binary") binary = value;
    else if (args[index] === "--variant" && (value === "all" || variants.includes(value as Variant))) variant = value as Variant | "all";
    else if (args[index] === "--rounds" && /^\d+$/.test(value)) rounds = Number(value);
    else throw new Error("invalid_arguments");
  }
  if (!binary || !isAbsolute(binary) || /[\r\n\x00]/.test(binary) || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 20) throw new Error("invalid_arguments");
  // 'all' is the matched proxy-enabled pair; other variants are explicit controls.
  const selected: Variant[] = variant === "all" ? ["same-ip", "distinct-ip"] : [variant];
  emit({ type: "start", capacity: CAPACITY, variants: selected, roundsPerVariant: rounds, output: "jsonl-indexes-only", originalFailureRetried: false });
  const summaries = [];
  for (let round = 1; round <= rounds; round++) {
    for (const selectedVariant of selected) summaries.push(await scenario(binary, selectedVariant, round));
  }
  const anomaly = summaries.some((summary) => summary.anomaly);
  emit({ type: "summary", anomaly, unexpected403: summaries.reduce((total, summary) => total + summary.unexpected403, 0), rounds: summaries });
  process.exitCode = anomaly ? 1 : 0;
}

main().catch(() => {
  emit({ type: "fatal", failure: "invalid_arguments_or_unexpected_setup_failure", usage: "--binary ABSOLUTE_ISOLATED_NTFY_BINARY --variant all|same-ip|distinct-ip|direct-ip|sequential-same-ip --rounds 1..20" });
  process.exitCode = 2;
});
