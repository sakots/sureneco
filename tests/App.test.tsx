// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";
import { defaults } from "../src/core/settings";
import type { Api, Snapshot, UpdateState } from "../src/core/types";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});
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
  mobile?: Api["mobile"],
  desktop?: Api["desktop"],
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
    notices: [],
    updatedAt: null,
    refreshing: false,
    notificationAvailable: true,
  };
  const api: Api = {
    mobile,
    desktop,
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

it("監視通知を個別に閉じ、更新では保持し、解消後の再発や変更を表示する", async () => {
  const api = setup();
  const user = userEvent.setup();
  await screen.findByRole("switch");
  const initial = await vi.mocked(api.getSnapshot).mock.results[0].value;
  const publish = (changes: Partial<Snapshot>) =>
    act(() => {
      vi.mocked(api.subscribe).mock.calls[0][0]({ ...initial, ...changes });
    });
  await publish({
    watched: ["1791034502"],
    notices: ["監視停止のお知らせ", "別の監視通知"],
    errors: ["取得失敗", "別の取得失敗"],
  });
  await user.click(
    within(
      screen
        .getByText("監視停止のお知らせ")
        .closest('[role="status"]') as HTMLElement,
    ).getByRole("button", { name: "通知を閉じる" }),
  );
  await user.click(
    within(
      screen.getByText("取得失敗").closest('[role="alert"]') as HTMLElement,
    ).getByRole("button", { name: "通知を閉じる" }),
  );
  expect(screen.getByText("別の監視通知")).toBeTruthy();
  expect(screen.getByText("別の取得失敗")).toBeTruthy();
  await publish({
    watched: ["1791034502"],
    notices: ["追加のお知らせ", "監視停止のお知らせ", "別の監視通知"],
    errors: ["別の取得失敗", "取得失敗"],
    updatedAt: Date.now(),
  });
  expect(screen.queryByText("監視停止のお知らせ")).toBeNull();
  expect(screen.queryByText("取得失敗")).toBeNull();
  expect(
    (screen.getByRole("switch") as HTMLButtonElement).getAttribute(
      "aria-checked",
    ),
  ).toBe("true");
  expect(api.watch).not.toHaveBeenCalled();
  expect(api.refresh).not.toHaveBeenCalled();
  expect(api.saveSettings).not.toHaveBeenCalled();
  await publish({ notices: [], errors: ["新しい取得失敗"] });
  expect(screen.getByText("新しい取得失敗")).toBeTruthy();
  await publish({ notices: ["監視停止のお知らせ"], errors: ["取得失敗"] });
  expect(screen.getByText("監視停止のお知らせ")).toBeTruthy();
  expect(screen.getByText("取得失敗")).toBeTruthy();
});

it("設定エラーを閉じても保存せず入力を保持し、再送信時に再表示する", async () => {
  const api = setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "設定" }));
  const interval = screen.getByLabelText("友人戦募集の更新間隔（秒）");
  await user.clear(interval);
  await user.type(interval, "19");
  await user.type(screen.getByLabelText("NG ID"), "unsaved-id");
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  await user.click(
    within(screen.getByRole("alert")).getByRole("button", {
      name: "通知を閉じる",
    }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.saveSettings).not.toHaveBeenCalled();
  expect((interval as HTMLInputElement).value).toBe("19");
  expect((screen.getByLabelText("NG ID") as HTMLTextAreaElement).value).toBe(
    "unsaved-id",
  );
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(api.saveSettings).not.toHaveBeenCalled();
});

