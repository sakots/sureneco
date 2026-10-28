import { createHash } from "node:crypto";
import type { Post, Recruitment, Thread } from "../src/core/types";
import { Store } from "./store";
import type { MobileSettings, Subscription } from "./subscriptions";
import { runDetection } from "./detection";
import { fetchBoard } from "./http";
export interface Payload {
  eventId: string;
  generation?: string;
  revision: number;
  boardUrl: string;
  threadId: string;
  threadTitle: string;
  recruitment: Recruitment;
  expiresAt: number;
}
interface FetchState {
  resource: string;
  attempted: number;
  threads: string | null;
}
export const eventId = (
  uid: string,
  board: string,
  thread: string,
  number: number,
) =>
  createHash("sha256")
    .update(JSON.stringify([uid, board, thread, number]))
    .digest("hex");
export async function monitor(
  db: Store,
  options: { now?: number; budget?: number; fetcher?: typeof fetchBoard } = {},
) {
  const now = options.now ?? Date.now();
  const deadline = performance.now() + Math.min(35000, options.budget ?? 35000);
  const fetcher = options.fetcher ?? fetchBoard;
  const cache = new Map<
    string,
    { text?: string; posts?: Post[]; error?: unknown }
  >();
  const stats = { fetched: 0, processed: 0, errors: 0, deferred: false };
  db.prune(now);
  const subscriptions = db.all<Subscription>(
    "SELECT s.* FROM subscriptions s WHERE active=1 ORDER BY COALESCE((SELECT MAX(attempted) FROM fetch_state f WHERE f.uid=s.uid),0),s.uid",
  );
  for (const subscription of subscriptions) {
    const settings = JSON.parse(subscription.settings) as MobileSettings;
    const watched = JSON.parse(subscription.watched) as string[];
    const board = settings.url;
    const states = new Map(
      db
        .all<FetchState>(
          "SELECT * FROM fetch_state WHERE uid=? AND board=?",
          subscription.uid,
          board,
        )
        .map((state) => [state.resource, state]),
    );
    let threads: Thread[] = JSON.parse(
      states.get("subject.txt")?.threads ?? "[]",
    );
    const resources = [
      "subject.txt",
      ...watched.map((id) => `dat/${id}.dat`),
    ].sort(
      (a, b) =>
        (states.get(a)?.attempted ?? 0) - (states.get(b)?.attempted ?? 0) ||
        Number(b === "subject.txt") - Number(a === "subject.txt"),
    );
    for (const resource of resources) {
      const thread = resource === "subject.txt" ? null : resource.slice(4, -4);
      const interval =
        (thread ? settings.update_sec : settings.thread_update_sec) * 1000;
      if (now - (states.get(resource)?.attempted ?? -Infinity) < interval)
        continue;
      const remaining = Math.floor(deadline - performance.now()) - 2200;
      if (remaining <= 0) {
        stats.deferred = true;
        return stats;
      }
      const url = board + resource;
      let nextThreads: Thread[] | null = null;
      let lastPost: number | null = null;
      let detected: {
        notifications: Recruitment[];
        closedPrevious: number[];
      } | null = null;
      let code: string | null = null;
      try {
        if (!cache.has(url)) {
          stats.fetched++;
          try {
            cache.set(url, {
              text: await fetcher(url, Math.min(15000, remaining)),
            });
          } catch (error) {
            cache.set(url, { error });
          }
        }
        const cached = cache.get(url)!;
        if (cached.error) throw cached.error;
        if (!thread) {
          nextThreads = await runDetection<Thread[]>({
            operation: "subject",
            subject: cached.text,
            settings,
            watched,
            now,
          });
        } else {
          if (!cached.posts) {
            try {
              cached.posts = await runDetection<Post[]>({
                operation: "dat",
                dat: cached.text,
              });
              cached.text = undefined;
            } catch (error) {
              cached.error = error;
              throw error;
            }
          }
          const posts = cached.posts;
          const cursor = db.get<{ last_post: number; baseline: number }>(
            "SELECT last_post,baseline FROM cursors WHERE uid=? AND board=? AND thread=?",
            subscription.uid,
            board,
            thread,
          );
          lastPost = posts.length;
          if (cursor && !cursor.baseline) {
            if (performance.now() > deadline - 1100) {
              stats.deferred = true;
              return stats;
            }
            const previous = db
              .all<{ payload: string }>(
                "SELECT payload FROM outbox WHERE uid=? AND revision=?",
                subscription.uid,
                subscription.revision,
              )
              .map((row) => JSON.parse(row.payload) as Payload)
              .filter((x) => x.threadId === thread && x.boardUrl === board)
              .map((x) => x.recruitment);
            detected = await runDetection({
              operation: "scan",
              threadId: thread,
              posts: posts.filter((x) => x.number > cursor.last_post),
              sourcePosts: posts,
              previous,
              settings,
              now,
              trackPending: true,
            });
          }
        }
      } catch (error) {
        code =
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "fetch_failed";
        nextThreads = null;
        lastPost = null;
        detected = null;
      }
      const committed = db.transaction(() => {
        const current = db.get<Subscription>(
          "SELECT * FROM subscriptions WHERE uid=?",
          subscription.uid,
        );
        if (!current?.active || current.revision !== subscription.revision)
          return false;
        db.run(
          "INSERT INTO fetch_state(uid,board,resource,attempted,succeeded,threads,error) VALUES(?,?,?,?,?,?,?) ON CONFLICT(uid,board,resource) DO UPDATE SET attempted=excluded.attempted,succeeded=COALESCE(excluded.succeeded,succeeded),threads=COALESCE(excluded.threads,threads),error=excluded.error",
          subscription.uid,
          board,
          resource,
          now,
          code ? null : now,
          nextThreads ? JSON.stringify(nextThreads) : null,
          code,
        );
        if (thread && lastPost !== null) {
          db.run(
            "INSERT INTO cursors(uid,board,thread,last_post,baseline) VALUES(?,?,?,?,0) ON CONFLICT(uid,board,thread) DO UPDATE SET last_post=MAX(last_post,excluded.last_post),baseline=0",
            subscription.uid,
            board,
            thread,
            lastPost,
          );
          if (detected) {
            for (const number of detected.closedPrevious)
              db.run(
                "DELETE FROM outbox WHERE id=?",
                eventId(subscription.uid, board, thread, number),
              );
            for (const item of detected.notifications) {
              const expires =
                item.effectivePostedAt + settings.emphasis_sec * 1000;
              if (expires <= now) continue;
              const id = eventId(subscription.uid, board, thread, item.number);
              const event = db.run(
                "INSERT OR IGNORE INTO events(id,uid,expires) VALUES(?,?,?)",
                id,
                subscription.uid,
                expires,
              );
              if (!Number(event.changes)) continue;
              const payload: Payload = {
                eventId: id,
                revision: subscription.revision,
                boardUrl: board,
                threadId: thread,
                threadTitle:
                  threads.find((x) => x.id === thread)?.title ?? thread,
                recruitment: item,
                expiresAt: Math.floor(expires / 1000),
              };
              db.run(
                "INSERT INTO outbox(id,uid,revision,expires,payload,created) VALUES(?,?,?,?,?,?)",
                id,
                subscription.uid,
                subscription.revision,
                expires,
                JSON.stringify(payload),
                now,
              );
            }
          }
        }
        return true;
      });
      if (!committed) break;
      if (code) stats.errors++;
      else {
        stats.processed++;
        if (nextThreads) threads = nextThreads;
      }
    }
  }
  return stats;
}
