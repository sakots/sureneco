import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { Store } from "../server/store";
import { createApi } from "../server/api";
import {
  AuthError,
  checkIdentity,
  messageFor,
  deliveryFailure,
} from "../server/firebase-sdk";
import { Firebase, firebaseConfig } from "../server/firebase";
import { fetchBoard, validateDataUrl } from "../server/http";
import { defaults } from "../src/core/settings";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "sureneco-api-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function api(
  auth = async (id?: string, check?: string) => {
    if (id !== "Bearer accepted" || check !== "checked") throw new AuthError();
    return "owner";
  },
) {
  const db = new Store(join(directory(), "db.sqlite"));
  cleanup.push(() => db.close());
  const server = createApi(db, auth);
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
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
const headers = {
  Authorization: "Bearer accepted",
  "X-Firebase-AppCheck": "checked",
  "Content-Type": "application/json",
};
const settings = Object.fromEntries(
  Object.entries(defaults).filter(([key]) => !key.startsWith("launcher_")),
);
const input = {
  settings: { ...settings, update_sec: 60 },
  watched: ["1792548000"],
  consent: true,
  fcmToken: "secret-notification-token",
};
it("runs the HTTP subscription lifecycle without exposing tokens and rejects unauthenticated or foreign operations", async () => {
  const { base } = await api();
  expect((await fetch(base + "/v1/subscription")).status).toBe(401);
  expect(
    (
      await fetch(base + "/v1/subscription", {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...input, uid: "other" }),
      })
    ).status,
  ).toBe(400);
  const registered = await fetch(base + "/v1/subscription", {
    method: "PUT",
    headers,
    body: JSON.stringify(input),
  });
  expect(registered.status).toBe(200);
  expect(await registered.text()).not.toContain("secret-notification-token");
  expect(
    (await (await fetch(base + "/v1/subscription", { headers })).json())
      .subscription.active,
  ).toBe(true);
  expect(
    (
      await (
        await fetch(base + "/v1/subscription/stop", { method: "POST", headers })
      ).json()
    ).subscription.active,
  ).toBe(false);
  await fetch(base + "/v1/subscription", { method: "DELETE", headers });
  expect(
    (await (await fetch(base + "/v1/subscription", { headers })).json())
      .subscription,
  ).toBeNull();
});
it("restricts routes, methods, input size, malformed JSON and request frequency", async () => {
  const { base } = await api();
  expect((await fetch(base + "/server/data/monitor.sqlite")).status).toBe(404);
  const badMethod = await fetch(base + "/v1/subscription", {
    method: "POST",
    headers,
  });
  expect(badMethod.status).toBe(405);
  expect(badMethod.headers.get("allow")).toContain("PUT");
  expect(
    (
      await fetch(base + "/v1/subscription", {
        method: "PUT",
        headers,
        body: "{",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(base + "/v1/subscription", {
        method: "PUT",
        headers,
        body: "x".repeat(262145),
      })
    ).status,
  ).toBe(413);
  for (let i = 0; i < 120; i++) await fetch(base + "/v1/subscription");
  expect((await fetch(base + "/v1/subscription")).status).toBe(429);
});
it("fails closed for missing Firebase configuration and rejects malformed tokens through the actual SDK worker", async () => {
  const firebase = new Firebase(null);
  cleanup.push(() => firebase.close());
  const { base } = await api((id, check) => firebase.authenticate(id, check));
  expect((await fetch(base + "/v1/subscription", { headers })).status).toBe(
    503,
  );
  const configured = new Firebase({
    projectId: "sureneco-test",
    projectNumber: "123",
    appId: "1:123:android:abcdef",
  });
  cleanup.push(() => configured.close());
  await expect(
    configured.authenticate("Bearer invalid.jwt", "invalid.check"),
  ).rejects.toMatchObject({ status: 401 });
});
it("requires exact verified Firebase project, issuer, app and expiry", () => {
  const config = {
    projectId: "sureneco-test",
    projectNumber: "123",
    appId: "1:123:android:abcdef",
  };
  const now = Date.now();
  const id = {
    uid: "owner",
    aud: config.projectId,
    iss: `https://securetoken.google.com/${config.projectId}`,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600,
  };
  const checked = {
    app_id: config.appId,
    aud: ["projects/123"],
    iss: "https://firebaseappcheck.googleapis.com/123",
    iat: id.iat,
    exp: id.exp,
  };
  expect(checkIdentity(config, id, checked, now)).toBe("owner");
  for (const invalid of [
    { ...id, aud: "foreign" },
    { ...id, exp: 1 },
    { ...id, iss: "fake" },
  ])
    expect(() => checkIdentity(config, invalid, checked, now)).toThrow();
  for (const invalid of [
    { ...checked, app_id: "other" },
    { ...checked, iss: "https://firebaseappcheck.googleapis.com/999" },
    { ...checked, aud: ["projects/999"] },
    { ...checked, exp: 1 },
  ])
    expect(() => checkIdentity(config, id, invalid, now)).toThrow();
  expect(firebaseConfig({})).toBeNull();
  expect(() =>
    firebaseConfig({ SURENECO_FIREBASE_PROJECT_ID: "test" }),
  ).toThrow("Firebase configuration unavailable.");
});
it("bounds FCM data and TTL, targets the current Android package, and classifies retries without credentials", () => {
  const now = Date.now();
  const payload = {
    eventId: "id",
    revision: 1,
    expiresAt: Math.floor(now / 1000) + 120,
    boardUrl: defaults.url,
    threadId: "1792548000",
    threadTitle: "雀魂".repeat(1000),
    recruitment: {
      number: 1,
      name: "",
      id: "",
      watchoi: "",
      body: "友人戦".repeat(1000),
      roomIds: ["12345"],
      postedAt: now,
      threadId: "1792548000",
      closed: false,
    },
  };
  const message = messageFor("destination", payload, now);
  const applicationId = readFileSync(
    "src-tauri/gen/android/app/build.gradle.kts",
    "utf8",
  ).match(/applicationId\s*=\s*"([^"]+)"/)![1];
  expect(message.android?.restrictedPackageName).toBe(applicationId);
  expect(message.android?.ttl).toBeGreaterThan(0);
  expect(message.android?.ttl).toBeLessThanOrEqual(120000);
  expect(message).not.toHaveProperty("notification");
  expect(Buffer.byteLength(message.data!.body)).toBeLessThanOrEqual(1500);
  expect(Buffer.byteLength(message.data!.title)).toBeLessThanOrEqual(240);
  expect(() => messageFor("x", { ...payload, expiresAt: 0 }, now)).toThrow();
  expect(
    deliveryFailure({ code: "messaging/registration-token-not-registered" }),
  ).toMatchObject({ code: "unregistered", retryable: false });
  expect(deliveryFailure({ code: "messaging/invalid-argument" })).toMatchObject(
    { code: "invalid_argument", retryable: false },
  );
  expect(
    deliveryFailure({
      code: "messaging/server-unavailable",
      httpResponse: { headers: { "retry-after": "120" } },
    }),
  ).toMatchObject({ retryable: true, retryAfter: 120 });
  expect(deliveryFailure(new Error("private_key token")).message).toBe(
    "Push delivery failed.",
  );
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
    if (
      key.startsWith("SURENECO_FIREBASE_") ||
      key === "SURENECO_FCM_CREDENTIALS"
    )
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
  const second = spawn(process.execPath, ["dist/server/main.mjs"], {
    env,
    stdio: "ignore",
  });
  const [code] = await once(second, "exit");
  expect(code).toBe(1);
  first.kill("SIGKILL");
  await once(first, "exit");
  const restarted = await start();
  restarted.kill("SIGTERM");
  const [end] = await once(restarted, "exit");
  expect(end).toBe(0);
}, 10000);
