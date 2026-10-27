// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopApi } from "../src/core/types";
import { AutostartPanel } from "../src/renderer/AutostartPanel";

afterEach(cleanup);

const label = "ログイン時に自動起動する";
const checkbox = () =>
  screen.getByRole("checkbox", { name: label }) as HTMLInputElement;
const retry = () =>
  screen.getByRole("button", { name: "状態を再確認" }) as HTMLButtonElement;

function createApi(initial = false): DesktopApi {
  let registered = initial;
  return {
    getAutostart: vi.fn(async () => registered),
    setAutostart: vi.fn(async (enabled: boolean) => {
      registered = enabled;
      return registered;
    }),
  };
}

it("初期照会中は状態不明とし、操作だけで有効化・解除する", async () => {
  const initial = Promise.withResolvers<boolean>();
  const api = createApi();
  vi.mocked(api.getAutostart).mockReturnValueOnce(initial.promise);
  render(<AutostartPanel api={api} />);
  expect(checkbox().disabled).toBe(true);
  expect(checkbox().indeterminate).toBe(true);
  expect(checkbox().getAttribute("aria-checked")).toBe("mixed");
  expect(retry().disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("確認中");
  fireEvent.click(checkbox());
  expect(api.setAutostart).not.toHaveBeenCalled();
  await act(async () => initial.resolve(false));
  expect(checkbox().disabled).toBe(false);
  expect(checkbox().indeterminate).toBe(false);
  expect(checkbox().checked).toBe(false);
  expect(screen.getByRole("status").textContent).toBe("自動起動はオフです。");
  expect(api.setAutostart).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.click(checkbox());
  expect(checkbox().checked).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("自動起動はオンです。");
  await user.click(checkbox());
  expect(checkbox().checked).toBe(false);
  expect(api.setAutostart).toHaveBeenNthCalledWith(1, true);
  expect(api.setAutostart).toHaveBeenNthCalledWith(2, false);
  await user.click(retry());
  expect(checkbox().checked).toBe(false);
});

it("登録済みの状態を読み、要求値ではなくOSが返した状態を表示する", async () => {
  const api = createApi(true);
  vi.mocked(api.setAutostart).mockResolvedValueOnce(true);
  render(<AutostartPanel api={api} />);
  await waitFor(() => expect(checkbox().checked).toBe(true));
  await userEvent.setup().click(checkbox());
  expect(api.setAutostart).toHaveBeenCalledExactlyOnceWith(false);
  expect(checkbox().checked).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("自動起動はオンです。");
});

it("初回の取得失敗をオフと偽らず、再照会で回復する", async () => {
  const api = createApi(true);
  vi.mocked(api.getAutostart).mockRejectedValueOnce(
    new Error("登録先を読み取れません"),
  );
  render(<AutostartPanel api={api} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "登録先を読み取れません",
  );
  expect(screen.getByRole("status").textContent).toBe(
    "自動起動の状態は未確認です。",
  );
  expect(checkbox().indeterminate).toBe(true);
  expect(checkbox().disabled).toBe(true);
  expect(screen.queryByText("自動起動はオフです。")).toBeNull();
  await userEvent.setup().click(retry());
  expect(checkbox().checked).toBe(true);
  expect(checkbox().disabled).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.getAutostart).toHaveBeenCalledTimes(2);
  expect(api.setAutostart).not.toHaveBeenCalled();
});

