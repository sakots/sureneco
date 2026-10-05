import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  WindowStateStore,
  restoreWindowState,
  captureWindowState,
} from "../src/main/window-state";
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: -1280, y: 0, width: 1280, height: 984 };
const saved = { x: -1200, y: 80, width: 700, height: 700, maximized: true };
it("通常サイズ・位置・最大化を保存し、起動し直して復元する", () => {
  const dir = mkdtempSync(join(tmpdir(), "sureneco-window-"));
  try {
    const store = new WindowStateStore(dir);
    expect(store.load()).toBeNull();
    store.save(saved);
    expect(new WindowStateStore(dir).load()).toEqual(saved);
    expect(
      restoreWindowState(store.load(), [primary, secondary]),
    ).toMatchObject(saved);
    writeFileSync(join(dir, "window-state.json"), "broken");
    expect(store.load()).toBeNull();
    expect(readFileSync(join(dir, "window-state.json"), "utf8")).toBe("broken");
    for (const invalid of [
      { ...saved, width: -1 },
      { ...saved, x: "0" },
      { ...saved, maximized: "yes" },
      { ...saved, height: null },
    ]) {
      writeFileSync(join(dir, "window-state.json"), JSON.stringify(invalid));
      expect(store.load()).toBeNull();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("モニターがなくなった場合と一部が画面外の場合に作業領域へ戻す", () => {
  const moved = restoreWindowState(saved, [primary]);
  expect(moved).toMatchObject({
    x: 0,
    y: 80,
    width: 700,
    height: 700,
    maximized: true,
  });
  const clipped = restoreWindowState({ ...saved, x: 1800, y: 900 }, [primary]);
  expect(clipped.x + clipped.width).toBe(primary.width);
  expect(clipped.y + clipped.height).toBe(primary.height);
});
it("サイズを画面と最小サイズに合わせ、初回は中央で起動する", () => {
  expect(restoreWindowState(null, [primary])).toMatchObject({
    x: 400,
    y: 110,
    width: 1120,
    height: 820,
    maximized: false,
  });
  const oversized = restoreWindowState(
    { ...saved, x: 0, width: 3000, height: 2000 },
    [primary],
  );
  expect(oversized).toMatchObject({ width: 1920, height: 1040 });
  const tiny = restoreWindowState({ ...saved, width: 100, height: 100 }, [
    primary,
  ]);
  expect(tiny).toMatchObject({ width: 400, height: 600 });
  const smallScreen = restoreWindowState(saved, [
    { x: 0, y: 0, width: 360, height: 480 },
  ]);
  expect(smallScreen).toMatchObject({
    width: 360,
    height: 480,
    minWidth: 360,
    minHeight: 480,
  });
});
it("最大化・最小化時に通常表示のサイズを使い、最小化は次回へ持ち越さない", () => {
  const normal = { x: 100, y: 100, width: 500, height: 650 };
  const window = {
    getNormalBounds: () => normal,
    isMaximized: () => true,
    isMinimized: () => false,
  };
  expect(captureWindowState(window, false)).toEqual({
    ...normal,
    maximized: true,
  });
  expect(
    captureWindowState(
      { ...window, isMinimized: () => true, isMaximized: () => false },
      true,
    ),
  ).toEqual({ ...normal, maximized: true });
  expect(
    captureWindowState({ ...window, isMaximized: () => false }, false),
  ).toEqual({ ...normal, maximized: false });
});
