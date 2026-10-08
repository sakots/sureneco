import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "../src/renderer/api";

it("スレッドとルームIDを限定されたコマンドで渡す", async () => {
  await api.watch("1786524360", true);
  expect(invoke).toHaveBeenLastCalledWith("request", {
    command: "watch",
    payload: { id: "1786524360", enabled: true },
  });
  await api.launchMahjongSoul("01234");
  expect(invoke).toHaveBeenLastCalledWith("request", {
    command: "launch",
    payload: { id: "01234" },
  });
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
