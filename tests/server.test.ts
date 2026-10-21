import { afterEach, expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "sureneco-php-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "monitor.sqlite");
}

function php(args: string[], database: string) {
  return execute("php", args, {
    cwd: root,
    env: { ...process.env, SURENECO_SERVER_DB: database },
    timeout: 5_000,
  });
}

async function cron(database: string) {
  const result = await php(["server/cron.php"], database);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

async function startPhp(
  args: string[],
  database: string,
  ready: "stdout" | "stderr",
  pattern: RegExp,
) {
  const child = spawn("php", args, {
    cwd: root,
    env: { ...process.env, SURENECO_SERVER_DB: database },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
  };
  cleanup.push(close);
  let output = "";
  const signal = AbortSignal.timeout(5_000);
  while (!pattern.test(output)) {
    const [chunk] = await Promise.race([
      once(child[ready], "data", { signal }),
      exited.then(() => {
        throw new Error(`PHP exited before readiness: ${output}`);
      }),
    ]);
    output += chunk.toString();
  }
  return { child, close };
}

async function httpServer(database: string) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (address === null || typeof address === "string") {
    throw new Error("Missing loopback port");
  }
  const closed = once(reservation, "close");
  reservation.close();
  await closed;
  const url = `http://127.0.0.1:${address.port}`;
  const process = await startPhp(
    [
      "-S",
      `127.0.0.1:${address.port}`,
      "-t",
      "server/public",
      "server/public/index.php",
    ],
    database,
    "stderr",
    /Development Server .* started/,
  );
  return { ...process, url };
}

async function health(url: string) {
  const response = await fetch(`${url}/healthz`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  return response.json();
}

async function lockOwner(database: string) {
  return startPhp(
    [
      "-r",
      `require 'server/bootstrap.php';
       Sureneco\\openDatabase();
       $lock = fopen(realpath(getenv('SURENECO_SERVER_DB')) . '.worker-lock', 'c');
       if (!flock($lock, LOCK_EX | LOCK_NB)) { exit(1); }
       echo "locked\\n";
       fflush(STDOUT);
       fgets(STDIN);`,
    ],
    database,
    "stdout",
    /locked\n/,
  );
}

it("PHP APIは初回前をゼロで返し、単発cron間とAPI再起動後も実行時刻を保持する", async () => {
  const database = await databasePath();
  const first = await httpServer(database);
  expect(await health(first.url)).toEqual({
    lastStartedAt: 0,
    lastFinishedAt: 0,
    monitoringReady: false,
  });

  const before = Date.now();
  expect(await cron(database)).toEqual({
    status: "completed",
    monitoringReady: false,
  });
  const initial = await health(first.url);
  expect(Number.isInteger(initial.lastStartedAt)).toBe(true);
  expect(Number.isInteger(initial.lastFinishedAt)).toBe(true);
  expect(initial.lastStartedAt).toBeGreaterThanOrEqual(before);
  expect(initial.lastFinishedAt).toBeGreaterThanOrEqual(initial.lastStartedAt);
  expect(initial.lastFinishedAt).toBeLessThanOrEqual(Date.now());
  expect(initial.monitoringReady).toBe(false);

  await first.close();
  const second = await httpServer(database);
  expect(await health(second.url)).toEqual(initial);
  expect(await cron(database)).toEqual({
    status: "completed",
    monitoringReady: false,
  });
  const next = await health(second.url);
  expect(next.lastStartedAt).toBeGreaterThanOrEqual(initial.lastFinishedAt);
  expect(next.lastFinishedAt).toBeGreaterThanOrEqual(next.lastStartedAt);
  expect(next.monitoringReady).toBe(false);
});

it("同じDBの重複cronはシンボリックリンク経由でもスキップし、時刻を変更しない", async () => {
  const database = await databasePath();
  await cron(database);
  const api = await httpServer(database);
  const initial = await health(api.url);
  const alias = join(dirname(database), "alias.sqlite");
  await symlink(database, alias);
  const owner = await lockOwner(database);

  expect(await cron(alias)).toEqual({
    status: "skipped",
    monitoringReady: false,
  });
  expect(await health(api.url)).toEqual(initial);
  await owner.close();
});

it("ロック所有プロセスの強制終了後は次の単発cronが完了する", async () => {
  const database = await databasePath();
  await cron(database);
  const owner = await lockOwner(database);
  expect(await cron(database)).toEqual({
    status: "skipped",
    monitoringReady: false,
  });
  await owner.close();
  expect(owner.child.signalCode).toBe("SIGKILL");

  const before = Date.now();
  expect(await cron(database)).toEqual({
    status: "completed",
    monitoringReady: false,
  });
  const api = await httpServer(database);
  const state = await health(api.url);
  expect(state.lastStartedAt).toBeGreaterThanOrEqual(before);
  expect(state.lastFinishedAt).toBeGreaterThanOrEqual(state.lastStartedAt);
});

it("DB保存先が不正でも破損SQLiteでもHTTP待受なしのcronが非ゼロ終了する", async () => {
  const database = await databasePath();
  const parentFile = join(dirname(database), "not-a-directory");
  await writeFile(parentFile, "file");
  await expect(
    php(["server/cron.php"], join(parentFile, "monitor.sqlite")),
  ).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: "Worker execution failed.\n",
  });

  await writeFile(database, "not a SQLite database");
  await expect(php(["server/cron.php"], database)).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: "Worker execution failed.\n",
  });
});

it("公開ルートはGET healthzだけを公開し、cron・DB・購読APIを公開しない", async () => {
  const database = await databasePath();
  const api = await httpServer(database);
  const initial = await health(api.url);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    const response = await fetch(`${api.url}/healthz`, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  }
  for (const path of [
    "/",
    "/unknown",
    "/cron.php",
    "/bootstrap.php",
    "/data/monitor.sqlite",
    "/subscriptions",
  ]) {
    expect((await fetch(`${api.url}${path}`)).status).toBe(404);
  }
  expect(await health(api.url)).toEqual(initial);
});
