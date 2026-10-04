import { expect, it, vi } from "vitest";
import {
  registerNotificationProtocol,
  notificationOptions,
  showMainWindow,
} from "../src/main/notifications";
function fakeApp(packaged: boolean) {
  return {
    isPackaged: packaged,
    getAppPath: () => "D:\\GitHub\\sureneco project",
    setAppUserModelId: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(() => true),
  };
}
it("配布版はsureneco.exe、開発版はアプリパス付きで起動登録する", () => {
  const packaged = fakeApp(true);
  expect(
    registerNotificationProtocol(packaged, "win32", "D:\\app\\sureneco.exe"),
  ).toBe("sureneco-notification");
  expect(packaged.setAsDefaultProtocolClient).toHaveBeenCalledWith(
    "sureneco-notification",
    "D:\\app\\sureneco.exe",
    [],
  );
  const development = fakeApp(false);
  expect(
    registerNotificationProtocol(
      development,
      "win32",
      "D:\\node_modules\\electron.exe",
    ),
  ).toBe("sureneco-notification-dev");
  expect(development.setAsDefaultProtocolClient).toHaveBeenCalledWith(
    "sureneco-notification-dev",
    "D:\\node_modules\\electron.exe",
    ["D:\\GitHub\\sureneco project"],
  );
  expect(packaged.setAppUserModelId.mock.calls[0]).not.toEqual(
    development.setAppUserModelId.mock.calls[0],
  );
});
it("Linuxでは登録せず、Windowsの登録失敗を通知不可として返す", () => {
  const app = fakeApp(true);
  expect(registerNotificationProtocol(app, "linux")).toBeNull();
  expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  app.setAsDefaultProtocolClient.mockReturnValue(false);
  expect(registerNotificationProtocol(app, "win32")).toBeNull();
});
it("Windows通知はアプリのprotocolで起動し、本文をXMLエスケープする", () => {
  const options = notificationOptions(
    "友人戦 <四南>",
    '12345 & "募集中"',
    "sureneco-notification",
  );
  expect(options.toastXml).toContain('activationType="protocol"');
  expect(options.toastXml).toContain(
    'launch="sureneco-notification://notifications"',
  );
  expect(options.toastXml).toContain("友人戦 &lt;四南&gt;");
  expect(options.toastXml).toContain("12345 &amp; &quot;募集中&quot;");
  expect(notificationOptions("title", "body")).toEqual({
    title: "title",
    body: "body",
  });
});
it("最小化したアプリを復元して表示・フォーカスする", () => {
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
  showMainWindow(window);
  expect(window.restore).toHaveBeenCalledOnce();
  expect(window.show).toHaveBeenCalledOnce();
  expect(window.focus).toHaveBeenCalledOnce();
  window.isDestroyed = () => true;
  showMainWindow(window);
  showMainWindow(null);
  expect(window.show).toHaveBeenCalledOnce();
});