it("保存の成功通知を閉じてから同じ設定を保存すると再表示する", async () => {
  const api = setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "設定" }));
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  await user.click(await screen.findByRole("button", { name: "通知を閉じる" }));
  expect(screen.queryByRole("button", { name: "通知を閉じる" })).toBeNull();
  expect(api.saveSettings).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  expect(
    await screen.findByRole("button", { name: "通知を閉じる" }),
  ).toBeTruthy();
  expect(api.saveSettings).toHaveBeenCalledTimes(2);
});
it("スレッドのトグルと更新を操作できる", async () => {
  const api = setup();
  expect(
    screen.getByRole("heading", { name: "スレネコチェッカー", level: 1 }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /テーマ：/ })).toBeNull();
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
    expect(screen.getByRole("alert")).toBeTruthy();
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

it("自動起動は監視設定の保存や設定フォルダ変更から独立している", async () => {
  let enabled = false;
  const desktop = {
    getAutostart: vi.fn(async () => enabled),
    setAutostart: vi.fn(async (value: boolean) => {
      enabled = value;
      return enabled;
    }),
  };
  const api = setup([], undefined, defaults, undefined, desktop);
  const user = userEvent.setup();
  expect(desktop.getAutostart).not.toHaveBeenCalled();
  await user.click(await screen.findByRole("button", { name: "設定" }));
  const toggle = (await screen.findByRole("checkbox", {
    name: "ログイン時に自動起動する",
  })) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  await user.click(toggle);
  expect(toggle.checked).toBe(true);
  expect(api.saveSettings).not.toHaveBeenCalled();
  expect(api.changeConfigDirectory).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  expect(api.saveSettings).toHaveBeenCalledExactlyOnceWith(defaults);
  const path = screen.getByLabelText("設定フォルダのパス");
  await user.clear(path);
  await user.type(path, "/config/moved");
  await user.click(screen.getByRole("button", { name: "保存先を変更" }));
  expect(api.changeConfigDirectory).toHaveBeenCalledWith("/config/moved");
  expect(toggle.checked).toBe(true);
  expect(desktop.setAutostart).toHaveBeenCalledExactlyOnceWith(true);
  await user.click(screen.getByRole("button", { name: /^スレッド/ }));
  await user.click(screen.getByRole("button", { name: "設定" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("checkbox", {
          name: "ログイン時に自動起動する",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true),
  );
  expect(desktop.getAutostart).toHaveBeenCalledTimes(2);
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
it("コピーの通知とエラーを閉じても再操作で同じ内容を表示できる", async () => {
  const api = setup([recruitment]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^友人戦募集/ }));
  const copy = screen.getByRole("button", { name: "ルームID 01234をコピー" });
  await user.click(copy);
  await user.click(
    within(await screen.findByRole("status")).getByRole("button", {
      name: "通知を閉じる",
    }),
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(api.copyRoomId).toHaveBeenCalledTimes(1);
  await user.click(copy);
  expect(await screen.findByRole("status")).toBeTruthy();
  vi.mocked(api.copyRoomId).mockRejectedValue(
    new Error("clipboard unavailable"),
  );
  await user.click(copy);
  await user.click(
    within(await screen.findByRole("alert")).getByRole("button", {
      name: "通知を閉じる",
    }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.copyRoomId).toHaveBeenCalledTimes(3);
  await user.click(copy);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(api.copyRoomId).toHaveBeenCalledTimes(4);
  expect(api.watch).not.toHaveBeenCalled();
  expect(api.saveSettings).not.toHaveBeenCalled();
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

it("更新案内を閉じても更新状態は保持し、画面移動で案内を復活させない", async () => {
  const api = setup([], {
    version: "0.2.0",
    mode: "auto",
    status: "available",
    latestVersion: "0.3.0",
    progress: 0,
    error: null,
  });
  const user = userEvent.setup();
  const open = await screen.findByRole("button", { name: "更新画面を開く" });
  await user.click(
    within(open.closest('[role="status"]') as HTMLElement).getByRole("button", {
      name: "通知を閉じる",
    }),
  );
  expect(screen.queryByRole("button", { name: "更新画面を開く" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "設定" }));
  expect(screen.getByRole("button", { name: "ダウンロード" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /^スレッド/ }));
  expect(screen.queryByRole("button", { name: "更新画面を開く" })).toBeNull();
  expect(api.checkUpdate).not.toHaveBeenCalled();
  expect(api.downloadUpdate).not.toHaveBeenCalled();
  expect(api.installUpdate).not.toHaveBeenCalled();
});

it("デスクトップ通知の警告を閉じても設定や監視を変更しない", async () => {
  const api = setup();
  const user = userEvent.setup();
  await screen.findByRole("switch");
  const initial = await vi.mocked(api.getSnapshot).mock.results[0].value;
  await act(() => {
    vi.mocked(api.subscribe).mock.calls[0][0]({
      ...initial,
      notificationAvailable: false,
    });
  });
  const warning = screen.getByText(
    "この環境ではデスクトップ通知を利用できません。",
  );
  await user.click(
    within(warning.closest('[role="status"]') as HTMLElement).getByRole(
      "button",
      { name: "通知を閉じる" },
    ),
  );
  await act(() => {
    vi.mocked(api.subscribe).mock.calls[0][0]({
      ...initial,
      notificationAvailable: false,
      updatedAt: Date.now(),
    });
  });
  expect(
    screen.queryByText("この環境ではデスクトップ通知を利用できません。"),
  ).toBeNull();
  expect(api.saveSettings).not.toHaveBeenCalled();
  expect(api.watch).not.toHaveBeenCalled();
  expect(api.refresh).not.toHaveBeenCalled();
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

it("満員（〆）と期限切れを区別し、募集中のIDだけで雀魂を起動する", async () => {
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
      postedAt: Date.now() - 3600000,
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
  const closed = screen.getByText("満員（〆）");
  const expired = screen.getByText("期限切れ");
  expect(closed.classList.contains("closed")).toBe(true);
  expect(expired.classList.contains("expired")).toBe(true);
  expect(within(closed.closest("article")!).getByText("レス 13")).toBeTruthy();
  expect(within(expired.closest("article")!).getByText("レス 14")).toBeTruthy();
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

it("AndroidではPC専用操作を呼ばず、通知設定と60秒下限を表示する", async () => {
  const state = {
    enabled: false,
    status: "未登録",
    permission: false,
    server: null,
  };
  const mobile = {
    getPushState: vi.fn(async () => state),
    startPush: vi.fn(async () => state),
    stopPush: vi.fn(async () => state),
    deletePush: vi.fn(async () => state),
    syncPush: vi.fn(async () => state),
    requestPushPermission: vi.fn(async () => {}),
    copyPushLogin: vi.fn(async () => {}),
  };
  const desktop = {
    getAutostart: vi.fn(async () => true),
    setAutostart: vi.fn(async (enabled: boolean) => enabled),
  };
  const api = setup(
    [],
    undefined,
    { ...defaults, update_sec: 60 },
    mobile,
    desktop,
  );
  expect(
    screen.getByRole("heading", { name: "スレネコチェッカー", level: 1 }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /テーマ：/ })).toBeNull();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "設定" }));
  await screen.findByText("バックグラウンド通知");
  expect(screen.getByRole("button", { name: /テーマ：システム/ })).toBeTruthy();
  expect(screen.queryByText("設定フォルダ")).toBeNull();
  expect(screen.queryByText("雀魂の起動")).toBeNull();
  expect(
    screen.queryByRole("checkbox", { name: "ログイン時に自動起動する" }),
  ).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "ログイン時の起動" }),
  ).toBeNull();
  expect(desktop.getAutostart).not.toHaveBeenCalled();
  expect(desktop.setAutostart).not.toHaveBeenCalled();
  expect(api.getUpdateState).not.toHaveBeenCalled();
  expect(api.getConfigDirectory).not.toHaveBeenCalled();
  const interval = screen.getByLabelText("友人戦募集の更新間隔（秒）");
  expect(interval.getAttribute("min")).toBe("60");
  await user.clear(interval);
  await user.type(interval, "59");
  await user.click(screen.getByRole("button", { name: "設定を保存" }));
  expect(api.saveSettings).not.toHaveBeenCalled();
  await screen.findByText("Androidの更新間隔は60秒以上にしてください。");
});

it("テーマ操作は設定だけに表示し、他の画面でも選択とシステム追従を維持する", async () => {
  let dark = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return dark;
    },
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  }));
  setup();
  const user = userEvent.setup();
  expect(within(screen.getByRole("banner")).queryByRole("button")).toBeNull();
  expect(screen.queryByRole("button", { name: /テーマ：/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "設定" }));
  await user.click(
    await screen.findByRole("button", { name: /テーマ：システム/ }),
  );
  await user.click(screen.getByRole("button", { name: /テーマ：ライト/ }));
  await user.click(screen.getByRole("button", { name: /友人戦募集/ }));
  expect(screen.queryByRole("button", { name: /テーマ：/ })).toBeNull();
  expect(document.documentElement.dataset.theme).toBe("dark");
  await user.click(screen.getByRole("button", { name: "設定" }));
  await user.click(screen.getByRole("button", { name: /テーマ：ダーク/ }));
  await user.click(screen.getByRole("button", { name: /^スレッド/ }));
  act(() => {
    dark = true;
    listeners.forEach((listener) => listener());
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
});
