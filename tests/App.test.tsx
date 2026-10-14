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
  settings: Snapshot["settings"] = defaults,
) {
  const snapshot: Snapshot = {
    settings,
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
    getConfigDirectory: vi.fn(async () => "/config/current"),
    chooseConfigDirectory: vi.fn(async () => null),
    changeConfigDirectory: vi.fn(async (path: string) => path),
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
  const interval = screen.getByLabelText("友人戦募集の更新間隔（秒）");
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
      expect.objectContaining({
        update_sec: 20,
        thread_update_sec: 300,
        ng_ids: ["abc", "xyz"],
      }),
    ),
  );
});

it("一覧の更新間隔の既定値と境界を表示し、不正な値を保存しない", async () => {
  const api = setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "設定" }));
  const interval = screen.getByLabelText("スレッド一覧の更新間隔（秒）");
  expect((interval as HTMLInputElement).value).toBe("300");
  expect(interval.getAttribute("min")).toBe("20");
  expect(interval.getAttribute("max")).toBe("2147483");
  expect(interval.getAttribute("step")).toBe("1");
  expect(
    screen.getByText(/友人戦募集：20秒ごと.*スレッド一覧：300秒ごと/),
  ).toBeTruthy();
  for (const value of ["19", "20.5", "2147484"]) {
    await user.clear(interval);
    await user.type(interval, value);
    await user.click(screen.getByRole("button", { name: "設定を保存" }));
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "thread_update_secは20以上2147483以下の整数にしてください。",
    );
  }
  for (const thread_update_sec of [20, 2147483]) {
    await user.clear(interval);
    await user.type(interval, String(thread_update_sec));
    await user.click(screen.getByRole("button", { name: "設定を保存" }));
    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ update_sec: 20, thread_update_sec }),
      ),
    );
  }
});

it("保存済みの両更新間隔を表示し、一覧間隔を変更しても他の設定を保持する", async () => {
  const saved = {
    ...defaults,
    update_sec: 45,
    thread_update_sec: 600,
    thread_title_regex: "保存済みの検索条件",
    yujinsen_regex: "保存済みの募集条件",
    ng_ids: ["saved-id"],
    launcher_mode: "application" as const,
    launcher_path: "/usr/bin/mahjong",
    launcher_args: ["--saved-profile"],
  };
  const api = setup([], undefined, saved);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "設定" }));
  expect(
    (screen.getByLabelText("友人戦募集の更新間隔（秒）") as HTMLInputElement)
      .value,
  ).toBe("45");
  const interval = screen.getByLabelText("スレッド一覧の更新間隔（秒）");
  expect((interval as HTMLInputElement).value).toBe("600");
  expect(
    screen.getByText(/友人戦募集：45秒ごと.*スレッド一覧：600秒ごと/),
  ).toBeTruthy();
  await user.clear(interval);
  await user.type(interval, "900");
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  await waitFor(() =>
    expect(api.saveSettings).toHaveBeenCalledWith({
      ...saved,
      thread_update_sec: 900,
    }),
  );
});

it("設定フォルダの変更に失敗しても現在の保存先と入力を保持する", async () => {
  const api = setup();
  vi.mocked(api.changeConfigDirectory).mockRejectedValueOnce(
    new Error("変更先に state.json が既に存在します"),
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "設定" }));
  const path = screen.getByLabelText("設定フォルダのパス");
  await waitFor(() =>
    expect((path as HTMLInputElement).value).toBe("/config/current"),
  );
  await user.clear(path);
  await user.type(path, "/config/existing");
  await user.click(screen.getByRole("button", { name: "保存先を変更" }));
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.getByText("/config/current")).toBeTruthy();
  expect((path as HTMLInputElement).value).toBe("/config/existing");
});

it("フォルダ選択をキャンセルしても入力と現在の保存先を保持する", async () => {
  setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "設定" }));
  const path = screen.getByLabelText("設定フォルダのパス");
  await waitFor(() =>
    expect((path as HTMLInputElement).value).toBe("/config/current"),
  );
  await user.clear(path);
  await user.type(path, "/config/draft");
  await user.click(screen.getByRole("button", { name: "フォルダを選択" }));
  expect((path as HTMLInputElement).value).toBe("/config/draft");
  expect(screen.getByText("/config/current")).toBeTruthy();
});

it("選択したフォルダは明示的に変更するまで保存先にせず、変更後は確定したパスを表示する", async () => {
  const api = setup();
  vi.mocked(api.chooseConfigDirectory).mockResolvedValueOnce(
    "/config/selected",
  );
  vi.mocked(api.changeConfigDirectory).mockResolvedValueOnce(
    "/config/resolved",
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "設定" }));
  const path = screen.getByLabelText("設定フォルダのパス");
  await user.click(screen.getByRole("button", { name: "フォルダを選択" }));
  expect((path as HTMLInputElement).value).toBe("/config/selected");
  expect(screen.getByText("/config/current")).toBeTruthy();
  expect(screen.queryByText("/config/resolved")).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存先を変更" }));
  expect(screen.getByText("/config/resolved")).toBeTruthy();
  expect((path as HTMLInputElement).value).toBe("/config/resolved");
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
    { ...recruitment, number: 34, body: ">>1 あと1人", roomIds: ["01234"] },
  ]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^友人戦募集/ }));
  expect(screen.getByText("参照先のルームID")).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "ルームID 01234をコピー" }),
  );
  expect(api.copyRoomId).toHaveBeenCalledWith("01234");
});

it.each([
  { body: "友人戦 01234", expected: 34 },
  { body: ">>1 あと1人", expected: 1 },
  { body: ">>2 友人戦 01234 >>1", expected: 2 },
  { body: "＞＞ １２ あと1人 >>2", expected: 12 },
])(
  "コピー・起動時のレス番号は最初の参照を優先する: $body",
  async ({ body, expected }) => {
    const api = setup([
      { ...recruitment, number: 34, body, roomIds: ["01234"] },
    ]);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /^友人戦募集/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "ルームID 01234をコピー" }),
    );
    expect(screen.getByRole("status").textContent).toMatch(
      new RegExp(`^レス ${expected}：`),
    );
    await user.click(
      screen.getByRole("button", {
        name: "ルームID 01234をコピーして雀魂を起動",
      }),
    );
    expect(screen.getByRole("status").textContent).toMatch(
      new RegExp(`^レス ${expected}：`),
    );
    await user.click(screen.getByRole("button", { name: "レスを開く" }));
    expect(api.openThread).toHaveBeenCalledWith("1791034502", 34);
  },
);

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
