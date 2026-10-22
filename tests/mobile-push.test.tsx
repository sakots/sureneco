// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MobilePushPanel } from "../src/renderer/MobilePushPanel";
afterEach(cleanup);
it("requires consent before registration, reports missing distributor, and permits stop and delete", async () => {
  const get = vi.fn().mockResolvedValue({
    enabled: false,
    status: "未登録",
    permission: true,
    ntfyOrigin: "https://push.example",
    server: null,
  });
  const api = {
    getPushState: get,
    startPush: vi.fn().mockResolvedValue({
      enabled: true,
      status: "中継アプリ未導入",
      permission: true,
    }),
    stopPush: vi.fn().mockResolvedValue({
      enabled: false,
      status: "停止反映待ち",
      permission: true,
    }),
    deletePush: vi.fn().mockResolvedValue({
      enabled: false,
      status: "登録削除済み",
      permission: true,
    }),
    syncPush: vi.fn(),
    requestPushPermission: vi.fn(),
  };
  render(<MobilePushPanel api={api} />);
  await screen.findByText("未登録");
  const user = userEvent.setup();
  expect(
    (
      screen.getByRole("button", {
        name: "通知を有効にする",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "通知を有効にする" }));
  await screen.findByText("中継アプリ未導入");
  expect(api.startPush).toHaveBeenCalledWith(true);
  await user.click(screen.getByRole("button", { name: "監視を停止" }));
  await screen.findByText("停止反映待ち");
  expect(api.stopPush).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "サーバー登録を削除" }));
  await waitFor(() => expect(api.deletePush).toHaveBeenCalledOnce());
});
