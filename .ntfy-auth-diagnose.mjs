// scripts/.ntfy-auth-diagnose.ts
import { spawn } from "node:child_process";
import { randomBytes as randomBytes2, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute as isAbsolute2, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// server/ntfy-admin.ts
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
function invalid() {
  throw new Error("invalid_ntfy_input");
}
function username(deviceId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    deviceId
  ))
    invalid();
  return "sur_" + deviceId.replaceAll("-", "");
}
function topicName(topic) {
  if (!/^up[A-Za-z0-9_-]{1,62}$/.test(topic)) invalid();
  return topic;
}
function createNtfyCredentials(deviceId) {
  return {
    username: username(deviceId),
    password: randomBytes(32).toString("base64url")
  };
}
var execute = ({ binary, args, env, timeoutMs }) => new Promise((resolve, reject) => {
  const child = execFile(
    binary,
    args,
    {
      env,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024
    },
    (error, _stdout, stderr) => {
      if (!error) resolve();
      else reject({ code: error.code, signal: error.signal, stderr });
    }
  );
  child.stdin?.end();
});
var NtfyAdmin = class {
  constructor(options, run = execute) {
    this.options = options;
    this.run = run;
    for (const path of [options.binary, options.config])
      if (!isAbsolute(path) || path.length > 4096 || /[\x00\r\n]/.test(path))
        invalid();
    this.timeoutMs = options.timeoutMs ?? 5e3;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 5e3)
      invalid();
  }
  options;
  run;
  timeoutMs;
  async ensureAccount(deviceId, password) {
    const user = username(deviceId);
    if (!/^[A-Za-z0-9_-]{43}$/.test(password) || Buffer.from(password, "base64url").toString("base64url") !== password)
      invalid();
    await this.invoke(
      "user",
      ["add", "--role=user", "--ignore-exists", user],
      password
    );
  }
  async grantRead(deviceId, topic) {
    await this.invoke("access", [
      username(deviceId),
      topicName(topic),
      "read-only"
    ]);
  }
  async revokeRead(deviceId, topic) {
    await this.invoke("access", [
      "--reset",
      username(deviceId),
      topicName(topic)
    ]);
  }
  async removeAccount(deviceId) {
    const user = username(deviceId);
    await this.invoke("user", ["remove", user], void 0, user);
  }
  async invoke(command, args, password, deleting) {
    try {
      await this.run({
        binary: this.options.binary,
        args: [command, "--config", this.options.config, ...args],
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
          ...password ? { NTFY_PASSWORD: password } : {}
        },
        timeoutMs: this.timeoutMs
      });
    } catch (error) {
      if (deleting && error && typeof error === "object" && "code" in error && error.code === 1 && !("signal" in error && error.signal) && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim() === `user ${deleting} does not exist`)
        return;
      throw new Error("ntfy_admin_failed");
    }
  }
};

