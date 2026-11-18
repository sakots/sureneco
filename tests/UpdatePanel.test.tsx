// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Api, UpdateState } from "../src/core/types";
import { UpdatePanel } from "../src/renderer/UpdatePanel";

afterEach(cleanup);

function createApi(): Api {
  return {
    getUpdateState: vi.fn(),
    checkUpdate: vi.fn(async () => {}),
    downloadUpdate: vi.fn(async () => {}),
    installUpdate: vi.fn(async () => {}),
    openRelease: vi.fn(async () => {}),
    subscribeUpdate: vi.fn(() => () => {}),
    getSnapshot: vi.fn(),
    refresh: vi.fn(async () => {}),
    watch: vi.fn(async () => {}),
    saveSettings: vi.fn(async () => {}),
    getConfigDirectory: vi.fn(async () => "/config/current"),
    getDefaultConfigDirectory: vi.fn(async () => "/config/default"),
    chooseConfigDirectory: vi.fn(async () => null),
    changeConfigDirectory: vi.fn(async (path: string) => path),
    openThread: vi.fn(async () => {}),
    copyRoomId: vi.fn(async () => {}),
    launchMahjongSoul: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };
}

const failed: UpdateState = {
  version: "0.2.0",
  mode: "auto",
  status: "error",
  latestVersion: "0.3.0",
  progress: 0,
  error: "download failed",
};

it("更新エラーを閉じても失敗状態と再試行を維持し、変更や解消後の再発を表示する", async () => {
  const api = createApi();
  const view = render(<UpdatePanel api={api} state={failed} />);
  const user = userEvent.setup();
  const status = screen.getByRole("status").textContent;
  await user.click(screen.getByRole("button", { name: "通知を閉じる" }));
  view.rerender(<UpdatePanel api={api} state={{ ...failed }} />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe(status);
  expect(api.checkUpdate).not.toHaveBeenCalled();
  expect(api.downloadUpdate).not.toHaveBeenCalled();
  expect(api.installUpdate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "ダウンロード" }));
  expect(api.downloadUpdate).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "更新を確認" }));
  expect(api.checkUpdate).toHaveBeenCalledTimes(1);
  view.rerender(
    <UpdatePanel api={api} state={{ ...failed, error: "another failure" }} />,
  );
  expect(screen.getByRole("alert").textContent).toContain("another failure");
  await user.click(screen.getByRole("button", { name: "通知を閉じる" }));
  view.rerender(
    <UpdatePanel
      api={api}
      state={{ ...failed, status: "available", error: null }}
    />,
  );
  expect(screen.queryByRole("alert")).toBeNull();
  view.rerender(<UpdatePanel api={api} state={failed} />);
  expect(screen.getByRole("alert").textContent).toContain(failed.error);
});

it("ダウンロード中のエラーを閉じても進捗と操作制限を維持する", async () => {
  const api = createApi();
  render(
    <UpdatePanel
      api={api}
      state={{ ...failed, status: "downloading", progress: 42 }}
    />,
  );
  const status = screen.getByRole("status").textContent;
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "通知を閉じる" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe(status);
  expect((screen.getByRole("progressbar") as HTMLProgressElement).value).toBe(
    42,
  );
  expect(
    (screen.getByRole("button", { name: "更新を確認" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(api.checkUpdate).not.toHaveBeenCalled();
  expect(api.downloadUpdate).not.toHaveBeenCalled();
});

it("操作の失敗を閉じた後も再操作でき、同じエラーを再表示する", async () => {
  const api = createApi();
  vi.mocked(api.openRelease).mockRejectedValue(
    new Error("release unavailable"),
  );
  render(
    <UpdatePanel
      api={api}
      state={{ ...failed, status: "available", error: null }}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "リリースを開く" }));
  expect(screen.getByRole("alert").textContent).toContain(
    "release unavailable",
  );
  await user.click(screen.getByRole("button", { name: "通知を閉じる" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.openRelease).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "リリースを開く" }));
  expect(screen.getByRole("alert").textContent).toContain(
    "release unavailable",
  );
  expect(api.openRelease).toHaveBeenCalledTimes(2);
});

it("閉じた外部エラーと同じ操作エラーを表示し、操作エラーを閉じても外部エラーを再表示しない", async () => {
  const api = createApi();
  vi.mocked(api.downloadUpdate).mockRejectedValue(new Error(failed.error!));
  const view = render(<UpdatePanel api={api} state={failed} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "通知を閉じる" }));
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByRole("button", { name: "ダウンロード" }));
  expect(screen.getByRole("alert").textContent).toContain(failed.error);
  expect(api.downloadUpdate).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "通知を閉じる" }));
  view.rerender(<UpdatePanel api={api} state={{ ...failed }} />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.downloadUpdate).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "ダウンロード" }));
  expect(screen.getByRole("alert").textContent).toContain(failed.error);
  expect(api.downloadUpdate).toHaveBeenCalledTimes(2);
});

