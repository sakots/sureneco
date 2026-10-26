import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import type { PushData } from "../server/web-push";
import { Store } from "../server/store";
import { createApi } from "../server/api";
import { fetchBoard, validateDataUrl } from "../server/http";
import { defaults } from "../src/core/settings";

// One API scenario includes multiple durable writes and isolated validations.
vi.setConfig({ testTimeout: 30000 });

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "sureneco-api-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function api() {
  const db = new Store(join(directory(), "db"));
  cleanup.push(() => db.close());
  const messages: PushData[] = [];
  const server = createApi(db, {
    origin: "https://push.example",
    publicKey: "public-vapid",
    send: async (_sub, message) => {
      messages.push(message);
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return {
    db,
    messages,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
function input() {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    settings: {
      ...Object.fromEntries(
        Object.entries(defaults).filter(([k]) => !k.startsWith("launcher_")),
      ),
      update_sec: 60,
    },
    watched: ["1792548000"],
    consent: true,
    pushSubscription: {
      endpoint: "https://push.example/up" + randomBytes(16).toString("hex"),
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
  };
}
it("authenticates real device credentials and activates monitoring only after a one-time push challenge", async () => {
  const { base, messages, db } = await api();
  const issue = async () =>
    await (
      await fetch(base + "/v1/device", {
        method: "POST",
        body: JSON.stringify({ consent: true }),
      })
    ).json();
  const first = await issue();
  const second = await issue();
  const headers = { Authorization: "Bearer " + first.token };
  const data = input();
  expect((await fetch(base + "/v1/subscription")).status).toBe(401);
  const put = () =>
    fetch(base + "/v1/subscription", {
      method: "PUT",
      headers,
      body: JSON.stringify(data),
    });
  expect((await put()).status).toBe(200);
  expect(messages).toHaveLength(1);
  const status = () =>
    fetch(base + "/v1/subscription", { headers }).then((r) => r.json());
  expect((await status()).subscription.active).toBe(false);
  const confirm = () =>
    fetch(base + "/v1/subscription/confirm", {
      method: "POST",
      headers,
      body: JSON.stringify({
        challenge: messages[0].challenge,
        generation: messages[0].generation,
      }),
    });
  const foreign = await fetch(base + "/v1/subscription/confirm", {
    method: "POST",
    headers: { Authorization: "Bearer " + second.token },
    body: JSON.stringify({
      challenge: messages[0].challenge,
      generation: messages[0].generation,
    }),
  });
  expect(foreign.status).toBe(400);
  expect((await confirm()).status).toBe(200);
  expect((await status()).subscription.active).toBe(true);
  expect((await confirm()).status).toBe(400);
  const text = JSON.stringify(await status());
  expect(text).not.toContain(data.pushSubscription.endpoint);
  expect(text).not.toContain(data.pushSubscription.keys.auth);
  expect((await put()).status).toBe(200);
  expect(messages).toHaveLength(1);
  expect(
    (
      await fetch(base + "/v1/subscription", {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...data, uid: second.deviceId }),
      })
    ).status,
  ).toBe(400);
  await fetch(base + "/v1/subscription/stop", { method: "POST", headers });
  expect((await status()).subscription.active).toBe(false);
  const nextToken = randomBytes(32).toString("base64url");
  const rotated = await (
    await fetch(base + "/v1/device/rotate", {
      method: "POST",
      headers,
      body: JSON.stringify({ newToken: nextToken }),
    })
  ).json();
  expect((await fetch(base + "/v1/subscription", { headers })).status).toBe(
    401,
  );
  expect(rotated.rotated).toBe(true);
  const newHeaders = { Authorization: "Bearer " + nextToken };
  expect(
    (
      await fetch(base + "/v1/device/rotate", {
        method: "POST",
        headers: newHeaders,
        body: JSON.stringify({ newToken: nextToken }),
      })
    ).status,
  ).toBe(200);
  await fetch(base + "/v1/device", { method: "DELETE", headers: newHeaders });
  expect(
    (
      await fetch(base + "/v1/device", {
        method: "DELETE",
        headers: newHeaders,
      })
    ).status,
  ).toBe(200);
  expect(
    db.get("SELECT * FROM subscriptions WHERE uid=?", first.deviceId),
  ).toBeUndefined();
  expect(
    (await fetch(base + "/v1/subscription", { headers: newHeaders })).status,
  ).toBe(401);
});
it("limits routes, JSON input, body size, public registration and rejects unknown owners", async () => {
  const { base } = await api();
  expect((await fetch(base + "/server/data/db")).status).toBe(404);
  expect((await fetch(base + "/v1/device", { method: "PUT" })).status).toBe(
    405,
  );
  expect(
    (await fetch(base + "/v1/device", { method: "POST", body: "{" })).status,
  ).toBe(400);
  expect(
    (
      await fetch(base + "/v1/device", {
        method: "POST",
        body: "x".repeat(262145),
      })
    ).status,
  ).toBe(413);
  expect(
    (await fetch(base + "/v1/device", { method: "POST", body: "{}" })).status,
  ).toBe(400);
  for (let i = 0; i < 5; i++)
    expect(
      (
        await fetch(base + "/v1/device", {
          method: "POST",
          body: JSON.stringify({ consent: true }),
        })
      ).status,
    ).toBe(201);
  expect(
    (
      await fetch(base + "/v1/device", {
        method: "POST",
        body: JSON.stringify({ consent: true }),
      })
    ).status,
  ).toBe(429);
});
it("rejects URL traversal and redirects and decodes bounded CP932/UTF-8 data", async () => {
  for (const url of [
    "http://egg.5ch.io/mj/subject.txt",
    "https://other.example/mj/subject.txt",
    "https://egg.5ch.io/mj/../mj/subject.txt",
    "https://egg.5ch.io:443/mj/subject.txt",
    "https://egg.5ch.io/mj/subject.txt?q=x",
    "https://egg.5ch.io/mj/dat/1.dat",
  ])
    expect(() => validateDataUrl(url)).toThrow();
  let redirected: string | undefined;
  const transport = (async (_url, options) => {
    redirected = options?.redirect;
    return new Response(Buffer.from([0x97, 0x46, 0x90, 0x6c, 0x90, 0xed]), {
      status: 200,
    });
  }) as typeof fetch;
  expect(await fetchBoard(defaults.url + "subject.txt", 1000, transport)).toBe(
    "友人戦",
  );
  expect(redirected).toBe("error");
  const utf8 = (async () =>
    new Response("雀魂", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })) as typeof fetch;
  expect(await fetchBoard(defaults.url + "subject.txt", 1000, utf8)).toBe(
    "雀魂",
  );
  await expect(
    fetchBoard(
      defaults.url + "subject.txt",
      1000,
      (async () =>
        new Response(new Uint8Array(5 * 1024 * 1024 + 1))) as typeof fetch,
    ),
  ).rejects.toMatchObject({ code: "response_too_large" });
  await expect(
    fetchBoard(
      defaults.url + "subject.txt",
      1000,
      (async () => new Response(null, { status: 302 })) as typeof fetch,
    ),
  ).rejects.toMatchObject({ code: "http_error" });
});
it("health distinguishes this service start, running work, failures and stalled monitoring", async () => {
  let now = 1800000000000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  cleanup.push(() => clock.mockRestore());
  const { base, db } = await api();
  const read = async () => {
    const response = await fetch(base + "/healthz");
    expect(response.status).toBe(200);
    return response.json();
  };
  db.run(
    "UPDATE service_state SET started=?,finished=?,error='batch_failed' WHERE id=1",
    now - 2000,
    now - 1000,
  );
  expect(await read()).toMatchObject({
    serviceStartedAt: now,
    monitorStatus: "starting",
  });
  now += 300001;
  expect((await read()).monitorStatus).toBe("stalled");
  now += 1;
  db.run("UPDATE service_state SET started=?,error=NULL WHERE id=1", now);
  expect((await read()).monitorStatus).toBe("running");
  now += 300001;
  expect((await read()).monitorStatus).toBe("stalled");
  now += 1;
  db.run("UPDATE service_state SET finished=? WHERE id=1", now);
  expect((await read()).monitorStatus).toBe("idle");
  now += 300000;
  expect((await read()).monitorStatus).toBe("idle");
  now += 1;
  expect((await read()).monitorStatus).toBe("stalled");
  db.run(
    "UPDATE service_state SET started=?,error='batch_failed' WHERE id=1",
    now,
  );
  expect((await read()).monitorStatus).toBe("failed");
  now += 1;
  db.run(
    "UPDATE service_state SET started=?,finished=?,error=NULL WHERE id=1",
    now,
    now,
  );
  expect((await read()).monitorStatus).toBe("idle");
});

it("health aggregates active fetch and delivery failures, retains successful times and excludes private data", async () => {
  const { base, db } = await api();
  const uids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const device = await (
      await fetch(base + "/v1/device", {
        method: "POST",
        body: JSON.stringify({ consent: true }),
      })
    ).json();
    const response = await fetch(base + "/v1/subscription", {
      method: "PUT",
      headers: { Authorization: "Bearer " + device.token },
      body: JSON.stringify(input()),
    });
    expect(response.status).toBe(200);
    uids.push(device.deviceId);
  }
  db.run("UPDATE subscriptions SET active=1");
  const at = Date.now();
  for (const uid of uids) {
    db.run(
      "INSERT INTO fetch_state(uid,board,resource,attempted,succeeded,error) VALUES(?,?,?,?,?,?)",
      uid,
      defaults.url,
      "subject.txt",
      at,
      at - 1000,
      "fetch_failed",
    );
    db.run(
      "INSERT INTO delivery_state(uid,attempted,succeeded,error) VALUES(?,?,?,?)",
      uid,
      at,
      at - 2000,
      "delivery_unavailable",
    );
  }
  db.run("UPDATE subscriptions SET active=0 WHERE uid=?", uids[1]);
  db.run("INSERT INTO events VALUES(?,?,?)", "queued", uids[0], at + 600000);
  db.run(
    "INSERT INTO outbox(id,uid,revision,expires,payload,created) VALUES(?,?,?,?,?,?)",
    "queued",
    uids[0],
    1,
    at + 600000,
    "private-payload",
    at - 5000,
  );
  const failed = await (await fetch(base + "/healthz")).json();
  expect(failed.fetch).toEqual({
    lastAttemptedAt: at,
    lastSucceededAt: at - 1000,
    errorCount: 1,
  });
  expect(failed.delivery).toEqual({
    lastAttemptedAt: at,
    lastSucceededAt: at - 2000,
    errorCount: 1,
  });
  expect(failed.outbox).toEqual({ count: 1, oldestCreatedAt: at - 5000 });
  const serialized = JSON.stringify(failed);
  for (const privateValue of [
    ...uids,
    "private-payload",
    "https://push.example",
    "fetch_failed",
    "delivery_unavailable",
  ])
    expect(serialized).not.toContain(privateValue);
  db.run(
    "UPDATE fetch_state SET attempted=?,succeeded=?,error=NULL WHERE uid=?",
    at + 1,
    at + 1,
    uids[0],
  );
  db.run(
    "UPDATE delivery_state SET attempted=?,succeeded=?,error=NULL WHERE uid=?",
    at + 1,
    at + 1,
    uids[0],
  );
  db.run("DELETE FROM outbox");
  const recovered = await (await fetch(base + "/healthz")).json();
  expect(recovered.fetch).toEqual({
    lastAttemptedAt: at + 1,
    lastSucceededAt: at + 1,
    errorCount: 0,
  });
  expect(recovered.delivery).toEqual({
    lastAttemptedAt: at + 1,
    lastSucceededAt: at + 1,
    errorCount: 0,
  });
  expect(recovered.outbox).toEqual({ count: 0, oldestCreatedAt: null });
});

