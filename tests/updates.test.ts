import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { UpdateManager, updateMode } from "../src/main/updates";

function setup(mode: "auto" | "manual" | "disabled" = "auto") {
  const engine = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  const notify = vi.fn();
  const manager = new UpdateManager(engine, "0.2.0", mode, notify);
  return { engine, notify, manager };
}
it("配布形式を判別し、ZIP・開発版は自動インストールしない", () => {
  expect(updateMode(false, "win32", "nsis", false)).toBe("disabled");
  expect(updateMode(true, "win32", "nsis", false)).toBe("auto");
  expect(updateMode(true, "win32", "", false)).toBe("manual");
  expect(updateMode(true, "linux", "deb", false)).toBe("auto");
  expect(updateMode(true, "linux", "", true)).toBe("auto");
  expect(updateMode(true, "linux", "", false)).toBe("manual");
});
it("新版を一度通知し、明示操作でダウンロード・インストールする", async () => {
  const { engine, notify, manager } = setup();
  expect(engine.autoDownload).toBe(false);
  expect(engine.autoInstallOnAppQuit).toBe(false);
  expect(engine.allowPrerelease).toBe(false);
  expect(engine.allowDowngrade).toBe(false);
  await manager.check();
  engine.emit("update-available", { version: "0.3.0" });
  engine.emit("update-available", { version: "0.3.0" });
  expect(notify).toHaveBeenCalledTimes(1);
  expect(engine.downloadUpdate).not.toHaveBeenCalled();
  await manager.download();
  engine.emit("download-progress", { percent: 37.4 });
  expect(manager.snapshot().progress).toBe(37);
  engine.emit("update-downloaded", { version: "0.3.0" });
  expect(manager.snapshot().status).toBe("downloaded");
  expect(engine.quitAndInstall).not.toHaveBeenCalled();
  manager.install();
  expect(engine.quitAndInstall).toHaveBeenCalledWith(false, true);
});
it("確認をまとめ、通信エラーから再試行でき、取得済み更新を保持する", async () => {
  const { engine, manager } = setup();
  let finish!: () => void;
  engine.checkForUpdates.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(null);
      }),
  );
  const checking = manager.check();
  await manager.check();
  expect(engine.checkForUpdates).toHaveBeenCalledTimes(1);
  finish();
  await checking;
  engine.checkForUpdates.mockRejectedValueOnce(new Error("HTTP 503"));
  await manager.check();
  expect(manager.snapshot()).toMatchObject({
    status: "error",
    error: "HTTP 503",
  });
  await manager.check();
  engine.emit("update-not-available");
  expect(manager.snapshot().status).toBe("current");
  engine.emit("update-downloaded", { version: "0.3.0" });
  await manager.check();
  expect(manager.snapshot().status).toBe("downloaded");
});
it("手動更新と開発版でインストールを拒否する", async () => {
  for (const mode of ["manual", "disabled"] as const) {
    const { engine, manager } = setup(mode);
    await manager.check();
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(
      mode === "disabled" ? 0 : 1,
    );
    engine.emit("update-available", { version: "0.3.0" });
    await expect(manager.download()).rejects.toThrow();
    expect(() => manager.install()).toThrow();
    expect(engine.downloadUpdate).not.toHaveBeenCalled();
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
  }
});
it("ダウンロード失敗後に再試行でき、重複取得はしない", async () => {
  const { engine, manager } = setup();
  engine.emit("update-available", { version: "0.3.0" });
  engine.downloadUpdate.mockRejectedValueOnce(new Error("download failed"));
  await manager.download();
  expect(manager.snapshot().status).toBe("error");
  let finish!: () => void;
  engine.downloadUpdate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([]);
      }),
  );
  const downloading = manager.download();
  await manager.download();
  expect(engine.downloadUpdate).toHaveBeenCalledTimes(2);
  finish();
  await downloading;
});
