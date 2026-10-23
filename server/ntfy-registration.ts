import { createNtfyCredentials } from "./ntfy-admin";
import type { Store } from "./store";

export interface NtfyAdminPort {
  ensureAccount(uid: string, password: string): Promise<void>;
  grantRead(uid: string, topic: string): Promise<void>;
  revokeRead(uid: string, topic: string): Promise<void>;
  removeAccount(uid: string): Promise<void>;
}
export interface NtfyRegistrationView {
  topic: string;
  username: string;
  password: string;
  state: "pending" | "ready" | "stopped";
  error: string | null;
}
interface Registration extends NtfyRegistrationView {
  uid: string;
  desired: number;
  generation: number;
  removed: number;
  account_ready: number;
  account_may_exist: number;
}
interface Job {
  uid: string;
  generation: number;
  operation: "reconcile" | "ensure" | "grant" | "revoke" | "remove";
  topic: string | null;
  attempts: number;
  next_attempt: number;
}
const running = new WeakSet<Store>();

function view(row: Registration): NtfyRegistrationView {
  return {
    topic: row.topic,
    username: row.username,
    password: row.password,
    state: row.state,
    error: row.error,
  };
}
function endpointTopic(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.search && url.search !== "?up=1") ||
      url.href !== endpoint ||
      !/^\/up[A-Za-z0-9_-]{1,62}$/.test(url.pathname)
    )
      return null;
    return url.pathname.slice(1);
  } catch {
    return null;
  }
}

/** Legacy devices retain their existing ownership challenge until they opt in. */
export function ntfyDeliveryAllowed(
  db: Store,
  uid: string,
  endpoint: string,
): boolean {
  const row = db.get<Pick<Registration, "topic" | "state" | "removed">>(
    "SELECT topic,state,removed FROM ntfy_registrations WHERE uid=?",
    uid,
  );
  return (
    !row ||
    (!row.removed &&
      row.state === "ready" &&
      endpointTopic(endpoint) === row.topic)
  );
}

export class NtfyRegistration {
  constructor(
    private readonly db: Store,
    private readonly admin: NtfyAdminPort,
  ) {}

  private owned(uid: string): Registration | undefined {
    if (!this.db.get("SELECT uid FROM devices WHERE uid=?", uid))
      throw new Error("unauthorized");
    const row = this.db.get<Registration>(
      "SELECT * FROM ntfy_registrations WHERE uid=?",
      uid,
    );
    if (row?.removed) throw new Error("unauthorized");
    return row;
  }

  get(uid: string): NtfyRegistrationView | null {
    const row = this.owned(uid);
    return row ? view(row) : null;
  }

  put(uid: string, topic: string): NtfyRegistrationView {
    return this.db.transaction(() => {
      const current = this.owned(uid);
      if (typeof topic !== "string" || !/^up[A-Za-z0-9_-]{1,62}$/.test(topic))
        throw new Error("invalid_ntfy_topic");
      if (
        this.db.get(
          "SELECT uid FROM ntfy_topics WHERE topic=? AND uid<>?",
          topic,
          uid,
        ) ||
        this.db
          .all<{ endpoint: string }>(
            "SELECT endpoint FROM subscriptions WHERE uid<>?",
            uid,
          )
          .some((row) => endpointTopic(row.endpoint) === topic)
      )
        throw new Error("topic_conflict");
      if (current?.desired && current.topic === topic) return view(current);
      if (current) {
        this.db.run(
          "UPDATE ntfy_registrations SET topic=?,desired=1,generation=generation+1,state='pending',error=NULL,account_may_exist=1 WHERE uid=?",
          topic,
          uid,
        );
      } else {
        const credentials = createNtfyCredentials(uid);
        this.db.run(
          "INSERT INTO ntfy_registrations(uid,username,password,topic) VALUES(?,?,?,?)",
          uid,
          credentials.username,
          credentials.password,
          topic,
        );
      }
      this.db.run(
        "INSERT OR IGNORE INTO ntfy_topics(topic,uid) VALUES(?,?)",
        topic,
        uid,
      );
      this.schedule(uid);
      return view(
        this.db.get<Registration>(
          "SELECT * FROM ntfy_registrations WHERE uid=?",
          uid,
        )!,
      );
    });
  }