it("starts, rejects a second process, releases ownership on SIGKILL and restarts", async () => {
  const dbpath = join(directory(), "service.sqlite");
  // Obtain an unused port using an ephemeral local listener.
  const { createServer } = await import("node:net");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const env = {
    ...process.env,
    SURENECO_SERVER_DB: dbpath,
    SURENECO_SERVER_PORT: String(port),
  };
  for (const key of Object.keys(env))
    if (key === "SURENECO_NTFY_ORIGIN" || key === "SURENECO_VAPID_FILE")
      delete (env as Record<string, string | undefined>)[key];
  const start = async () => {
    const child = spawn(process.execPath, ["dist/server/main.mjs"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    for (let i = 0; i < 100; i++) {
      if (output.includes("ready")) return child;
      if (child.exitCode !== null) throw new Error("Server did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Startup timeout");
  };
  const first = await start();
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  expect(health.lastFinishedAt).toBeGreaterThan(0);
  expect(health.serviceStartedAt).toBeGreaterThan(0);
  expect(health.lastFinishedAt).toBeGreaterThanOrEqual(health.serviceStartedAt);
  expect(health.monitorStatus).toBe("idle");
  const second = spawn(process.execPath, ["dist/server/main.mjs"], {
    env,
    stdio: "ignore",
  });
  const [code] = await once(second, "exit");
  expect(code).toBe(1);
  first.kill("SIGKILL");
  await once(first, "exit");
  const restarted = await start();
  const recovered = await (
    await fetch(`http://127.0.0.1:${port}/healthz`)
  ).json();
  expect(recovered.serviceStartedAt).toBeGreaterThan(health.serviceStartedAt);
  expect(recovered.lastFinishedAt).toBeGreaterThanOrEqual(
    recovered.serviceStartedAt,
  );
  expect(recovered.monitorStatus).toBe("idle");
  restarted.kill("SIGTERM");
  const [end] = await once(restarted, "exit");
  expect(end).toBe(0);
}, 10000);

it("does not reactivate a stopped, expired or replaced channel with an old challenge", async () => {
  const { base, messages, db } = await api();
  const device = await (
    await fetch(base + "/v1/device", {
      method: "POST",
      body: JSON.stringify({ consent: true }),
    })
  ).json();
  const headers = { Authorization: "Bearer " + device.token };
  const put = async (data: ReturnType<typeof input>) =>
    fetch(base + "/v1/subscription", {
      method: "PUT",
      headers,
      body: JSON.stringify(data),
    });
  const confirm = async (message: PushData) =>
    fetch(base + "/v1/subscription/confirm", {
      method: "POST",
      headers,
      body: JSON.stringify({
        challenge: message.challenge,
        generation: message.generation,
      }),
    });
  const data = input();
  await put(data);
  const stopped = messages[0];
  await fetch(base + "/v1/subscription/stop", { method: "POST", headers });
  expect((await confirm(stopped)).status).toBe(400);
  await put(data);
  const expired = messages[1];
  db.run("UPDATE subscriptions SET challenge_expires=0");
  expect((await confirm(expired)).status).toBe(400);
  await put(input());
  const current = messages[2];
  expect((await confirm(expired)).status).toBe(400);
  expect((await confirm(current)).status).toBe(200);
  await fetch(base + "/v1/device", { method: "DELETE", headers });
  expect((await put(data)).status).toBe(401);
  expect(db.get("SELECT * FROM subscriptions")).toBeUndefined();
});