// scripts/.ntfy-auth-diagnose.ts
var CAPACITY = 50;
var SETUP_MS = 12e4;
var ROUND_MS = 15e3;
var variants = ["same-ip", "distinct-ip", "direct-ip", "sequential-same-ip"];
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function failureKind(error) {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "deadline";
    if (error.message === "ntfy_admin_failed") return "admin_failed";
    if (error.message === "setup_deadline") return "setup_deadline";
    if (error.message === "server_exited") return "server_exited";
    if (error.message === "preflight_failed") return "preflight_failed";
  }
  return "operation_failed";
}
function delay(ms, signal) {
  const { promise, resolve, reject } = Promise.withResolvers();
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
async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("port_unavailable");
  const { promise, resolve, reject } = Promise.withResolvers();
  listener.close((error) => error ? reject(error) : resolve());
  await promise;
  return address.port;
}
async function stop(child) {
  if (!child.pid || (child.exitCode !== null || child.signalCode !== null) && child.stderr?.readableEnded) return true;
  const { promise, resolve } = Promise.withResolvers();
  const finish = () => {
    clearTimeout(term);
    clearTimeout(kill);
    child.removeListener("close", finish);
    resolve(child.exitCode !== null || child.signalCode !== null);
  };
  const term = setTimeout(() => child.kill("SIGKILL"), 1e3);
  const kill = setTimeout(finish, 2e3);
  child.once("close", finish);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  return await promise;
}
async function scenario(binary, variant, round) {
  const started = Date.now();
  const directory = mkdtempSync(join(tmpdir(), "sureneco-ntfy-auth-diagnose-"));
  const configPath = join(directory, "server.yml");
  const authPath = join(directory, "auth.db");
  const cachePath = join(directory, "cache.db");
  const identities = Array.from({ length: CAPACITY }, () => {
    const id = randomUUID();
    const credentials = createNtfyCredentials(id);
    return {
      id,
      ...credentials,
      topic: "up" + randomBytes2(16).toString("hex"),
      authorization: "Basic " + Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")
    };
  });
  const usernameIndex = new Map(identities.map((identity, index) => [identity.username, index]));
  const userIdIndex = /* @__PURE__ */ new Map();
  const requests = /* @__PURE__ */ new Map();
  const active = /* @__PURE__ */ new Set();
  const heldResponses = /* @__PURE__ */ new Set();
  const outcomes = [];
  const diagnostics = [];
  const serverEvents = [];
  const logCategories = {};
  let droppedLogEvents = 0;
  let unparsedLogLines = 0;
  let wrongUserEvents = 0;
  let unexpected403 = 0;
  let anomaly = false;
  let stage = "setup";
  let child;
  let spawnFailed = false;
  let setupTimer;
  let roundTimer;
  const shutdown = new AbortController();
  const setup = new AbortController();
  const measurement = new AbortController();
  const agent = new Agent({ keepAlive: true, maxSockets: CAPACITY * 3 });
  let requestSequence = 0;
  let phaseStarted = started;
  let baseline;
  let postflight;
  let cleanupFailure = false;
  let scenarioFailure = null;
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
    requestBurst: 1e4,
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
    streamDeadlineMs: 8e3,
    requestCorrelation: "unique-request-id-and-diagnostic-query"
  };
  function snapshot() {
    let db;
    try {
      db = new DatabaseSync(authPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout=25; BEGIN");
      const users = db.prepare("SELECT id, user, role, tier_id, deleted FROM user").all();
      const grants = db.prepare('SELECT user_id, topic, "read" AS can_read, "write" AS can_write FROM user_access').all();
      db.exec("COMMIT");
      for (const user of users) {
        const index = usernameIndex.get(user.user);
        if (index !== void 0) userIdIndex.set(user.id, index);
      }
      const states = identities.map((identity, index) => {
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
          extraGrants: grants.filter((grant) => grant.user_id === account?.id && grant.topic !== identity.topic).length
        };
      });
      const anonymous = users.find((user) => user.user === "*");
      const anonymousRows = grants.filter((grant) => grant.user_id === anonymous?.id);
      const anonymousWriteOnly = anonymousRows.length === 1 && ["up%", "up*"].includes(anonymousRows[0].topic) && anonymousRows[0].can_read === 0 && anonymousRows[0].can_write === 1;
      return {
        ok: true,
        consistent: users.length === CAPACITY + 1 && grants.length === CAPACITY + 1 && anonymousWriteOnly && states.every((state) => state.accountExists && state.ordinaryRole && state.untiered && state.active && state.readOnly && state.exactRows === 1 && state.otherReaders === 0 && state.extraGrants === 0),
        anonymousWriteOnly,
        userCount: users.length,
        grantCount: grants.length,
        identities: states
      };
    } catch {
      return { ok: false, consistent: false, anonymousWriteOnly: false, userCount: 0, grantCount: 0, identities: [], failure: "acl_inspection_failed" };
    } finally {
      db?.close();
    }
  }
  function projectLog(line) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      unparsedLogLines++;
      return;
    }
    const message = typeof entry.message === "string" ? entry.message : "";
    const category = message.includes("not authorized") ? "authorization_denied" : message.includes("Authentication failed") ? "authentication_failed" : message.includes("Connection closed with HTTP") ? "http_error" : message === "HTTP request started" ? "request_started" : message === "HTTP request finished" ? "request_finished" : message === "HTTP stream connection opened" ? "stream_opened" : message === "HTTP stream connection closed" ? "stream_closed" : "other";
    logCategories[category] = (logCategories[category] ?? 0) + 1;
    if (typeof entry.http_path !== "string") return;
    let meta;
    try {
      const id = new URL(entry.http_path, "http://127.0.0.1").searchParams.get("diagnostic_request");
      if (id) meta = requests.get(id);
    } catch {
      return;
    }
    if (!meta) return;
    const matchedIndex = typeof entry.user_name === "string" ? usernameIndex.get(entry.user_name) : typeof entry.user_id === "string" ? userIdIndex.get(entry.user_id) : void 0;
    const userFieldPresent = typeof entry.user_name === "string" || typeof entry.user_id === "string";
    const mismatch = matchedIndex !== void 0 && (!meta.authenticated || matchedIndex !== meta.index);
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
      matchedUserState: matchedIndex !== void 0 ? "known-index" : "unknown",
      wrongUser: mismatch,
      evidence: "suggestive-mutable-visitor-not-authorization-principal-snapshot",
      errorCode: numericErrorCode ?? (statusMatch ? Number(statusMatch[2]) : null),
      status: statusMatch ? Number(statusMatch[1]) : null,
      elapsedMs: Date.now() - phaseStarted
    };
    if (serverEvents.length < 6e3) serverEvents.push(projected);
    else droppedLogEvents++;
  }
  async function http(role, index, topicIndex, signal, options = {}) {
    const requestId = `${role}-${round}-${index}-${requestSequence++}`;
    const meta = { requestId, role, index, topicIndex, authenticated: !options.anonymous && !options.health };
    requests.set(requestId, meta);
    const sent = Date.now();
    const result = { ...meta, status: null, errorCode: null, openEvents: 0, failure: null, authorizationChallengePresent: false, elapsedMs: 0 };
    const { promise, resolve } = Promise.withResolvers();
    let finished = false;
    let req;
    const finish = (failure = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      result.failure = failure;
      result.elapsedMs = Date.now() - sent;
      if (!options.health) outcomes.push(result);
      resolve(result);
    };
    const headers = { "X-Request-ID": requestId };
    if (meta.authenticated) headers.Authorization = identities[index].authorization;
    if (variant !== "direct-ip") headers["X-Forwarded-For"] = variant === "distinct-ip" ? `192.0.2.${index + 1}` : "192.0.2.1";
    const suffix = options.health ? "/v1/health" : `/${identities[topicIndex].topic}${options.write ? "" : "/json"}`;
    const query = new URLSearchParams({ diagnostic_request: requestId });
    if (!options.stream && !options.write && !options.health) query.set("poll", "1");
    const timer = setTimeout(() => {
      finish("request_deadline");
      req?.destroy();
    }, options.stream ? 8e3 : 2e3);
    req = request({ hostname: "127.0.0.1", port, path: suffix + "?" + query, method: options.write ? "POST" : "GET", agent, headers, signal: AbortSignal.any([signal, shutdown.signal]) }, (response) => {
      result.status = response.statusCode ?? null;
      result.authorizationChallengePresent = response.headers["www-authenticate"] !== void 0;
      let buffer = "";
      let totalBytes = 0;
      const decoder = new TextDecoder();
      if (options.stream && result.status === 200) heldResponses.add(response);
      response.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > 65536) {
          finish("response_too_large");
          response.destroy();
          return;
        }
        buffer += decoder.decode(chunk, { stream: true });
        if (!options.stream || result.status !== 200) return;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.event === "open") {
              result.openEvents++;
              finish();
            }
          } catch {
            finish("invalid_stream_json");
            response.destroy();
          }
        }
      });
      response.on("end", () => {
        heldResponses.delete(response);
        if (options.stream && result.status === 200) {
          finish("stream_ended_before_open");
          return;
        }
        if (result.status !== null && result.status >= 400) {
          try {
            const body = JSON.parse(buffer);
            if (typeof body.code === "number" && Number.isSafeInteger(body.code)) result.errorCode = body.code;
          } catch {
          }
        }
        finish();
      });
      response.on("error", () => finish("response_io_error"));
      response.on("aborted", () => finish("response_aborted"));
    });
    active.add(req);
    req.on("close", () => active.delete(req));
    req.on("error", () => finish(signal.aborted || shutdown.signal.aborted ? "deadline" : "request_io_error"));
    req.end(options.write ? "isolated-authorization-negative-check" : void 0);
    return await promise;
  }
  async function diagnose(index, origin, signal) {
    const failureAt = Date.now();
    const immediate = http("failure-ownpoll-immediate", index, index, signal);
    const aclAtFailure = snapshot();
    const delayed = (async () => {
      await delay(Math.max(0, failureAt + 1e3 - Date.now()), AbortSignal.any([signal, shutdown.signal]));
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
      delayedTargetMs: 1e3,
      immediate: probes[0].status === "fulfilled" ? probes[0].value : { failure: "diagnostic_deadline" },
      delayed: probes[1].status === "fulfilled" ? probes[1].value : { failure: "diagnostic_deadline" },
      aclAtFailure,
      aclMatchesBaseline: !!baseline && JSON.stringify(aclAtFailure) === JSON.stringify(baseline)
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
      ""
    ].join("\n"), { mode: 384 });
    child = spawn(binary, ["serve", "--config", configPath], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    child.on("error", () => {
      spawnFailed = true;
    });
    for (const output of [child.stdout, child.stderr]) {
      let pending = "";
      output.setEncoding("utf8");
      output.on("data", (chunk) => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.length <= 65536) projectLog(line);
          else unparsedLogLines++;
        }
        if (pending.length > 65536) {
          pending = "";
          unparsedLogLines++;
        }
      });
      output.on("end", () => {
        if (pending.trim()) projectLog(pending);
      });
    }
    const startupDeadline = Date.now() + 5e3;
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
    if (!baseline.consistent) {
      anomaly = true;
      scenarioFailure = "baseline_acl_inconsistent";
    }
    stage = "preflight";
    let preflightFailed = false;
    for (let index = 0; index < CAPACITY; index++) {
      for (const check of [
        { role: "ownpoll", topic: index, expected: 200, options: {} },
        { role: "foreignpoll", topic: (index + 1) % CAPACITY, expected: 403, options: {} },
        { role: "anonymouspoll", topic: index, expected: 403, options: { anonymous: true } },
        { role: "devicewrite", topic: index, expected: 403, options: { write: true } }
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
    const openOne = async (index) => {
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
    if (child && !await stop(child)) {
      cleanupFailure = true;
      anomaly = true;
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      cleanupFailure = true;
      anomaly = true;
    }
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
  const streams = outcomes.filter((outcome) => outcome.role === "capacity");
  const statuses = {};
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
    serverLogs: { categories: logCategories, unparsedLines: unparsedLogLines, droppedEvents: droppedLogEvents, wrongUserEvents, events: serverEvents }
  });
  return { anomaly, unexpected403, wrongUserEvents, variant, round, openEvents: streams.reduce((total, stream) => total + stream.openEvents, 0) };
}
async function main() {
  const args = process.argv.slice(2);
  let binary = process.env.SURENECO_TEST_NTFY_BIN ?? "";
  let variant = "all";
  let rounds = 5;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (!value) throw new Error("invalid_arguments");
    if (args[index] === "--binary") binary = value;
    else if (args[index] === "--variant" && (value === "all" || variants.includes(value))) variant = value;
    else if (args[index] === "--rounds" && /^\d+$/.test(value)) rounds = Number(value);
    else throw new Error("invalid_arguments");
  }
  if (!binary || !isAbsolute2(binary) || /[\r\n\x00]/.test(binary) || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 20) throw new Error("invalid_arguments");
  const selected = variant === "all" ? ["same-ip", "distinct-ip"] : [variant];
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
