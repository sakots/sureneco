import { createRequire } from "node:module";
import { expect, it } from "vitest";
import webpush from "web-push";
import { createECDH, randomBytes } from "node:crypto";
import {
  PushTransport,
  parsePushSubscription,
  publicAddress,
} from "../server/web-push";
function subscription(key = createECDH("prime256v1")) {
  key.generateKeys();
  return {
    endpoint: "https://push.example/up" + randomBytes(16).toString("hex"),
    keys: {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
}
it("validates keys, exact self-hosted origin, endpoint paths and rejects SSRF destinations", () => {
  const sub = subscription();
  expect(parsePushSubscription(sub, "https://push.example")).toEqual(sub);
  expect(
    parsePushSubscription(
      { ...sub, endpoint: sub.endpoint + "?up=1" },
      "https://push.example",
    ),
  ).toEqual(sub);
  for (const endpoint of [
    "http://push.example/upabc",
    "https://else.example/upabc",
    "https://push.example/admin",
    "https://push.example/upabc?q=x",
    "https://push.example/upabc#secret",
    "https://user:pass@push.example/upabc",
  ])
    expect(() =>
      parsePushSubscription({ ...sub, endpoint }, "https://push.example"),
    ).toThrow();
  expect(() =>
    parsePushSubscription(
      { ...sub, keys: { ...sub.keys, auth: "fake" } },
      "https://push.example",
    ),
  ).toThrow();
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    expect(publicAddress(ip)).toBe(false);
  expect(publicAddress("8.8.8.8")).toBe(true);
  expect(publicAddress("2606:4700:4700::1111")).toBe(true);
});
it("creates encrypted aes128gcm Web Push with bounded TTL and no plaintext body", () => {
  const vapid = webpush.generateVAPIDKeys();
  const push = new PushTransport({
    origin: "https://push.example",
    subject: "mailto:test@example.com",
    ...vapid,
  });
  const receiver = createECDH("prime256v1");
  const sub = subscription(receiver);
  const request = push.message(sub, {
    type: "challenge",
    challenge: "private-challenge",
    expiresAt: Math.floor(Date.now() / 1000) + 100,
  });
  expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
  expect(request.headers["X-UnifiedPush"]).toBe("1");
  expect(Number(request.headers.TTL)).toBeLessThanOrEqual(100);
  expect(
    Buffer.from(request.body!).includes(Buffer.from("private-challenge")),
  ).toBe(false);
  expect(request.headers.Authorization).toMatch(/^vapid /);
  const ece = createRequire(import.meta.resolve("web-push"))("http_ece");
  const decrypted = ece.decrypt(request.body, {
    version: "aes128gcm",
    privateKey: receiver,
    authSecret: sub.keys.auth,
  });
  expect(JSON.parse(decrypted.toString()).challenge).toBe("private-challenge");
  expect(() =>
    ece.decrypt(request.body, {
      version: "aes128gcm",
      privateKey: receiver,
      authSecret: randomBytes(16),
    }),
  ).toThrow();
});
it("refuses private DNS results before sending and bounds transient errors without exposing URLs", async () => {
  const vapid = webpush.generateVAPIDKeys();
  const push = new PushTransport(
    {
      origin: "https://push.example",
      subject: "mailto:test@example.com",
      ...vapid,
    },
    async () => [{ address: "127.0.0.1", family: 4 }],
  );
  await expect(
    push.send(
      subscription(),
      {
        type: "challenge",
        challenge: "secret",
        expiresAt: Math.floor(Date.now() / 1000) + 100,
      },
      1000,
    ),
  ).rejects.toMatchObject({ code: "invalid_destination" });
});
