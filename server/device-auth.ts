import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Store } from "./store";
import { rateLimit } from "./subscriptions";
export class AuthError extends Error {
  constructor(readonly status = 401) {
    super("Authentication unavailable.");
  }
}
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class DeviceAuth {
  constructor(private readonly db: Store) {}
  issue(ip: string, now = Date.now()) {
    if (!rateLimit(this.db, "device-issue", ip, 5, now))
      throw new AuthError(429);
    const deviceId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.db.run(
      "INSERT INTO devices(uid,token_hash,created) VALUES(?,?,?)",
      deviceId,
      hashToken(token),
      now,
    );
    return { deviceId, token };
  }
  authenticate(authorization?: string): string {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    if (!match) throw new AuthError();
    const device = this.db.get<{ uid: string }>(
      "SELECT uid FROM devices WHERE token_hash=?",
      hashToken(match[1]),
    );
    if (!device) throw new AuthError();
    return device.uid;
  }
  rotate(uid: string, token: string) {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      this.db.get(
        "SELECT uid FROM devices WHERE token_hash=? AND uid<>?",
        hashToken(token),
        uid,
      )
    )
      throw new AuthError(400);
    if (
      !this.db.run(
        "UPDATE devices SET token_hash=? WHERE uid=?",
        hashToken(token),
        uid,
      ).changes
    )
      throw new AuthError();
    return { deviceId: uid, rotated: true };
  }
  remove(uid: string) {
    this.db.transaction(() => {
      this.db.run("DELETE FROM subscriptions WHERE uid=?", uid);
      this.db.run("DELETE FROM devices WHERE uid=?", uid);
    });
  }
}
