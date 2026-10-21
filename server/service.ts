import { createServer } from "node:http";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";

interface ServerOptions {
  databasePath: string;
  port?: number;
  host?: string;
}

export async function startServer({
  databasePath,
  port = 8787,
  host = "127.0.0.1",
}: ServerOptions) {
  if (host !== "127.0.0.1") {
    throw new Error("ローカル基盤はループバック127.0.0.1でのみ起動できます");
  }
  if (databasePath === ":memory:") {
    throw new Error("永続SQLiteファイルを指定してください");
  }
  const path = resolve(databasePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  let lock: DatabaseSync | undefined;
  const http = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/healthz") {
      response.writeHead(404).end();
      return;
    }
    const state = database
      .prepare("SELECT last_tick_at FROM worker_state WHERE id = 1")
      .get()!;
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      JSON.stringify({
        lastTickAt: state.last_tick_at,
        monitoringReady: false,
      }),
    );
  });
  let timer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;

  function close() {
    closing ??= (async () => {
      closed = true;
      clearInterval(timer);
      try {
        if (http.listening) {
          const stopped = once(http, "close");
          http.close();
          await stopped;
        }
      } finally {
        try {
          database.close();
        } finally {
          lock?.close();
        }
      }
    })();
    return closing;
  }

  function tick() {
    if (closed) throw new Error("サーバーは停止しています");
    database
      .prepare("UPDATE worker_state SET last_tick_at = ? WHERE id = 1")
      .run(Date.now());
  }

  try {
    // Use a separate database so ownership does not block state transactions.
    // Resolve symlinks before naming it; never unlink a live SQLite lock file.
    lock = new DatabaseSync(`${await realpath(path)}.worker-lock`);
    try {
      lock.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      if (error instanceof Error && "errcode" in error && error.errcode === 5) {
        throw new Error("このDBのワーカーは既に起動しています");
      }
      throw error;
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS worker_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_tick_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO worker_state (id, last_tick_at) VALUES (1, 0);
    `);
    const listening = once(http, "listening");
    http.listen(port, host);
    await listening;
    timer = setInterval(tick, 20_000);
    const address = http.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP待受ポートを取得できません");
    }
    return { url: `http://${host}:${address.port}`, tick, close };
  } catch (error) {
    await close();
    throw error;
  }
}
