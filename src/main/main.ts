import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  ipcMain,
  shell,
  dialog,
  screen,
} from "electron";
import electronUpdater from "electron-updater";
import { readFile } from "node:fs/promises";
import { UpdateManager, updateMode, releaseUrl } from "./updates";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Monitor, errorMessage } from "../core/monitor";
import { threadUrl } from "../core/settings";
import { Store } from "./store";
import {
  WindowStateStore,
  restoreWindowState,
  captureWindowState,
} from "./window-state";
import { client } from "./client";
import { copyRoomId } from "./clipboard";
import { launchMahjongSoul } from "./launcher";
import { iconData } from "./tray-icon";
import {
  registerNotificationProtocol,
  notificationOptions,
  showMainWindow,
} from "./notifications";
const here = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let updateTimer: ReturnType<typeof setInterval> | undefined;
let persistWindowState = () => {};
const notifications = new Set<Notification>();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow(window);
  });
  app.on("before-quit", () => {
    quitting = true;
    persistWindowState();
    clearTimeout(timer);
    clearInterval(updateTimer);
  });
  app.on("window-all-closed", () => {
    if (!tray) app.quit();
  });
  app
    .whenReady()
    .then(async () => {
      const notificationProtocol = registerNotificationProtocol(app);
      const notificationAvailable =
        Notification.isSupported() &&
        (process.platform !== "win32" || notificationProtocol !== null);
      const store = new Store(app.getPath("userData"));
      const state = await store.load();
      const monitor = new Monitor(
        state,
        client,
        (s) => store.save(s),
        (item, thread) => {
          if (!notificationAvailable) return;
          const notification = new Notification(
            notificationOptions(
              `友人戦募集 · ${thread?.title ?? item.threadId}`,
              item.body.slice(0, 220),
              notificationProtocol ?? undefined,
            ),
          );
          notifications.add(notification);
          notification.on("click", () => {
            showMainWindow(window);
          });
          notification.on("close", () => notifications.delete(notification));
          notification.show();
        },
      );
      monitor.notificationAvailable = notificationAvailable;
      const windowStore = new WindowStateStore(app.getPath("userData"));
      const primary = screen.getPrimaryDisplay();
      const workAreas = [
        primary,
        ...screen
          .getAllDisplays()
          .filter((display) => display.id !== primary.id),
      ].map((display) => display.workArea);
      const { maximized, ...bounds } = restoreWindowState(
        windowStore.load(),
        workAreas,
      );
      window = new BrowserWindow({
        ...bounds,
        title: "sureneco",
        backgroundColor: "#f5f6f8",
        icon: nativeImage.createFromDataURL(iconData),
        webPreferences: {
          preload: join(here, "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      let wasMaximized = maximized;
      window.on("maximize", () => {
        wasMaximized = true;
      });
      window.on("unmaximize", () => {
        if (window && !window.isMinimized()) wasMaximized = false;
      });
      persistWindowState = () => {
        if (!window || window.isDestroyed()) return;
        try {
          windowStore.save(captureWindowState(window, wasMaximized));
        } catch (error) {
          console.error("ウィンドウ状態を保存できません:", errorMessage(error));
        }
      };
      if (maximized) window.maximize();
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      const trusted = (event: Electron.IpcMainInvokeEvent) => {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error("IPC送信元が不正です。");
      };
      const handle = (channel: string, fn: (...args: any[]) => unknown) =>
        ipcMain.handle(channel, (event, ...args) => {
          trusted(event);
          return fn(...args);
        });
      const packageType = app.isPackaged
        ? await readFile(join(process.resourcesPath, "package-type"), "utf8")
            .then((value) => value.trim())
            .catch(() => "")
        : "";
      const updates = new UpdateManager(
        electronUpdater.autoUpdater,
        app.getVersion(),
        updateMode(
          app.isPackaged,
          process.platform,
          packageType,
          !!process.env.APPIMAGE,
        ),
        (version) => {
          if (!notificationAvailable) return;
          const notification = new Notification(
            notificationOptions(
              "surenecoの更新",
              `v${version}が公開されました。設定画面から更新できます。`,
              notificationProtocol ?? undefined,
            ),
          );
          notifications.add(notification);
          notification.on("click", () => showMainWindow(window));
          notification.on("close", () => notifications.delete(notification));
          notification.show();
        },
      );
      updates.onChange = (value) => {
        if (window && !window.isDestroyed())
          window.webContents.send("update-state", value);
      };
      handle("update-state", () => updates.snapshot());
      handle("check-update", () => updates.check());
      handle("download-update", () => updates.download());
      handle("install-update", () => updates.install());
      handle("open-release", () => shell.openExternal(releaseUrl));
      handle("snapshot", () => monitor.snapshot());
      handle("refresh", () => monitor.refresh());
      handle("copy-room-id", copyRoomId);
      handle("launch-mahjong-soul", (id) =>
        launchMahjongSoul(id, state.settings),
      );
      handle("watch", async (id, enabled) => {
        await monitor.watch(id, enabled);
        await monitor.refresh();
      });
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          await monitor.refresh();
          if (!quitting) schedule();
        }, state.settings.update_sec * 1000);
      };
      handle("settings", async (settings) => {
        await monitor.saveSettings(settings);
        schedule();
        await monitor.refresh();
      });
      handle("open-thread", (id, post) =>
        shell.openExternal(threadUrl(state.settings.url, id, post)),
      );
      monitor.onChange = (snapshot) => {
        if (window && !window.isDestroyed())
          window.webContents.send("state", snapshot);
      };
      try {
        tray = new Tray(nativeImage.createFromDataURL(iconData));
        tray.setToolTip("sureneco · 友人戦募集通知");
        tray.setContextMenu(
          Menu.buildFromTemplate([
            {
              label: "surenecoを開く",
              click: () => {
                showMainWindow(window);
              },
            },
            {
              label: "今すぐ更新",
              click: () => {
                void monitor.refresh();
              },
            },
            { type: "separator" },
            { label: "終了", click: () => app.quit() },
          ]),
        );
        tray.on("click", () => {
          showMainWindow(window);
        });
      } catch {
        tray = null;
      }
      window.on("close", (event) => {
        persistWindowState();
        if (!quitting && tray) {
          event.preventDefault();
          window?.hide();
        }
      });
      if (
        !app.isPackaged &&
        process.env.SURENECO_DEV_URL === "http://127.0.0.1:5173"
      )
        await window.loadURL(process.env.SURENECO_DEV_URL);
      else await window.loadFile(join(here, "../renderer/index.html"));
      if (process.platform === "win32") {
        Notification.handleActivation(() => showMainWindow(window));
      }
      void updates.check();
      updateTimer = setInterval(() => void updates.check(), 6 * 60 * 60 * 1000);
      await monitor.refresh();
      schedule();
    })
    .catch((error) => {
      dialog.showErrorBox("surenecoを起動できません", errorMessage(error));
      app.quit();
    });
}