  stop(uid: string): NtfyRegistrationView | null {
    return this.db.transaction(() => {
      const current = this.owned(uid);
      if (!current) return null;
      if (!current.desired) return view(current);
      this.db.run(
        "UPDATE ntfy_registrations SET desired=0,generation=generation+1,state='pending',error=NULL WHERE uid=?",
        uid,
      );
      this.schedule(uid);
      return view(
        this.db.get<Registration>(
          "SELECT * FROM ntfy_registrations WHERE uid=?",
          uid,
        )!,
      );
    });
  }

  /** Call before deleting devices; no provisioning table cascades from devices. */
  removeDevice(uid: string): NtfyRegistrationView | null {
    return this.db.transaction(() => {
      const current = this.owned(uid);
      if (!current) return null;
      this.db.run(
        "UPDATE ntfy_registrations SET desired=0,removed=1,generation=generation+1,state='pending',error=NULL WHERE uid=?",
        uid,
      );
      this.schedule(uid);
      return view(
        this.db.get<Registration>(
          "SELECT * FROM ntfy_registrations WHERE uid=?",
          uid,
        )!,
      );
    });
  }

  private schedule(uid: string) {
    // Do not overwrite an in-flight operation: its durable intent records which
    // account/ACL may already have changed, even if the caller never got a reply.
    this.db.run(
      "INSERT INTO ntfy_jobs(uid,generation) SELECT uid,generation FROM ntfy_registrations WHERE uid=? ON CONFLICT(uid) DO UPDATE SET next_attempt=0,attempts=0",
      uid,
    );
  }

  async tick(now = Date.now()): Promise<void> {
    if (running.has(this.db)) return;
    running.add(this.db);
    try {
      const jobs = this.db.all<{ uid: string }>(
        "SELECT uid FROM ntfy_jobs WHERE next_attempt<=? ORDER BY next_attempt,uid",
        now,
      );
      for (const { uid } of jobs) await this.reconcile(uid, now);
    } finally {
      running.delete(this.db);
    }
  }

  private async reconcile(uid: string, now: number): Promise<void> {
    for (;;) {
      const scheduled = this.db.get<Job>(
        "SELECT * FROM ntfy_jobs WHERE uid=?",
        uid,
      );
      if (!scheduled) return;
      const current = this.db.get<Registration>(
        "SELECT * FROM ntfy_registrations WHERE uid=?",
        uid,
      )!;
      if (
        scheduled.operation === "remove" &&
        scheduled.generation !== current.generation
      ) {
        // An interrupted deletion may already have removed the account. Finish
        // that idempotent operation before attempting any revoke or recreation.
        this.db.run(
          "UPDATE ntfy_jobs SET generation=?,attempts=0,next_attempt=0 WHERE uid=?",
          current.generation,
          uid,
        );
        scheduled.generation = current.generation;
        scheduled.attempts = 0;
      }
      const job =
        scheduled.operation === "reconcile" ||
        scheduled.generation !== current.generation
          ? this.db.transaction(() => this.plan(current))
          : scheduled;
      if (!job) return;
      try {
        switch (job.operation) {
          case "ensure":
            await this.admin.ensureAccount(uid, current.password);
            break;
          case "grant":
            await this.admin.grantRead(uid, job.topic!);
            break;
          case "revoke":
            await this.admin.revokeRead(uid, job.topic!);
            break;
          case "remove":
            await this.admin.removeAccount(uid);
            break;
        }
      } catch {
        const desired = this.db.get<Registration>(
          "SELECT * FROM ntfy_registrations WHERE uid=?",
          uid,
        )!;
        if (desired.generation !== job.generation) {
          this.db.run(
            "UPDATE ntfy_jobs SET generation=?,operation=?,topic=NULL,attempts=0,next_attempt=0 WHERE uid=?",
            desired.generation,
            job.operation === "remove" ? "remove" : "reconcile",
            uid,
          );
          continue;
        }
        const attempts = job.attempts + 1;
        const delay = Math.min(300000, 1000 * 2 ** Math.min(attempts - 1, 9));
        this.db.transaction(() => {
          this.db.run(
            "UPDATE ntfy_jobs SET attempts=?,next_attempt=? WHERE uid=?",
            attempts,
            now + delay,
            uid,
          );
          this.db.run(
            "UPDATE ntfy_registrations SET state='pending',error='ntfy_admin_failed' WHERE uid=?",
            uid,
          );
        });
        return;
      }
      this.db.transaction(() => {
        switch (job.operation) {
          case "ensure":
            this.db.run(
              "UPDATE ntfy_registrations SET account_ready=1 WHERE uid=?",
              uid,
            );
            break;
          case "grant":
            this.db.run(
              "UPDATE ntfy_topics SET granted=1,applied_generation=? WHERE uid=? AND topic=?",
              job.generation,
              uid,
              job.topic,
            );
            break;
          case "revoke":
            this.db.run(
              "UPDATE ntfy_topics SET granted=0,applied_generation=NULL WHERE uid=? AND topic=?",
              uid,
              job.topic,
            );
            break;
          case "remove":
            this.db.run(
              "UPDATE ntfy_registrations SET account_ready=0,account_may_exist=0 WHERE uid=?",
              uid,
            );
            this.db.run(
              "UPDATE ntfy_topics SET granted=0,applied_generation=NULL WHERE uid=?",
              uid,
            );
            break;
        }
        this.db.run(
          "UPDATE ntfy_jobs SET operation='reconcile',topic=NULL,attempts=0,next_attempt=0 WHERE uid=?",
          uid,
        );
      });
    }
  }

