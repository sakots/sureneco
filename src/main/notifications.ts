import type {
  App,
  BrowserWindow,
  NotificationConstructorOptions,
} from "electron";

export function registerNotificationProtocol(
  app: Pick<
    App,
    | "isPackaged"
    | "getAppPath"
    | "setAppUserModelId"
    | "setAsDefaultProtocolClient"
  >,
  platform = process.platform,
  executable = process.execPath,
): string | null {
  if (platform !== "win32") return null;
  const protocol = app.isPackaged
    ? "sureneco-notification"
    : "sureneco-notification-dev";
  app.setAppUserModelId(
    app.isPackaged
      ? "io.github.sakots.sureneco"
      : "io.github.sakots.sureneco.dev",
  );
  return app.setAsDefaultProtocolClient(
    protocol,
    executable,
    app.isPackaged ? [] : [app.getAppPath()],
  )
    ? protocol
    : null;
}

function escapeXml(text: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  };
  return text.replace(/[&<>"']/g, (character) => entities[character]);
}

export function notificationOptions(
  title: string,
  body: string,
  protocol?: string,
): NotificationConstructorOptions {
  if (!protocol) return { title, body };
  return {
    title,
    body,
    toastXml: `<toast activationType="protocol" launch="${escapeXml(protocol)}://notifications"><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual></toast>`,
  };
}

export function showMainWindow(
  window: Pick<
    BrowserWindow,
    "isDestroyed" | "isMinimized" | "restore" | "show" | "focus"
  > | null,
): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
