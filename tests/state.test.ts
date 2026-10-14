import { expect, it } from "vitest";
import { defaults } from "../src/core/settings";
import { loadState } from "../src/core/state";

it("既存の設定・監視対象・取得済みレス番号を読み込む", () => {
  const saved = {
    settings: {
      ...defaults,
      update_sec: 35,
      thread_update_sec: 600,
      allowed_watchois: ["ﾜｯﾁｮｲ test"],
    },
    watched: ["1786524360"],
    cursors: { "1786524360": 123 },
  };
  expect(loadState(JSON.stringify(saved))).toEqual(saved);
  expect(loadState(null)).toEqual({
    settings: defaults,
    watched: [],
    cursors: {},
  });
});

it("一覧の更新間隔がない保存設定に既定値だけを補い、既存の設定と監視状態を保持する", () => {
  const { thread_update_sec: _interval, ...settings } = {
    ...defaults,
    update_sec: 45,
    elapsed_days: 7,
    emphasis_sec: 120,
    thread_title_regex: "保存済みの検索条件",
    yujinsen_regex: "保存済みの募集条件",
    ng_ids: ["saved-id"],
    allowed_watchois: ["ﾜｯﾁｮｲ test"],
    launcher_mode: "application" as const,
    launcher_path: "/usr/bin/mahjong",
    launcher_args: ["--saved-profile"],
  };
  const saved = {
    settings,
    watched: ["1786524360"],
    cursors: { "1786524360": 123 },
  };
  expect(loadState(JSON.stringify(saved))).toEqual({
    ...saved,
    settings: { ...settings, thread_update_sec: 300 },
  });
});

it("破損した設定・監視ID・レス番号を拒否する", () => {
  for (const input of [
    "broken",
    JSON.stringify({ settings: defaults, watched: ["invalid"], cursors: {} }),
    JSON.stringify({
      settings: defaults,
      watched: [],
      cursors: { "1786524360": -1 },
    }),
  ]) {
    expect(() => loadState(input)).toThrow();
  }
});
