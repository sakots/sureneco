// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { PushApi, PushState } from "../src/core/types";
import { MobilePushPanel } from "../src/renderer/MobilePushPanel";

afterEach(cleanup);

function setup(ntfyOrigin?: string) {
  const state: PushState = {
    enabled: false,
    status: "未登録",
    permission: true,
    ntfyOrigin,
  };
  const api: PushApi = {
    getPushState: vi.fn(async () => state),
    startPush: vi.fn(async () => state),
    syncPush: vi.fn(async () => state),
    stopPush: vi.fn(async () => state),
    deletePush: vi.fn(async () => state),
    requestPushPermission: vi.fn(async () => {}),
  };
  render(<MobilePushPanel api={api} />);
  return api;
}

it("ntfyの案内を開閉して接続先を確認しても、同意・有効化前に登録しない", async () => {
  const api = setup("https://push.example.com");
  const user = userEvent.setup();
  await screen.findByText("未登録");
  const summary = screen.getByText("ntfyの準備・設定手順");
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  await user.click(summary);
  expect(details.open).toBe(true);
  expect(within(details).getByText(/Google PlayまたはF-Droid/)).toBeTruthy();
  expect(
    within(details).getByText(/Google Play版でもFirebaseを使いません/),
  ).toBeTruthy();
  expect(within(details).getByText("https://push.example.com")).toBeTruthy();
  expect(within(details).getByText(/ユーザー管理/)).toBeTruthy();
  expect(within(details).getByText(/読み取り権限/)).toBeTruthy();
  expect(api.startPush).not.toHaveBeenCalled();
  expect(api.syncPush).not.toHaveBeenCalled();
  const start = screen.getByRole("button", { name: "通知を有効にする" });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  await user.click(summary);
  expect(details.open).toBe(false);
  await user.click(screen.getByLabelText("保存内容と通知方式に同意する"));
  await user.click(start);
  expect(api.startPush).toHaveBeenCalledExactlyOnceWith(true);
});

it("接続先が未設定の場合は配布元へ確認するよう案内する", async () => {
  setup();
  await screen.findByText("未登録");
  await userEvent.setup().click(screen.getByText("ntfyの準備・設定手順"));
  expect(screen.getByText(/通知サーバーの接続先が未設定/)).toBeTruthy();
});
