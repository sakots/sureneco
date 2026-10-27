import { afterEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "../src/renderer/api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("購読の解除が登録完了より早くてもリスナーを残さない", async () => {
  const stop = vi.fn();
  let finish!: (value: () => void) => void;
  vi.mocked(listen).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const unsubscribe = api.subscribe(vi.fn());
  unsubscribe();
  finish(stop);
  await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce();
});

it("AndroidのAPIは自動起動操作を公開せず初期登録も呼ばない", async () => {
  vi.stubGlobal("navigator", { userAgent: "Android" });
  // A static import would reuse the desktop platform selected by earlier tests.
  vi.mocked(invoke).mockClear();
  const { api: mobileApi } = await import("../src/renderer/api");
  expect(mobileApi.mobile).toBeDefined();
  expect(mobileApi.desktop).toBeUndefined();
  expect(invoke).not.toHaveBeenCalled();
});
