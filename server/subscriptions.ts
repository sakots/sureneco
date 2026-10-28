import { createHash, randomUUID } from "node:crypto";
import { boardUrl, validThreadId } from "../src/core/settings";
import type { Settings } from "../src/core/types";
import { runDetection } from "./detection";
import { Store } from "./store";
import { parsePushSubscription } from "./web-push";
export type MobileSettings = Omit<
  Settings,
  | "launcher_mode"
  | "launcher_path"
  | "launcher_args"
  | "launcher_profile"
  | "launcher_user_data_dir"
>;
export interface Subscription {
  uid: string;
  revision: number;
  active: number;
  settings: string;
  watched: string;
  token: string;
  endpoint: string;
  generation: string;
  confirmed: number;
  challenge_hash: string | null;
  consented: number;
  created: number;
  updated: number;
}
export interface SubscriptionView {
  revision: number;
  active: boolean;
  channelConfirmed: boolean;
  generation: string;
  settings: MobileSettings;
  watched: string[];
  lastFetchSuccessAt: number | null;
  error: string | null;
  delivery: unknown;
  monitoringReady: false;
}
export interface Reply {
  status: number;
  body: { error?: string; subscription?: SubscriptionView | null };
}
export const bad = (status: number, error: string): Reply => ({
  status,
  body: { error },
});
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const keys = [
  "update_sec",
  "thread_update_sec",
  "elapsed_days",
  "emphasis_sec",
  "thread_title_regex",
  "ng_thread_title_regex",
  "yujinsen_regex",
  "closed_yujinsen_regex",
  "url",
  "ng_words",
  "ng_ids",
  "ng_watchois",
  "allowed_watchois",
];
export function rateLimit(
  db: Store,
  scope: string,
  identity: string,
  limit: number,
  now: number,
): boolean {
  db.run("DELETE FROM rates WHERE expires<=?", now);
  const hash = createHash("sha256")
    .update(scope + ":" + identity)
    .digest("hex");
  const result = db.get<{ count: number }>(
    "INSERT INTO rates(identity,count,expires) VALUES(?,1,?) ON CONFLICT(identity) DO UPDATE SET count=count+1 RETURNING count",
    hash,
    now + 60000,
  )!;
  return result.count <= limit;
}
async function validateSettings(input: unknown): Promise<MobileSettings> {
  if (!object(input) || Object.keys(input).some((key) => !keys.includes(key)))
    throw new Error();
  const value: Record<string, unknown> = {};
  for (const key of [
    "update_sec",
    "thread_update_sec",
    "elapsed_days",
    "emphasis_sec",
  ]) {
    const number = Object.hasOwn(input, key)
      ? input[key]
      : key === "update_sec"
        ? 60
        : key === "thread_update_sec"
          ? 300
          : undefined;
    const min = key.endsWith("update_sec") || key === "update_sec" ? 60 : 1;
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < min ||
      number > 2147483
    )
      throw new Error();
    value[key] = number;
  }
  const patterns: string[] = [];
  for (const key of [
    "thread_title_regex",
    "ng_thread_title_regex",
    "yujinsen_regex",
    "closed_yujinsen_regex",
  ]) {
    const pattern = input[key];
    if (
      typeof pattern !== "string" ||
      pattern.length > 1000 ||
      (key !== "ng_thread_title_regex" && !pattern.trim())
    )
      throw new Error();
    value[key] = pattern;
    patterns.push(pattern);
  }
  if (typeof input.url !== "string") throw new Error();
  value.url = boardUrl(input.url);
  for (const key of ["ng_words", "ng_ids", "ng_watchois", "allowed_watchois"]) {
    const list = Object.hasOwn(input, key)
      ? input[key]
      : key === "allowed_watchois"
        ? []
        : null;
    if (
      !Array.isArray(list) ||
      list.length > 1000 ||
      list.some((x) => typeof x !== "string" || x.length > 500)
    )
      throw new Error();
    value[key] = [
      ...new Set((list as string[]).map((x) => x.trim()).filter(Boolean)),
    ];
  }
  await runDetection({ operation: "validate", patterns });
  return value as unknown as MobileSettings;
}
function view(db: Store, current: Subscription | undefined): Reply {
  if (!current) return { status: 200, body: { subscription: null } };
  const fetched = db.get<{ success: number | null }>(
    "SELECT MAX(succeeded) AS success FROM fetch_state WHERE uid=?",
    current.uid,
  );
  const failed = db.get<{ error: string }>(
    "SELECT error FROM fetch_state WHERE uid=? AND error IS NOT NULL ORDER BY resource LIMIT 1",
    current.uid,
  );
  const delivery =
    db.get(
      "SELECT attempted AS lastAttemptAt,succeeded AS lastSuccessAt,error FROM delivery_state WHERE uid=?",
      current.uid,
    ) ?? null;
  return {
    status: 200,
    body: {
      subscription: {
        revision: current.revision,
        active: !!current.active,
        channelConfirmed: !!current.confirmed,
        generation: current.generation,
        settings: JSON.parse(current.settings),
        watched: JSON.parse(current.watched),
        lastFetchSuccessAt: fetched?.success ?? null,
        error: failed?.error ?? null,
        delivery,
        monitoringReady: false,
      },
    },
  };
}
export async function subscriptions(
  db: Store,
  uid: string,
  method: string,
  input: unknown,
  now = Date.now(),
  origin?: string,
): Promise<Reply> {
  if (!uid || uid.length > 128 || /[\x00-\x1f\x7f]/.test(uid))
    return bad(401, "unauthorized");
  if (
    !rateLimit(db, "uid", uid, 60, now) ||
    (method === "PUT" && !rateLimit(db, "registration", uid, 10, now))
  )
    return bad(429, "rate_limited");
  let settings: MobileSettings | undefined;
  let watched: string[] = [];
  let token = "";
  let endpoint = "";
  try {
    if (method === "PUT") {
      if (
        !object(input) ||
        Object.keys(input).some(
          (key) =>
            !["settings", "watched", "pushSubscription", "consent"].includes(
              key,
            ),
        ) ||
        input.consent !== true ||
        !Array.isArray(input.watched) ||
        input.watched.length > 100 ||
        input.watched.some((id) => !validThreadId(id) || /\D/.test(id))
      )
        return bad(400, "invalid_subscription");
      watched = [...new Set(input.watched as string[])].sort();
      if (!origin) return bad(503, "push_unavailable");
      const push = parsePushSubscription(input.pushSubscription, origin);
      token = JSON.stringify(push);
      endpoint = push.endpoint;
      settings = await validateSettings(input.settings);
    } else if (input !== null && (!object(input) || Object.keys(input).length))
      return bad(400, "invalid_subscription");
  } catch (error) {
    return bad(
      error instanceof Error &&
        "code" in error &&
        error.code !== "invalid_pattern"
        ? 503
        : 400,
      error instanceof Error &&
        "code" in error &&
        error.code !== "invalid_pattern"
        ? "detection_unavailable"
        : "invalid_subscription",
    );
  }
  return db.transaction(() => {
    if (method === "PUT" && !db.get("SELECT uid FROM devices WHERE uid=?", uid))
      return bad(401, "unauthorized");
    db.prune(now);
    const current = db.get<Subscription>(
      "SELECT * FROM subscriptions WHERE uid=?",
      uid,
    );
    if (method === "DELETE")
      db.run("DELETE FROM subscriptions WHERE uid=?", uid);
    else if (method === "POST" && current) {
      db.run("DELETE FROM outbox WHERE uid=?", uid);
      if (current.active || current.challenge_hash)
        db.run(
          "UPDATE subscriptions SET active=0,confirmed=0,challenge_hash=NULL,revision=?,updated=? WHERE uid=?",
          Math.max(now * 1000, current.revision + 1),
          now,
          uid,
        );
    } else if (method === "PUT" && settings) {
      if (
        db.get(
          "SELECT uid FROM ntfy_topics WHERE topic=? AND uid<>?",
          new URL(endpoint).pathname.slice(1),
          uid,
        )
      )
        return bad(409, "endpoint_in_use");
      const encoded = JSON.stringify(settings);
      const targets = JSON.stringify(watched);
      if (
        !current ||
        (!current.active && !current.challenge_hash) ||
        current.settings !== encoded ||
        current.watched !== targets ||
        current.token !== token
      ) {
        if (
          db.get(
            "SELECT uid FROM subscriptions WHERE endpoint=? AND uid<>?",
            endpoint,
            uid,
          )
        )
          return bad(409, "endpoint_in_use");
        const revision = Math.max(now * 1000, (current?.revision ?? 0) + 1);
        const channelChanged =
          !current || current.token !== token || !current.confirmed;
        const generation = channelChanged ? randomUUID() : current.generation;
        db.run(
          "INSERT INTO subscriptions(uid,revision,active,settings,watched,token,endpoint,generation,confirmed,consented,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET revision=excluded.revision,active=excluded.active,settings=excluded.settings,watched=excluded.watched,token=excluded.token,endpoint=excluded.endpoint,generation=excluded.generation,confirmed=excluded.confirmed,challenge_hash=NULL,challenge_expires=0,challenge_sent=0,updated=excluded.updated",
          uid,
          revision,
          channelChanged ? 0 : 1,
          encoded,
          targets,
          token,
          endpoint,
          generation,
          channelChanged ? 0 : 1,
          now,
          now,
          now,
        );
        db.run("DELETE FROM outbox WHERE uid=?", uid);
        for (const cursor of db.all<{ board: string; thread: string }>(
          "SELECT board,thread FROM cursors WHERE uid=?",
          uid,
        )) {
          if (cursor.board !== settings.url || !watched.includes(cursor.thread))
            db.run(
              "DELETE FROM cursors WHERE uid=? AND board=? AND thread=?",
              uid,
              cursor.board,
              cursor.thread,
            );
        }
        for (const state of db.all<{ board: string; resource: string }>(
          "SELECT board,resource FROM fetch_state WHERE uid=?",
          uid,
        )) {
          if (
            state.board !== settings.url ||
            state.resource === "subject.txt" ||
            !watched.includes(state.resource.slice(4, -4)) ||
            !current?.active
          )
            db.run(
              "DELETE FROM fetch_state WHERE uid=? AND board=? AND resource=?",
              uid,
              state.board,
              state.resource,
            );
        }
        if (current && !current.active)
          db.run("UPDATE cursors SET baseline=1 WHERE uid=?", uid);
      }
    }
    return view(
      db,
      db.get<Subscription>("SELECT * FROM subscriptions WHERE uid=?", uid),
    );
  });
}
