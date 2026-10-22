import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store";
import { DeviceAuth } from "../server/device-auth";
let db: Store;
let dir: string;
afterEach(() => {
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  dir = mkdtempSync(join(tmpdir(), "sureneco-auth-"));
  db = new Store(join(dir, "db"));
  return new DeviceAuth(db);
}
it("issues independent device credentials, stores only hashes, rotates and revokes ownership", () => {
  const auth = setup();
  const first = auth.issue("127.0.0.1", 1000);
  const second = auth.issue("127.0.0.2", 1000);
  expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(auth.authenticate("Bearer " + first.token)).toBe(first.deviceId);
  expect(auth.authenticate("Bearer " + second.token)).toBe(second.deviceId);
  expect(readFileSync(db.path).includes(Buffer.from(first.token))).toBe(false);
  const nextToken = randomBytes(32).toString("base64url");
  const rotated = {
    token: nextToken,
    ...auth.rotate(first.deviceId, nextToken),
  };
  expect(() => auth.authenticate("Bearer " + first.token)).toThrow();
  expect(auth.authenticate("Bearer " + rotated.token)).toBe(first.deviceId);
  auth.remove(first.deviceId);
  expect(() => auth.authenticate("Bearer " + rotated.token)).toThrow();
  expect(auth.authenticate("Bearer " + second.token)).toBe(second.deviceId);
});
it("rejects missing, malformed and unknown credentials and bounds unauthenticated issuance", () => {
  const auth = setup();
  for (const value of [
    undefined,
    "",
    "Bearer fake",
    "Basic foo",
    "Bearer " + "x".repeat(43),
    "Bearer " + "x".repeat(43) + "\n",
  ])
    expect(() => auth.authenticate(value)).toThrow();
  for (let i = 0; i < 5; i++) auth.issue("same-ip", 1000);
  expect(() => auth.issue("same-ip", 1000)).toThrow();
  expect(auth.issue("different-ip", 1000).token).toBeTruthy();
  expect(auth.issue("same-ip", 61001).token).toBeTruthy();
});
