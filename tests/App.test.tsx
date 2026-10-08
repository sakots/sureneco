// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";
import { defaults } from "../src/core/settings";
import type { Api, Snapshot, UpdateState } from "../src/core/types";
afterEach(cleanup);
function setup(
  recruitments: Snapshot["recruitments"] = [],
  update: UpdateState = {
    version: "0.2.0",
    mode: "disabled",
    status: "disabled",
    latestVersion: null,
    progress: 0,
    error: null,
  },
) {
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
    getUpdateState: vi.fn(async () => update),
    checkUpdate: vi.fn(async () => {}),
    downloadUpdate: vi.fn(async () => {}),
    installUpdate: vi.fn(async () => {}),
    openRelease: vi.fn(async () => {}),
    subscribeUpdate: vi.fn(() => () => {}),
    getSnapshot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => {}),
    watch: vi.fn(async () => {}),
    saveSettings: vi.fn(async () => {}),
    openThread: vi.fn(async () => {}),
    copyRoomId: vi.fn(async () => {}),
    launchMahjongSoul: vi.fn(async () => {}),
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
  expect(screen.getByLabelText("NG ID").getAttribute("rows")).toBe("3");
  const interval = screen.getByLabelText("更新間隔（秒）");
  expect((interval as HTMLInputElement).value).toBe("20");
  expect(interval.getAttribute("min")).toBe("20");
  await user.clear(interval);
  await user.type(interval, "19");
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  expect(api.saveSettings).not.toHaveBeenCalled();
  await user.clear(interval);
  await user.type(interval, "20");
  await user.type(screen.getByLabelText("NG ID"), "abc\nxyz");
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  await waitFor(() =>
    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ update_sec: 20, ng_ids: ["abc", "xyz"] }),
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
  roomIds: ["01234", "56789"],
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

it("参照先から得たルームIDもコピーできる", async () => {
  const api = setup([
    { ...recruitment, body: ">>1 あと1人", roomIds: ["01234"] },
  ]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^友人戦募集/ }));
  expect(screen.getByText("参照先のルームID")).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "ルームID 01234をコピー" }),
  );
  expect(api.copyRoomId).toHaveBeenCalledWith("01234");
});

it("募集カードにレス番号を明示し、参照先の番号と区別する", async () => {
  setup([{ ...recruitment, body: ">>1 あと1人" }]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^友人戦募集/ }));
  expect(screen.getByText("レス 12")).toBeTruthy();
  expect(screen.queryByText("レス 1")).toBeNull();
});

it("新版を表示し、ダウンロードを明示操作で開始する", async () => {
  const api = setup([], {
    version: "0.2.0",
    mode: "auto",
    status: "available",
    latestVersion: "0.3.0",
    progress: 0,
    error: null,
  });
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "更新画面を開く" }),
  );
  expect(screen.getByText("現在のバージョン v0.2.0")).toBeTruthy();
  expect(api.downloadUpdate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "ダウンロード" }));
  expect(api.downloadUpdate).toHaveBeenCalledTimes(1);
});
it("取得済みの更新を再起動して適用でき、ZIP版はリリース画面へ案内する", async () => {
  const user = userEvent.setup();
  const api = setup([], {
    version: "0.2.0",
    mode: "auto",
    status: "downloaded",
    latestVersion: "0.3.0",
    progress: 100,
    error: null,
  });
  await user.click(await screen.findByRole("button", { name: "設定" }));
  await user.click(screen.getByRole("button", { name: "再起動して更新" }));
  expect(api.installUpdate).toHaveBeenCalledTimes(1);
  cleanup();
  const manual = setup([], {
    version: "0.2.0",
    mode: "manual",
    status: "available",
    latestVersion: "0.3.0",
    progress: 0,
    error: null,
  });
  await user.click(await screen.findByRole("button", { name: "設定" }));
  expect(screen.queryByRole("button", { name: "ダウンロード" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "リリースを開く" }));
  expect(manual.openRelease).toHaveBeenCalledTimes(1);
});

it("通知を許可するワッチョイを一行一件で保存し、既定値では解除する", async () => {
  const api = setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "設定" }));
  const field = screen.getByLabelText("通知を許可するワッチョイ");
  await user.type(field, " ﾜｯﾁｮｲ allowed \nﾜｯﾁｮｲ other\nﾜｯﾁｮｲ allowed");
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  expect(api.saveSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({
      allowed_watchois: ["ﾜｯﾁｮｲ allowed", "ﾜｯﾁｮｲ other"],
    }),
  );
  await user.click(screen.getByRole("button", { name: "既定値を入力" }));
  expect((field as HTMLTextAreaElement).value).toBe("");
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  expect(api.saveSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ allowed_watchois: [] }),
  );
});

it("募集のIDを指定して雀魂を起動し、締め切り済みの募集は起動しない", async () => {
  const api = setup([
    {
      ...recruitment,
      body: ">>1 あと1人",
      roomIds: ["01234"],
      postedAt: Date.now(),
    },
    {
      ...recruitment,
      number: 13,
      closed: true,
      roomIds: ["23456"],
      postedAt: Date.now(),
    },
    {
      ...recruitment,
      number: 14,
      roomIds: ["34567"],
      postedAt: Date.now() - 3600000,
    },
  ]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^友人戦募集/ }));
  await user.click(
    screen.getByRole("button", {
      name: "ルームID 01234をコピーして雀魂を起動",
    }),
  );
  expect(api.launchMahjongSoul).toHaveBeenCalledWith("01234");
  expect(
    (
      screen.getByRole("button", {
        name: "ルームID 23456をコピーして雀魂を起動",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "ルームID 34567をコピーして雀魂を起動",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  vi.mocked(api.launchMahjongSoul).mockRejectedValueOnce(
    new Error("実行ファイルが見つかりません"),
  );
  await user.click(
    screen.getByRole("button", {
      name: "ルームID 01234をコピーして雀魂を起動",
    }),
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "実行ファイルが見つかりません",
  );
});

it("ブラウザーの実行ファイルとプロファイルを保存し、アプリの引数は一行ずつ保存する", async () => {
  const api = setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "設定" }));
  await user.selectOptions(screen.getByLabelText("起動方法"), "browser");
  await user.type(
    screen.getByLabelText("実行ファイルのフルパス"),
    "/opt/google/chrome",
  );
  await user.type(
    screen.getByLabelText("プロファイルディレクトリー名"),
    "Profile 1",
  );
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  expect(api.saveSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({
      launcher_mode: "browser",
      launcher_path: "/opt/google/chrome",
      launcher_profile: "Profile 1",
    }),
  );
  await user.selectOptions(screen.getByLabelText("起動方法"), "application");
  await user.type(
    screen.getByLabelText("起動引数（一行に一つ）"),
    "-applaunch\n12345\nan argument with spaces",
  );
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  expect(api.saveSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({
      launcher_mode: "application",
      launcher_args: ["-applaunch", "12345", "an argument with spaces"],
    }),
  );
});