it.each([false, true])(
  "変更失敗を表示し、OSを再照会して元の状態へ戻す: %s",
  async (initial) => {
    const reread = Promise.withResolvers<boolean>();
    const api = createApi(initial);
    vi.mocked(api.getAutostart)
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(reread.promise);
    vi.mocked(api.setAutostart).mockRejectedValueOnce(
      "書き込みが拒否されました",
    );
    render(<AutostartPanel api={api} />);
    await waitFor(() => expect(checkbox().disabled).toBe(false));
    await userEvent.setup().click(checkbox());
    expect(screen.getByRole("alert").textContent).toContain(
      "書き込みが拒否されました",
    );
    expect(api.getAutostart).toHaveBeenCalledTimes(2);
    expect(checkbox().disabled).toBe(true);
    expect(checkbox().indeterminate).toBe(true);
    await act(async () => reread.resolve(initial));
    expect(checkbox().checked).toBe(initial);
    expect(checkbox().disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain(
      "書き込みが拒否されました",
    );
  },
);

it("変更後の再照会も失敗した場合は未確認と両方のエラーを表示する", async () => {
  const api = createApi(true);
  vi.mocked(api.getAutostart)
    .mockResolvedValueOnce(true)
    .mockRejectedValueOnce("再照会に失敗");
  vi.mocked(api.setAutostart).mockRejectedValueOnce("解除に失敗");
  render(<AutostartPanel api={api} />);
  await waitFor(() => expect(checkbox().disabled).toBe(false));
  await userEvent.setup().click(checkbox());
  expect(checkbox().indeterminate).toBe(true);
  expect(checkbox().disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toBe(
    "自動起動の状態は未確認です。",
  );
  expect(screen.getByRole("alert").textContent).toContain("解除に失敗");
  expect(screen.getByRole("alert").textContent).toContain("再照会に失敗");
  await userEvent.setup().click(retry());
  expect(checkbox().checked).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("変更待機中の連打と並行した照会を防ぎ、完了まで元の値を保持する", async () => {
  const change = Promise.withResolvers<boolean>();
  const api = createApi();
  vi.mocked(api.setAutostart).mockReturnValueOnce(change.promise);
  render(<AutostartPanel api={api} />);
  await waitFor(() => expect(checkbox().disabled).toBe(false));
  act(() => {
    fireEvent.click(checkbox());
    fireEvent.click(checkbox());
    fireEvent.click(retry());
  });
  expect(checkbox().checked).toBe(false);
  expect(checkbox().disabled).toBe(true);
  expect(retry().disabled).toBe(true);
  expect(api.setAutostart).toHaveBeenCalledExactlyOnceWith(true);
  expect(api.getAutostart).toHaveBeenCalledTimes(1);
  await act(async () => change.resolve(true));
  expect(checkbox().checked).toBe(true);
  expect(checkbox().disabled).toBe(false);
});

it("破棄した初期照会は新しいカードの状態を上書きしない", async () => {
  const oldRead = Promise.withResolvers<boolean>();
  const oldApi = createApi();
  vi.mocked(oldApi.getAutostart).mockReturnValueOnce(oldRead.promise);
  const view = render(<AutostartPanel api={oldApi} />);
  const newApi = createApi(true);
  view.rerender(<AutostartPanel api={newApi} />);
  await waitFor(() => expect(checkbox().checked).toBe(true));
  await act(async () => oldRead.resolve(false));
  expect(checkbox().checked).toBe(true);
  view.unmount();
});

it("破棄後の変更失敗は再照会せず、新しいカードにエラーを漏らさない", async () => {
  const oldChange = Promise.withResolvers<boolean>();
  const oldApi = createApi();
  vi.mocked(oldApi.setAutostart).mockReturnValueOnce(oldChange.promise);
  const view = render(<AutostartPanel api={oldApi} />);
  await waitFor(() => expect(checkbox().disabled).toBe(false));
  await userEvent.setup().click(checkbox());
  view.unmount();
  const newApi = createApi(true);
  render(<AutostartPanel api={newApi} />);
  await waitFor(() => expect(checkbox().checked).toBe(true));
  await act(async () => oldChange.reject(new Error("古い操作の失敗")));
  expect(oldApi.getAutostart).toHaveBeenCalledTimes(1);
  expect(checkbox().checked).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("取得エラーを閉じても未確認のチェックボックスを有効にせず、再試行の失敗を再表示する", async () => {
  const api = createApi(true);
  vi.mocked(api.getAutostart)
    .mockRejectedValueOnce(new Error("登録先を読み取れません"))
    .mockRejectedValueOnce(new Error("登録先を読み取れません"));
  const view = render(<AutostartPanel api={api} />);
  await screen.findByRole("alert");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "通知を閉じる" }));
  view.rerender(<AutostartPanel api={api} />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(checkbox().disabled).toBe(true);
  expect(checkbox().indeterminate).toBe(true);
  expect(retry().disabled).toBe(false);
  expect(api.getAutostart).toHaveBeenCalledTimes(1);
  expect(api.setAutostart).not.toHaveBeenCalled();
  await user.click(retry());
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(checkbox().disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "通知を閉じる" }));
  await user.click(retry());
  expect(checkbox().checked).toBe(true);
  expect(checkbox().disabled).toBe(false);
});

it("変更エラーを閉じてもOSの状態を維持し、次の変更を操作できる", async () => {
  const api = createApi(true);
  vi.mocked(api.setAutostart).mockRejectedValueOnce(new Error("変更失敗"));
  render(<AutostartPanel api={api} />);
  await waitFor(() => expect(checkbox().disabled).toBe(false));
  const user = userEvent.setup();
  await user.click(checkbox());
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "通知を閉じる" }));
  expect(checkbox().checked).toBe(true);
  expect(checkbox().disabled).toBe(false);
  expect(api.setAutostart).toHaveBeenCalledTimes(1);
  await user.click(checkbox());
  expect(checkbox().checked).toBe(false);
  expect(api.setAutostart).toHaveBeenCalledTimes(2);
});
