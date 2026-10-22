import type { Store } from "./store";
import type { Payload } from "./monitor";
export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = true,
    readonly retryAfter = 0,
  ) {
    super("Push delivery failed.");
  }
}
export type Sender = (
  token: string,
  payload: Payload,
  timeout: number,
) => Promise<void>;
interface Queued {
  id: string;
  uid: string;
  revision: number;
  expires: number;
  payload: string;
  attempts: number;
  token: string;
  active: number;
  generation: string;
  current_revision: number;
}
export function retryDelay(
  attempt: number,
  random: () => number = Math.random,
  retryAfter = 0,
): number {
  return (
    Math.max(
      Math.min(900, 60 * 2 ** Math.min(4, Math.max(0, attempt - 1))) +
        Math.floor(random() * 16),
      retryAfter,
    ) * 1000
  );
}
export async function deliver(
  db: Store,
  send: Sender,
  options: { now?: number; budget?: number; random?: () => number } = {},
) {
  const started = performance.now();
  const now = options.now ?? Date.now();
  const clock = () => now + Math.floor(performance.now() - started);
  const budget = Math.max(0, options.budget ?? 15000);
  const stats = {
    sent: 0,
    retried: 0,
    discarded: 0,
    invalidEndpoints: 0,
    deferred: false,
  };
  db.prune(now);
  db.run("DELETE FROM outbox WHERE attempts>=5");
  for (const { id } of db.all<{ id: string }>(
    "SELECT id FROM outbox WHERE next_attempt<=? ORDER BY expires,next_attempt,id LIMIT 100",
    now,
  )) {
    if (performance.now() - started >= budget - 100) {
      stats.deferred = true;
      break;
    }
    const at = clock();
    const row = db.transaction(() => {
      const queued = db.get<Queued>(
        "SELECT o.*,s.token,s.active,s.generation,s.revision AS current_revision FROM outbox o JOIN subscriptions s ON s.uid=o.uid WHERE o.id=? AND next_attempt<=?",
        id,
        at,
      );
      if (!queued) return;
      if (
        !queued.active ||
        queued.revision !== queued.current_revision ||
        queued.expires <= at
      ) {
        db.run("DELETE FROM outbox WHERE id=?", id);
        stats.discarded++;
        return;
      }
      const attempt = queued.attempts + 1;
      db.run(
        "UPDATE outbox SET attempts=?,next_attempt=? WHERE id=?",
        attempt,
        at + retryDelay(attempt, options.random),
        id,
      );
      db.run(
        "INSERT INTO delivery_state(uid,attempted) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET attempted=excluded.attempted",
        queued.uid,
        at,
      );
      return queued;
    });
    if (!row) continue;
    const attempt = row.attempts + 1;
    let failure: DeliveryError | null = null;
    try {
      const payload = JSON.parse(row.payload) as Payload;
      if (
        payload.eventId !== id ||
        payload.revision !== row.revision ||
        payload.expiresAt !== Math.floor(row.expires / 1000)
      )
        throw new DeliveryError("invalid_payload", false);
      await send(
        row.token,
        { ...payload, generation: row.generation },
        Math.min(
          5000,
          Math.max(1, Math.floor(budget - (performance.now() - started))),
        ),
      );
    } catch (error) {
      failure =
        error instanceof DeliveryError
          ? error
          : new DeliveryError("delivery_unavailable");
    }
    db.transaction(() => {
      if (
        !db.get(
          "SELECT 1 FROM subscriptions WHERE uid=? AND revision=? AND token=? AND active=1",
          row.uid,
          row.revision,
          row.token,
        )
      )
        return;
      if (failure?.code === "invalid_endpoint") {
        db.run(
          "UPDATE subscriptions SET active=0,confirmed=0,challenge_hash=NULL WHERE uid=?",
          row.uid,
        );
        db.run("DELETE FROM outbox WHERE uid=?", row.uid);
        stats.invalidEndpoints++;
        return;
      }
      const next =
        clock() + retryDelay(attempt, options.random, failure?.retryAfter);
      if (
        !failure ||
        !failure.retryable ||
        attempt >= 5 ||
        next >= row.expires
      ) {
        db.run(
          "DELETE FROM outbox WHERE id=? AND revision=?",
          id,
          row.revision,
        );
        stats[failure ? "discarded" : "sent"]++;
      } else {
        db.run(
          "UPDATE outbox SET next_attempt=? WHERE id=? AND revision=?",
          next,
          id,
          row.revision,
        );
        stats.retried++;
      }
      db.run(
        "UPDATE delivery_state SET error=?,succeeded=CASE WHEN ? IS NULL THEN ? ELSE succeeded END WHERE uid=?",
        failure?.code ?? null,
        failure?.code ?? null,
        clock(),
        row.uid,
      );
    });
  }
  return stats;
}
