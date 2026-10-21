import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const now = 1800000000;
const payload = {
  eventId: "event-1",
  revision: 12,
  expiresAt: now + 120,
  boardUrl: "https://egg.5ch.io/mj/",
  threadId: "1792548000",
  threadTitle: "雀魂".repeat(300),
  recruitment: {
    number: 12,
    body: "友人戦 12345 あと1人".repeat(300),
    roomIds: ["12345"],
  },
};
interface Output {
  requests: { url: string; timeout: number }[];
  messages: {
    message: {
      notification?: unknown;
      token: string;
      data: Record<string, string>;
      android: { priority: string; ttl: string };
    };
  }[];
  claims: { iss: string; aud: string; scope: string; iat: number; exp: number };
  verified: boolean;
  errors: ({
    code: string;
    retryable: boolean;
    retryAfter: number;
    message: string;
  } | null)[];
}
async function run(changes: Record<string, unknown> = {}): Promise<Output> {
  const running = execute("php", ["tests/fixtures/fcm.php"], {
    timeout: 10000,
  });
  running.child.stdin!.end(JSON.stringify({ now, payload, ...changes }));
  const { stdout, stderr } = await running;
  expect(stderr).toBe("");
  return JSON.parse(stdout) as Output;
}
it("signs short-lived OAuth claims and sends bounded data-only Android messages with a remaining TTL", async () => {
  const result = await run({ count: 2 });
  expect(result.verified).toBe(true);
  expect(result.claims).toEqual({
    iss: "sender@sureneco-test.iam.gserviceaccount.com",
    aud: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    iat: now,
    exp: now + 3600,
  });
  expect(result.requests.map((item) => item.url)).toEqual([
    "https://oauth2.googleapis.com/token",
    "https://fcm.googleapis.com/v1/projects/sureneco-test/messages:send",
    "https://fcm.googleapis.com/v1/projects/sureneco-test/messages:send",
  ]);
  expect(result.errors).toEqual([null, null]);
  const message = result.messages[0].message;
  expect(message.notification).toBeUndefined();
  expect(message.android).toMatchObject({ ttl: "120s", priority: "HIGH" });
  expect(message.data).toMatchObject({
    eventId: "event-1",
    revision: "12",
    expiresAt: String(now + 120),
    postNumber: "12",
    roomIds: '["12345"]',
  });
  expect(Buffer.byteLength(message.data.body)).toBeLessThanOrEqual(1500);
  expect(Buffer.byteLength(message.data.title)).toBeLessThanOrEqual(240);
  expect(
    Object.values(message.data).every((item) => typeof item === "string"),
  ).toBe(true);
  expect(
    result.requests.every((item) => item.timeout > 0 && item.timeout <= 3000),
  ).toBe(true);
});
it("distinguishes UNREGISTERED from payload, project and temporary errors without exposing credentials", async () => {
  const result = await run({
    count: 5,
    responses: [
      {
        status: 404,
        body: JSON.stringify({
          error: {
            details: [
              {
                "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                errorCode: "UNREGISTERED",
              },
            ],
          },
        }),
      },
      { status: 400, body: '{"error":{"status":"INVALID_ARGUMENT"}}' },
      { status: 404, body: '{"error":{"status":"NOT_FOUND"}}' },
      { status: 503, body: "unavailable", retryAfter: 180 },
      { status: 401, body: "unauthorized" },
    ],
  });
  expect(result.errors.map((item) => item?.code)).toEqual([
    "unregistered",
    "invalid_argument",
    "invalid_argument",
    "delivery_unavailable",
    "delivery_authentication",
  ]);
  expect(result.errors[3]).toMatchObject({ retryable: true, retryAfter: 180 });
  expect(
    result.errors.every((item) => item?.message === "Push delivery failed."),
  ).toBe(true);
});
it("rejects mismatched credentials and expired messages, and handles OAuth failure without leaking secrets", async () => {
  const mismatch = await run({ credentials: { project_id: "other-project" } });
  expect(mismatch.errors[0]?.code).toBe("delivery_configuration");
  expect(mismatch.requests).toEqual([]);
  const expired = await run({ payload: { ...payload, expiresAt: now - 1 } });
  expect(expired.messages).toEqual([]);
  expect(expired.errors[0]?.code).toBe("expired");
  const failed = await run({
    oauthResponse: { status: 400, body: "secret fixture-token private_key" },
  });
  expect(failed.errors[0]).toMatchObject({
    code: "delivery_authentication",
    message: "Push delivery failed.",
  });
  expect(failed.messages).toEqual([]);
});
