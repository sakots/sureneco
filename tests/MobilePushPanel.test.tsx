// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { PushApi, PushState } from "../src/core/types";
import { MobilePushPanel } from "../src/renderer/MobilePushPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(
  ntfyOrigin?: string,
  overrides: Partial<PushState> = {},
  methods: Partial<PushApi> = {},
) {
  const state: PushState = {
    enabled: false,
    status: "未登録",
    permission: true,
    ntfyOrigin,
    ...overrides,
  };
  const api: PushApi = {
    getPushState: vi.fn(async () => state),
    startPush: vi.fn(async () => state),
    syncPush: vi.fn(async () => state),
    stopPush: vi.fn(async () => state),
    deletePush: vi.fn(async () => state),
    requestPushPermission: vi.fn(async () => {}),
    copyPushLogin: vi.fn(async () => {}),
    ...methods,
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
  const steps = within(details).getAllByRole("listitem");
  expect(steps[1].textContent).toContain("通知を有効にする");
  expect(steps[2].textContent).toContain("ユーザー管理");
  expect(steps[3].textContent).toContain("同期を再試行");
  expect(details.textContent).not.toMatch(/運用者|発行を依頼|トピックを.*伝え/);
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

const registration = {
  topic: "up-test-device",
  username: "sur_test_device",
  password: "private-ntfy-password",
  state: "ready" as const,
  error: null,
};

it("発行された接続先とユーザー名を表示し、パスワードは操作時だけ表示する", async () => {
  setup("https://push.example.com", { registration });
  const user = userEvent.setup();
  const credentials = await screen.findByRole("group", {
    name: "ntfyログイン情報",
  });
  expect(
    (
      within(credentials).getByRole("textbox", {
        name: /サーバーURL/,
      }) as HTMLInputElement
    ).value,
  ).toBe("https://push.example.com");
  expect(
    (
      within(credentials).getByRole("textbox", {
        name: /ユーザー名/,
      }) as HTMLInputElement
    ).value,
  ).toBe(registration.username);
  const password = within(credentials).getByLabelText(
    "ntfyパスワード",
  ) as HTMLInputElement;
  expect(password.type).toBe("password");
  expect(password.value).toBe(registration.password);
  await user.click(
    within(credentials).getByRole("button", {
      name: "パスワードを表示",
    }),
  );
  expect(password.type).toBe("text");
  await user.click(
    within(credentials).getByRole("button", {
      name: "パスワードを隠す",
    }),
  );
  expect(password.type).toBe("password");
});

it("パスワードを隠したままコピーし、完了メッセージに秘密を表示しない", async () => {
  setup("https://push.example.com", { enabled: true, registration });
  const user = userEvent.setup();
  const copy = await screen.findByRole("button", {
    name: "パスワードをコピー",
  });
  await user.click(copy);
  expect(screen.getByText("パスワードをコピーしました。")).toBeTruthy();
  expect(
    (screen.getByLabelText("ntfyパスワード") as HTMLInputElement).type,
  ).toBe("password");
  expect(document.body.textContent).not.toContain(registration.password);
});

it("コピー処理中の連打を防ぎ、失敗時に秘密を含む例外を表示しない", async () => {
  const { promise, reject } = Promise.withResolvers<void>();
  setup(
    "https://push.example.com",
    { enabled: true, registration },
    {
      copyPushLogin: () => promise,
    },
  );
  const user = userEvent.setup();
  const copy = await screen.findByRole("button", {
    name: "パスワードをコピー",
  });
  await user.click(copy);
  expect((copy as HTMLButtonElement).disabled).toBe(true);
  await act(async () => reject(new Error(registration.password)));
  expect(
    screen.getByText("コピーできませんでした。もう一度お試しください。"),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain(registration.password);
  expect((copy as HTMLButtonElement).disabled).toBe(false);
});

it.each([
  { password: "rotated-private-password" },
  { username: "sur_changed_device" },
  { state: "pending" as const },
])("資格情報・管理状態が変わると再びパスワードを隠す: %j", async (change) => {
  setup(
    "https://push.example.com",
    { enabled: true, status: "確認待ち", registration },
    {
      syncPush: vi.fn(async () => ({
        enabled: true,
        status: "確認待ち",
        permission: true,
        ntfyOrigin: "https://push.example.com",
        registration: { ...registration, ...change },
      })),
    },
  );
  const user = userEvent.setup();
  await screen.findByRole("group", { name: "ntfyログイン情報" });
  await user.click(screen.getByRole("button", { name: "パスワードを表示" }));
  await user.click(screen.getByRole("button", { name: "同期を再試行" }));
  expect(
    (screen.getByLabelText("ntfyパスワード") as HTMLInputElement).type,
  ).toBe("password");
});

it("登録処理中・失敗を表示し、秘密を含みうるサーバーエラーをそのまま出さない", async () => {
  setup("https://push.example.com", {
    enabled: true,
    registration: {
      ...registration,
      state: "pending",
      error: registration.password,
    },
    server: {
      lastFetchSuccessAt: null,
      error: `Bearer ${registration.password}`,
      delivery: { error: registration.password },
    },
  });
  await screen.findByText(/アカウントと読み取り権限を設定中/);
  expect(screen.getByText(/登録処理を完了できません/)).toBeTruthy();
  expect(screen.getByText(/サーバー状態を確認できません/)).toBeTruthy();
  expect(document.body.textContent).not.toContain(registration.password);
});

it.each(["stop", "delete"] as const)(
  "%s要求中は端末停止・サーバー未反映を即表示し、失敗しても完了扱いしない",
  async (action) => {
    const { promise: pending, reject: rejectAction } =
      Promise.withResolvers<PushState>();
    setup(
      "https://push.example.com",
      { enabled: true, status: "監視中", registration },
      action === "stop"
        ? { stopPush: vi.fn(() => pending) }
        : { deletePush: vi.fn(() => pending) },
    );
    const user = userEvent.setup();
    await screen.findByText("監視中");
    await user.click(
      screen.getByRole("button", {
        name: action === "stop" ? "監視を停止" : "サーバー登録を削除",
      }),
    );
    expect(screen.getByText(/端末の通知は停止済み/)).toBeTruthy();
    expect(screen.getByText(/サーバーには未反映/)).toBeTruthy();
    await act(async () => {
      rejectAction(new Error(`Bearer ${registration.password}`));
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "通知設定を変更できません",
    );
    expect(document.body.textContent).not.toContain(registration.password);
    expect(screen.getByText(/サーバーには未反映/)).toBeTruthy();
  },
);

it.each([
  {
    registration: { ...registration, state: "pending" as const },
    status: "停止受付済み：ntfy権限撤去待ち",
    expected: /停止要求はサーバー受付済み.*権限撤去は処理中/,
  },
  {
    registration: { ...registration, state: "stopped" as const },
    status: "停止完了：ntfy権限撤去済み",
    expected: /読み取り権限の撤去を確認しました/,
  },
  {
    registration: null,
    status: "端末削除受付済み（ntfy権限撤去は非同期）",
    expected: /端末削除受付済み（ntfy権限撤去は非同期）/,
  },
])("停止受付・権限撤去完了・削除受付を区別する: $status", async (result) => {
  setup("https://push.example.com", {
    enabled: false,
    registration: result.registration,
    status: result.status,
  });
  await screen.findByText(result.expected);
  if (result.registration === null) {
    expect(screen.queryByText(/読み取り権限の撤去を確認しました/)).toBeNull();
    expect(
      screen.queryByRole("group", { name: "ntfyログイン情報" }),
    ).toBeNull();
  }
});

it("操作開始前の状態確認が遅れて届いても停止結果を上書きしない", async () => {
  const { promise: pendingRead, resolve: resolveRead } =
    Promise.withResolvers<PushState>();
  setup(
    "https://push.example.com",
    {},
    {
      getPushState: vi.fn(() => pendingRead),
      stopPush: vi.fn(async (): Promise<PushState> => ({
        enabled: false,
        permission: true,
        status: "停止済み",
        registration: { ...registration, state: "stopped" },
      })),
    },
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "監視を停止" }));
  await screen.findByText("停止済み");
  await act(async () => {
    resolveRead({
      enabled: true,
      permission: true,
      status: "古い監視中",
      registration,
    });
  });
  expect(screen.queryByText("古い監視中")).toBeNull();
  expect(screen.getByText("停止済み")).toBeTruthy();
});

it("状態確認ポーリングで発行結果を取得するが、同じ資格情報なら表示操作を保持する", async () => {
  vi.useFakeTimers();
  const api = setup("https://push.example.com", { enabled: true });
  await act(async () => {});
  vi.mocked(api.getPushState).mockResolvedValue({
    enabled: true,
    status: "確認待ち",
    permission: true,
    ntfyOrigin: "https://push.example.com",
    registration,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  fireEvent.click(screen.getByRole("button", { name: "パスワードを表示" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(
    (screen.getByLabelText("ntfyパスワード") as HTMLInputElement).type,
  ).toBe("text");
});

it.each(["stop", "delete"] as const)(
  "再表示した%sの未反映状態を完了と誤認させない",
  async (pendingAction) => {
    setup("https://push.example.com", {
      enabled: false,
      status: "端末停止済み",
      pendingAction,
      registration,
    });
    await screen.findByText(/サーバーには未反映/);
    expect(screen.queryByText(/読み取り権限の設定が完了/)).toBeNull();
    expect(screen.queryByText(/読み取り権限の撤去を確認しました/)).toBeNull();
    expect(
      screen.queryByRole("group", { name: "ntfyログイン情報" }),
    ).toBeNull();
  },
);

it("自動登録APIが失敗したときは秘密を表示せず、手動登録へ切り替えない", async () => {
  setup(
    "https://push.example.com",
    {},
    {
      startPush: vi.fn(async () => {
        throw new Error(`API unavailable: ${registration.password}`);
      }),
    },
  );
  const user = userEvent.setup();
  await screen.findByText("未登録");
  await user.click(screen.getByLabelText("保存内容と通知方式に同意する"));
  await user.click(screen.getByRole("button", { name: "通知を有効にする" }));
  expect(screen.getByRole("alert").textContent).toContain(
    "通知設定を変更できません",
  );
  expect(document.body.textContent).not.toContain(registration.password);
  expect(document.body.textContent).not.toMatch(
    /運用者|発行を依頼|トピックを.*伝え/,
  );
  expect(screen.queryByRole("group", { name: "ntfyログイン情報" })).toBeNull();
});
