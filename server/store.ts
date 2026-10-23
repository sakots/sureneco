import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, realpathSync, existsSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";

export class Store {
  readonly path: string;
  private db!: DatabaseSync;
  private owner!: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    if (!path || path === ":memory:")
      throw new Error("Persistent database required.");
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    this.path = existsSync(absolute)
      ? realpathSync(absolute)
      : resolve(realpathSync(dirname(absolute)), basename(absolute));
    const mask = process.umask(0o077);
    try {
      // A dedicated SQLite connection holds an OS-backed lock for the lifetime of
      // this service. The fixed sidecar survives, but its lock cannot become stale.
      this.owner = new DatabaseSync(this.path + ".owner.sqlite");
      this.owner.exec(
        "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER)",
      );
      this.db = new DatabaseSync(this.path);
      this.db.exec(`
        PRAGMA foreign_keys=ON;
        PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS devices (uid TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS subscriptions (
          uid TEXT PRIMARY KEY REFERENCES devices(uid) ON DELETE CASCADE, revision INTEGER NOT NULL, active INTEGER NOT NULL,
          settings TEXT NOT NULL, watched TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
          endpoint TEXT NOT NULL UNIQUE, generation TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
          challenge_hash TEXT, challenge_expires INTEGER NOT NULL DEFAULT 0, challenge_sent INTEGER NOT NULL DEFAULT 0,
          consented INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cursors (
          uid TEXT NOT NULL REFERENCES subscriptions(uid) ON DELETE CASCADE,
          board TEXT NOT NULL, thread TEXT NOT NULL, last_post INTEGER NOT NULL,
          baseline INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(uid,board,thread)
        );
        CREATE TABLE IF NOT EXISTS fetch_state (
          uid TEXT NOT NULL REFERENCES subscriptions(uid) ON DELETE CASCADE,
          board TEXT NOT NULL, resource TEXT NOT NULL, attempted INTEGER NOT NULL,
          succeeded INTEGER, threads TEXT, error TEXT, PRIMARY KEY(uid,board,resource)
        );
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES subscriptions(uid) ON DELETE CASCADE,
          expires INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_expiry ON events(expires);
        CREATE TABLE IF NOT EXISTS outbox (
          id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
          uid TEXT NOT NULL REFERENCES subscriptions(uid) ON DELETE CASCADE,
          revision INTEGER NOT NULL, expires INTEGER NOT NULL, payload TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
          created INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS outbox_owner ON outbox(uid);
        CREATE TABLE IF NOT EXISTS delivery_state (
          uid TEXT PRIMARY KEY REFERENCES subscriptions(uid) ON DELETE CASCADE,
          attempted INTEGER NOT NULL, succeeded INTEGER, error TEXT
        );
        -- Provisioning survives device deletion until external account cleanup.
        CREATE TABLE IF NOT EXISTS ntfy_registrations (
          uid TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
          topic TEXT NOT NULL, desired INTEGER NOT NULL DEFAULT 1,
          generation INTEGER NOT NULL DEFAULT 1, removed INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'pending', error TEXT,
          account_ready INTEGER NOT NULL DEFAULT 0, account_may_exist INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS ntfy_topics (
          topic TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES ntfy_registrations(uid),
          granted INTEGER NOT NULL DEFAULT 0, applied_generation INTEGER
        );
        CREATE INDEX IF NOT EXISTS ntfy_topics_owner ON ntfy_topics(uid);
        CREATE TABLE IF NOT EXISTS ntfy_jobs (
          uid TEXT PRIMARY KEY REFERENCES ntfy_registrations(uid),
          generation INTEGER NOT NULL, operation TEXT NOT NULL DEFAULT 'reconcile',
          topic TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ntfy_jobs_due ON ntfy_jobs(next_attempt);
        CREATE TABLE IF NOT EXISTS rates (identity TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS service_state (id INTEGER PRIMARY KEY, started INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0, error TEXT);
        INSERT OR IGNORE INTO service_state(id) VALUES(1);
      `);
      if (
        !this.all<{ name: string }>("PRAGMA table_info(subscriptions)").some(
          (column) => column.name === "endpoint",
        )
      )
        throw new Error("Unsupported draft schema.");
    } catch {
      this.db?.close();
      this.owner?.close();
      throw new Error("Database unavailable or already owned.");
    } finally {
      process.umask(mask);
    }
  }
  get<T = Record<string, unknown>>(
    sql: string,
    ...args: SQLInputValue[]
  ): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T = Record<string, unknown>>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  prune(now: number) {
    this.run("DELETE FROM events WHERE expires<=?", now);
    this.run("DELETE FROM rates WHERE expires<=?", now);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.owner.close();
    }
  }
}