  private plan(current: Registration): Job | undefined {
    const uid = current.uid;
    let operation: Job["operation"];
    let topic: string | null = null;
    if (!current.desired) {
      if (
        current.account_may_exist ||
        this.db.get(
          "SELECT topic FROM ntfy_topics WHERE uid=? AND granted=1 LIMIT 1",
          uid,
        )
      ) {
        operation = "remove";
        // Deletion may succeed even when its reply fails. A concurrent resume
        // must recreate the account rather than trust the old readiness flag.
        this.db.run(
          "UPDATE ntfy_registrations SET account_ready=0 WHERE uid=?",
          uid,
        );
      } else {
        this.db.run("DELETE FROM ntfy_topics WHERE uid=?", uid);
        this.db.run("DELETE FROM ntfy_jobs WHERE uid=?", uid);
        if (current.removed) {
          // The device is gone and external cleanup is acknowledged. Do not
          // retain its plaintext password in a permanent tombstone.
          this.db.run("DELETE FROM ntfy_registrations WHERE uid=?", uid);
        } else {
          this.db.run(
            "UPDATE ntfy_registrations SET state='stopped',error=NULL WHERE uid=?",
            uid,
          );
        }
        return;
      }
    } else {
      this.db.run(
        "DELETE FROM ntfy_topics WHERE uid=? AND topic<>? AND granted=0",
        uid,
        current.topic,
      );
      const previous = this.db.get<{ topic: string }>(
        "SELECT topic FROM ntfy_topics WHERE uid=? AND topic<>? AND granted=1 ORDER BY topic LIMIT 1",
        uid,
        current.topic,
      );
      if (previous) {
        operation = "revoke";
        topic = previous.topic;
      } else if (!current.account_ready) {
        operation = "ensure";
        this.db.run(
          "UPDATE ntfy_registrations SET account_may_exist=1 WHERE uid=?",
          uid,
        );
      } else {
        const desired = this.db.get<{
          granted: number;
          applied_generation: number | null;
        }>(
          "SELECT granted,applied_generation FROM ntfy_topics WHERE uid=? AND topic=?",
          uid,
          current.topic,
        )!;
        if (
          desired.granted &&
          desired.applied_generation === current.generation
        ) {
          this.db.run(
            "UPDATE ntfy_registrations SET state='ready',error=NULL WHERE uid=?",
            uid,
          );
          this.db.run("DELETE FROM ntfy_jobs WHERE uid=?", uid);
          return;
        }
        operation = "grant";
        topic = current.topic;
        // Persist a possible external effect BEFORE invoking the administrator.
        // A failed reply or crash must still require revocation/deletion.
        this.db.run(
          "UPDATE ntfy_topics SET granted=1,applied_generation=NULL WHERE uid=? AND topic=?",
          uid,
          topic,
        );
      }
    }
    this.db.run(
      "UPDATE ntfy_jobs SET generation=?,operation=?,topic=?,attempts=0,next_attempt=0 WHERE uid=?",
      current.generation,
      operation,
      topic,
      uid,
    );
    return this.db.get<Job>("SELECT * FROM ntfy_jobs WHERE uid=?", uid);
  }
}
