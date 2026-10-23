import { randomBytes } from "node:crypto";
import type { PushSubscription } from "web-push";
import type { Store } from "./store";
import { hashToken } from "./device-auth";
import { bad, subscriptions, type Reply } from "./subscriptions";
import type { PushData } from "./web-push";
import { ntfyDeliveryAllowed } from "./ntfy-registration";
export interface PushChannel {
  origin: string;
  publicKey: string;
  send(
    subscription: PushSubscription,
    data: PushData,
    timeout: number,
  ): Promise<void>;
}
export async function challenge(
  db: Store,
  uid: string,
  push: PushChannel,
  now = Date.now(),
) {
  const row = db.get<{
    token: string;
    endpoint: string;
    generation: string;
    confirmed: number;
    challenge_sent: number;
  }>("SELECT * FROM subscriptions WHERE uid=?", uid);
  if (!row || row.confirmed || row.challenge_sent > now - 60000) return;
  if (!ntfyDeliveryAllowed(db, uid, row.endpoint)) return;
  const token = randomBytes(32).toString("base64url");
  const expires = now + 300000;
  db.run(
    "UPDATE subscriptions SET challenge_hash=?,challenge_expires=?,challenge_sent=? WHERE uid=? AND generation=?",
    hashToken(token),
    expires,
    now,
    uid,
    row.generation,
  );
  await push.send(
    JSON.parse(row.token),
    {
      type: "challenge",
      challenge: token,
      generation: row.generation,
      expiresAt: Math.floor(expires / 1000),
    },
    5000,
  );
}
export async function confirm(
  db: Store,
  uid: string,
  input: unknown,
  now = Date.now(),
): Promise<Reply> {
  if (!input || typeof input !== "object") return bad(400, "invalid_challenge");
  const v = input as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !["challenge", "generation"].includes(k)) ||
    typeof v.challenge !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.challenge) ||
    typeof v.generation !== "string"
  )
    return bad(400, "invalid_challenge");
  const changed = db.run(
    "UPDATE subscriptions SET active=1,confirmed=1,challenge_hash=NULL,challenge_expires=0 WHERE uid=? AND generation=? AND challenge_hash=? AND challenge_expires>?",
    uid,
    v.generation,
    hashToken(v.challenge),
    now,
  );
  if (!changed.changes) return bad(400, "invalid_challenge");
  return subscriptions(db, uid, "GET", null, now);
}
