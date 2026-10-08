import { expect, it } from "vitest";
import { defaults } from "../src/core/settings";
import { loadState } from "../src/core/state";

it("既存の設定・監視対象・取得済みレス番号を読み込む", () => {
  const saved = {
    settings: { ...defaults, update_sec: 35, allowed_watchois: ["ﾜｯﾁｮｲ test"] },
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
