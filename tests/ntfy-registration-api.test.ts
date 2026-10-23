import { createECDH, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../server/api";
import { challenge } from "../server/channels";
import { deliver } from "../server/delivery";
import {
  createNtfyAdminService,
  NtfyAdminClient,
} from "../server/ntfy-admin-service";
import { NtfyRegistration } from "../server/ntfy-registration";
import { Store } from "../server/store";
import type { PushData } from "../server/web-push";
import { defaults } from "../src/core/settings";

vi.setConfig({ testTimeout: 30000 });
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "sureneco-registration-api-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Store(join(dir, "db"));
  cleanup.push(() => db.close());
  const admin = {
    ensureAccount: vi.fn(async (_uid: string, _password: string) => {}),
    grantRead: vi.fn(async (_uid: string, _topic: string) => {}),
    revokeRead: vi.fn(async (_uid: string, _topic: string) => {}),
    removeAccount: vi.fn(async (_uid: string) => {}),
  };
  const socket = join(dir, "admin.sock");
  const management = await createNtfyAdminService(socket, admin);
  cleanup.push(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    management.close(() => resolve());
    return promise;
  });
  const registration = new NtfyRegistration(db, new NtfyAdminClient(socket));
  const messages: PushData[] = [];
  const push = {
    origin: "https://push.example",
    publicKey: "public-vapid",
    send: async (_subscription: unknown, message: PushData) => {
      messages.push(message);
    },
  };
  const server = createApi(db, push, enabled ? registration : null);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    server.closeAllConnections();
    return promise;
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(
    path: string,
    method = "GET",
    token?: string,
    body?: unknown,
  ) {
    const response = await fetch(base + path, {
      method,
      headers: token ? { Authorization: "Bearer " + token } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  const issue = async () =>
    (await request("/v1/device", "POST", undefined, { consent: true })).body;
  return { db, admin, registration, messages, push, request, issue };
}
function subscription(topic: string) {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    consent: true,
    settings: {
      ...Object.fromEntries(
        Object.entries(defaults).filter(
          ([key]) => !key.startsWith("launcher_"),
        ),
      ),
      update_sec: 60,
    },
    watched: ["1792548000"],
    pushSubscription: {
      endpoint: "https://push.example/" + topic,
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
  };
}
it("authenticates and isolates registration credentials, validates input and preserves deletion jobs", async () => {
  const { request, issue, registration, admin, db } = await setup();
  const first = await issue();
  const second = await issue();
  const path = "/v1/ntfy-registration";
  expect((await request(path)).status).toBe(401);
  expect(await request(path, "GET", first.token)).toEqual({
    status: 200,
    body: { registration: null },
  });
  expect((await request(path, "POST", first.token)).status).toBe(405);
  for (const input of [
    [],
    null,
    {},
    { topic: "upone", username: "admin" },
    { topic: "*" },
    { topic: 12 },
  ])
    expect((await request(path, "PUT", first.token, input)).status).toBe(400);
  const created = await request(path, "PUT", first.token, { topic: "upone" });
  expect(created.status).toBe(200);
  expect(created.body.registration).toMatchObject({
    topic: "upone",
    state: "pending",
    error: null,
  });
  expect(created.body.registration.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await request(path, "GET", second.token)).toEqual({
    status: 200,
    body: { registration: null },
  });
  expect(await request(path, "PUT", second.token, { topic: "upone" })).toEqual({
    status: 409,
    body: { error: "topic_conflict" },
  });
  await registration.tick();
  expect(
    (await request(path, "GET", first.token)).body.registration.state,
  ).toBe("ready");
  expect(
    (await request(path, "DELETE", first.token, { uid: second.deviceId }))
      .status,
  ).toBe(400);
  expect((await request(path, "DELETE", first.token)).status).toBe(200);
  await registration.tick();
  expect(
    (await request(path, "GET", first.token)).body.registration.state,
  ).toBe("stopped");
  expect(
    (await request(path, "PUT", first.token, { topic: "uptwo" })).body
      .registration.password,
  ).toBe(created.body.registration.password);
  await registration.tick();
  expect((await request("/v1/device", "DELETE", first.token)).status).toBe(200);
  expect(
    db.get("SELECT 1 FROM devices WHERE uid=?", first.deviceId),
  ).toBeUndefined();
  const before = admin.removeAccount.mock.calls.length;
  await registration.tick();
  expect(admin.removeAccount.mock.calls.length).toBe(before + 1);
  expect((await request(path, "GET", first.token)).status).toBe(401);
});
it("sends challenges and recruitment only for the ready matching reservation and stops ACLs with subscriptions", async () => {
  const { request, issue, registration, messages, db, push, admin } =
    await setup();
  const device = await issue();
  const token = device.token;
  await request("/v1/ntfy-registration", "PUT", token, { topic: "upone" });
  const data = subscription("upone");
  expect((await request("/v1/subscription", "PUT", token, data)).status).toBe(
    200,
  );
  expect(messages).toHaveLength(0);
  await registration.tick();
  await request("/v1/subscription", "PUT", token, data);
  expect(messages).toHaveLength(1);
  expect(
    (
      await request("/v1/subscription/confirm", "POST", token, {
        challenge: messages[0].challenge,
        generation: messages[0].generation,
      })
    ).status,
  ).toBe(200);
  const queue = (id: string) => {
    const now = Date.now();
    const revision = db.get<{ revision: number }>(
      "SELECT revision FROM subscriptions WHERE uid=?",
      device.deviceId,
    )!.revision;
    const expires = now + 300000;
    db.run(
      "INSERT INTO events(id,uid,expires) VALUES(?,?,?)",
      id,
      device.deviceId,
      expires,
    );
    db.run(
      "INSERT INTO outbox(id,uid,revision,expires,payload,created) VALUES(?,?,?,?,?,?)",
      id,
      device.deviceId,
      revision,
      expires,
      JSON.stringify({
        eventId: id,
        revision,
        expiresAt: Math.floor(expires / 1000),
      }),
      now,
    );
  };
  queue("ready");
  const sender = vi.fn(async () => {});
  await deliver(db, sender);
  expect(sender).toHaveBeenCalledOnce();
  await request("/v1/ntfy-registration", "DELETE", token);
  queue("stopping");
  await deliver(db, sender);
  await registration.tick();
  queue("stopped");
  await deliver(db, sender);
  expect(sender).toHaveBeenCalledOnce();
  await request("/v1/ntfy-registration", "PUT", token, { topic: "upone" });
  await registration.tick();
  await request("/v1/ntfy-registration", "PUT", token, { topic: "uptwo" });
  queue("pending");
  await deliver(db, sender);
  expect(sender).toHaveBeenCalledOnce();
  await registration.tick();
  queue("mismatched");
  await deliver(db, sender);
  expect(sender).toHaveBeenCalledOnce();
  db.run(
    "UPDATE subscriptions SET confirmed=0,challenge_sent=0 WHERE uid=?",
    device.deviceId,
  );
  await challenge(db, device.deviceId, push);
  expect(messages).toHaveLength(1);
  expect((await request("/v1/subscription/stop", "POST", token)).status).toBe(
    200,
  );
  await registration.tick();
  expect(admin.removeAccount).toHaveBeenCalledWith(device.deviceId);
  expect(registration.get(device.deviceId)?.state).toBe("stopped");
  await request("/v1/subscription", "PUT", token, data);
  expect(messages).toHaveLength(1);
  expect(registration.get(device.deviceId)?.state).toBe("stopped");
  await request("/v1/ntfy-registration", "PUT", token, { topic: "upone" });
  await registration.tick();
  await request("/v1/subscription", "DELETE", token);
  await registration.tick();
  expect(registration.get(device.deviceId)?.state).toBe("stopped");
});
it("retains the optional service default without exposing registration as available", async () => {
  const { request, issue } = await setup(false);
  const device = await issue();
  expect(await request("/v1/ntfy-registration", "GET", device.token)).toEqual({
    status: 503,
    body: { error: "ntfy_registration_unavailable" },
  });
  expect((await request("/v1/device", "DELETE", device.token)).status).toBe(
    200,
  );
});
