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
} from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Monitor, errorMessage } from "../core/monitor";
import { threadUrl } from "../core/settings";
import { Store } from "./store";
import { client } from "./client";
import { iconData } from "./tray-icon";
const here = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const notifications = new Set<Notification>();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("before-quit", () => {
    quitting = true;
    clearTimeout(timer);
  });
  app.on("window-all-closed", () => {
    if (!tray) app.quit();
  });
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("io.github.sakots.sureneco");
      const store = new Store(app.getPath("userData"));
      const state = await store.load();
      const monitor = new Monitor(
        state,
        client,
        (s) => store.save(s),
        (item, thread) => {
          if (!Notification.isSupported()) return;
          const targetUrl = threadUrl(
            state.settings.url,
            item.threadId,
            item.number,
          );
          const notification = new Notification({
            title: `友人戦募集 · ${thread?.title ?? item.threadId}`,
            body: item.body.slice(0, 220),
          });
          notifications.add(notification);
          notification.on("click", () => {
            void shell.openExternal(targetUrl);
          });
          notification.on("close", () => notifications.delete(notification));
          notification.show();
        },
      );
      monitor.notificationAvailable = Notification.isSupported();
      window = new BrowserWindow({
        width: 1120,
        height: 820,
        minWidth: 760,
        minHeight: 600,
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
      handle("snapshot", () => monitor.snapshot());
      handle("refresh", () => monitor.refresh());
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
                window?.show();
                window?.focus();
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
          window?.show();
          window?.focus();
        });
      } catch {
        tray = null;
      }
      window.on("close", (event) => {
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
      await monitor.refresh();
      schedule();
    })
    .catch((error) => {
      dialog.showErrorBox("surenecoを起動できません", errorMessage(error));
      app.quit();
    });
}
