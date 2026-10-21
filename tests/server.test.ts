import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../server/service";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "sureneco-server-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "monitor.sqlite");
}

it("APIとワーカーを起動し、再起動後も最終実行時刻を保持する", async () => {
  const path = await databasePath();
  const first = await startServer({ databasePath: path, port: 0 });
  cleanup.push(() => first.close());
  await first.tick();
  const health = await fetch(`${first.url}/healthz`).then((r) => r.json());
  expect(health.lastTickAt).toBeGreaterThan(0);
  expect(health.monitoringReady).toBe(false);
  expect(await fetch(`${first.url}/unknown`).then((r) => r.status)).toBe(404);
  await first.close();
  const second = await startServer({ databasePath: path, port: 0 });
  cleanup.push(() => second.close());
  expect(await fetch(`${second.url}/healthz`).then((r) => r.json())).toEqual(health);
});

it("同じDBを使う二つ目のワーカーを拒否し、停止後は起動できる", async () => {
  const path = await databasePath();
  const first = await startServer({ databasePath: path, port: 0 });
  cleanup.push(() => first.close());
  await expect(startServer({ databasePath: path, port: 0 })).rejects.toThrow(
    "このDBのワーカーは既に起動しています",
  );
  await first.close();
  const next = await startServer({ databasePath: path, port: 0 });
  cleanup.push(() => next.close());
});

it("公開アドレスへの直接バインドを拒否する", async () => {
  const path = await databasePath();
  await expect(
    startServer({ databasePath: path, port: 0, host: "0.0.0.0" }),
  ).rejects.toThrow("ループバック");
});
