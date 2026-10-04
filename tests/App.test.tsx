// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";
import { defaults } from "../src/core/settings";
import type { Api, Snapshot } from "../src/core/types";
afterEach(cleanup);
function setup(recruitments: Snapshot["recruitments"] = []) {
  const snapshot: Snapshot = {
    settings: defaults,
    watched: [],
    threads: [
      {
        id: "1791034502",
        title: "【雀魂】じゃんたまスレ",
        count: 20,
        createdAt: 1791034502000,
      },
    ],
    recruitments,
    errors: [],
    updatedAt: null,
    refreshing: false,
    notificationAvailable: true,
  };
  const api: Api = {
    getSnapshot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => {}),
    watch: vi.fn(async () => {}),
    saveSettings: vi.fn(async () => {}),
    openThread: vi.fn(async () => {}),
    copyRoomId: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };
  render(<App api={api} />);
  return api;
}
it("スレッドのトグルと更新を操作できる", async () => {
  const api = setup();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("switch", { name: "【雀魂】じゃんたまスレを監視" }),
  );
  expect(api.watch).toHaveBeenCalledWith("1791034502", true);
  await user.click(screen.getByRole("button", { name: "今すぐ更新" }));
  expect(api.refresh).toHaveBeenCalled();
});
it("設定の検証エラーを表示し、NGを一行一件で保存する", async () => {
  const api = setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "設定" }));
  const interval = screen.getByLabelText("更新間隔（秒）");
  await user.clear(interval);
  await user.type(interval, "29");
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  expect(api.saveSettings).not.toHaveBeenCalled();
  await user.clear(interval);
  await user.type(interval, "30");
  await user.type(screen.getByLabelText("NG ID"), "abc\nxyz");
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  await waitFor(() =>
    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ update_sec: 30, ng_ids: ["abc", "xyz"] }),
    ),
  );
});

const recruitment = {
  number: 12,
  name: "名無し",
  id: "abc",
  watchoi: "",
  body: "友人戦 01234 と ５６７８９\n6桁は123456",
  postedAt: Date.now(),
  threadId: "1791034502",
  closed: false,
};
it("ルームIDをクリックすると半角でコピーし、レスは別の操作で開く", async () => {
  const api = setup([recruitment]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^友人戦募集/ }));
  await user.click(
    screen.getByRole("button", { name: "ルームID 01234をコピー" }),
  );
  expect(api.copyRoomId).toHaveBeenCalledWith("01234");
  expect(api.openThread).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain(
    "01234をコピーしました",
  );
  await user.click(
    screen.getByRole("button", { name: "ルームID 56789をコピー" }),
  );
  expect(api.copyRoomId).toHaveBeenCalledWith("56789");
  expect(screen.queryByRole("button", { name: /12345をコピー/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "レスを開く" }));
  expect(api.openThread).toHaveBeenCalledWith("1791034502", 12);
});
it("コピーに失敗した場合はエラーを表示する", async () => {
  const api = setup([recruitment]);
  vi.mocked(api.copyRoomId).mockRejectedValueOnce(
    new Error("コピーできませんでした"),
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^友人戦募集/ }));
  await user.click(
    screen.getByRole("button", { name: "ルームID 01234をコピー" }),
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "コピーできませんでした",
  );
  expect(screen.queryByRole("status")).toBeNull();
});
