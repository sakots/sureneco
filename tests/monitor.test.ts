import { expect, it, vi } from "vitest";
import { Monitor } from "../src/core/monitor";
import { defaults } from "../src/core/settings";
import type { SavedState } from "../src/core/types";

it("初回を基準にし、再取得と再起動で重複せず、取得失敗から回復する", async () => {
  const now = Date.parse("2026-10-04T12:00:00+09:00");
  const id = String(now / 1000 - 3600);
  const state: SavedState = { settings: defaults, watched: [id], cursors: {} };
  let count = 1;
  let fail = false;
  const post = "名無し<>sage<>2026/10/04(日) 11:59:30 ID:abc<>友人戦 12345<>";
  const notify = vi.fn();
  const save = vi.fn(async () => {});
  const client = {
    subject: vi.fn(async () => `${id}.dat<>雀魂 (3)`),
    dat: vi.fn(async () => {
      if (fail) throw new Error("HTTP 403");
      return Array(count).fill(post).join("\n");
    }),
  };
  const monitor = new Monitor(state, client, save, notify, () => now);
  await monitor.refresh();
  expect(notify).not.toHaveBeenCalled();
  expect(state.cursors[id]).toBe(1);
  count = 2;
  await monitor.refresh();
  await monitor.refresh();
  expect(notify).toHaveBeenCalledTimes(1);
  fail = true;
  count = 3;
  await monitor.refresh();
  expect(monitor.snapshot().errors.join("")).toContain("403");
  expect(state.cursors[id]).toBe(2);
  fail = false;
  const restarted = new Monitor(state, client, save, notify, () => now);
  await restarted.refresh();
  expect(notify).toHaveBeenCalledTimes(2);
  expect(restarted.snapshot().errors).toEqual([]);
  expect(save).toHaveBeenCalled();
});

it("重複更新をまとめ、監視解除・再開時に基準をリセットする", async () => {
  const state: SavedState = {
    settings: defaults,
    watched: ["1791034502"],
    cursors: { "1791034502": 12 },
  };
  const client = { subject: vi.fn(async () => ""), dat: vi.fn(async () => "") };
  const monitor = new Monitor(
    state,
    client,
    async () => {},
    () => {},
  );
  await Promise.all([monitor.refresh(), monitor.refresh()]);
  expect(client.subject).toHaveBeenCalledTimes(1);
  await monitor.watch("1791034502", false);
  expect(state.cursors).toEqual({});
  await monitor.watch("1791034502", true);
  expect(state.watched).toEqual(["1791034502"]);
});

it("保存が失敗した取得は通知せず、再試行で新規レスを通知する", async () => {
  const now = Date.parse("2026-10-04T12:00:00+09:00");
  const state: SavedState = {
    settings: defaults,
    watched: ["1791034502"],
    cursors: { "1791034502": 0 },
  };
  const client = {
    subject: async () => "",
    dat: async () =>
      "名無し<>sage<>2026/10/04(日) 11:59:30 ID:abc<>友人戦 12345<>",
  };
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue(undefined);
  const notify = vi.fn();
  const monitor = new Monitor(state, client, save, notify, () => now);
  await monitor.refresh();
  expect(state.cursors["1791034502"]).toBe(0);
  expect(notify).not.toHaveBeenCalled();
  await monitor.refresh();
  expect(notify).toHaveBeenCalledTimes(1);
});

it("板URLの変更で監視対象をリセットし、保存失敗時は設定を維持する", async () => {
  const state: SavedState = {
    settings: structuredClone(defaults),
    watched: ["1791034502"],
    cursors: { "1791034502": 1 },
  };
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue(undefined);
  const monitor = new Monitor(
    state,
    { subject: async () => "", dat: async () => "" },
    save,
    () => {},
  );
  await expect(
    monitor.saveSettings({ ...defaults, url: "https://egg.5ch.net/mj/" }),
  ).rejects.toThrow("disk full");
  expect(state.settings.url).toBe(defaults.url);
  expect(state.watched).toHaveLength(1);
  await monitor.saveSettings({ ...defaults, url: "https://egg.5ch.net/mj/" });
  expect(state.watched).toEqual([]);
  expect(state.cursors).toEqual({});
});