it("外部エラーと操作失敗が同じ場合は通知を重複せず、閉じた後も再表示しない", async () => {
  const api = createApi();
  vi.mocked(api.downloadUpdate).mockRejectedValue(new Error(failed.error!));
  const view = render(<UpdatePanel api={api} state={failed} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "ダウンロード" }));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toContain(failed.error);
  await user.click(screen.getByRole("button", { name: "通知を閉じる" }));
  view.rerender(<UpdatePanel api={api} state={{ ...failed }} />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.downloadUpdate).toHaveBeenCalledTimes(1);
});

it("Androidの手動更新は新版だけAPKを開き、確認中と失敗から復旧できる", async () => {
  const api = createApi();
  api.mobile = {} as NonNullable<Api["mobile"]>;
  const state: UpdateState = {
    version: "0.2.0",
    mode: "manual",
    status: "idle",
    latestVersion: null,
    progress: 0,
    error: null,
  };
  const view = render(<UpdatePanel api={api} state={state} />);
  const user = userEvent.setup();
  expect(
    screen.queryByRole("button", { name: "APKをダウンロード" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "更新を確認" }));
  expect(api.checkUpdate).toHaveBeenCalledTimes(1);
  view.rerender(
    <UpdatePanel api={api} state={{ ...state, status: "checking" }} />,
  );
  expect(
    screen.getByRole("button", { name: "更新を確認" }).hasAttribute("disabled"),
  ).toBe(true);
  view.rerender(
    <UpdatePanel
      api={api}
      state={{ ...state, status: "error", error: "通信に失敗しました。" }}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "通信に失敗しました。",
  );
  await user.click(screen.getByRole("button", { name: "更新を確認" }));
  expect(api.checkUpdate).toHaveBeenCalledTimes(2);
  view.rerender(
    <UpdatePanel
      api={api}
      state={{ ...state, status: "available", latestVersion: "0.3.0" }}
    />,
  );
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByRole("button", { name: "APKをダウンロード" }));
  expect(api.openRelease).toHaveBeenCalledTimes(1);
  expect(api.downloadUpdate).not.toHaveBeenCalled();
  expect(api.installUpdate).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "リリースを開く" })).toBeNull();
  expect(screen.queryByRole("button", { name: "再起動して更新" })).toBeNull();
  view.rerender(
    <UpdatePanel api={api} state={{ ...state, status: "current" }} />,
  );
  expect(screen.getByRole("status").textContent).toContain("最新");
  expect(
    screen.queryByRole("button", { name: "APKをダウンロード" }),
  ).toBeNull();
  view.rerender(
    <UpdatePanel
      api={api}
      state={{ ...state, mode: "disabled", status: "disabled" }}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("Play版");
  expect(screen.queryByRole("button", { name: "更新を確認" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "APKをダウンロード" }),
  ).toBeNull();
});

it("Androidの確認操作が失敗したら古いAPK案内を閉じ、エラーを消しても再確認まで戻さない", async () => {
  const api = createApi();
  api.mobile = {} as NonNullable<Api["mobile"]>;
  vi.mocked(api.checkUpdate).mockRejectedValueOnce(
    new Error("端末と通信できませんでした。"),
  );
  render(
    <UpdatePanel
      api={api}
      state={{
        version: "0.2.0",
        mode: "manual",
        status: "available",
        latestVersion: "0.3.0",
        progress: 0,
        error: null,
      }}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "更新を確認" }));
  expect(screen.getByRole("alert").textContent).toContain(
    "端末と通信できませんでした。",
  );
  expect(
    screen.queryByRole("button", { name: "APKをダウンロード" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "通知を閉じる" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "APKをダウンロード" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "更新を確認" }));
  expect(
    screen.getByRole("button", { name: "APKをダウンロード" }),
  ).toBeTruthy();
});
