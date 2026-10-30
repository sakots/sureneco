import { version } from "../../package.json";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Api,
  NotificationTarget,
  Snapshot,
  UpdateState,
} from "../core/types";

function subscribe<T>(event: string, callback: (value: T) => void) {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen<T>(event, (message) => callback(message.payload)).then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
const request = <T = void>(command: string, payload: object = {}) =>
  invoke<T>("request", { command, payload });
const mobile = /Android/i.test(navigator.userAgent);
const disabledUpdate: UpdateState = {
  version,
  mode: "disabled",
  status: "disabled",
  latestVersion: null,
  progress: 0,
  error: null,
};
export const api: Api = {
  ...(mobile
    ? {
        mobile: {
          consumeNotificationTarget: () =>
            request<NotificationTarget | null>("mobile_notification_target"),
          getPushState: () =>
            request<import("../core/types").PushState>("mobile_status"),
          startPush: (consent: boolean) =>
            request<import("../core/types").PushState>("mobile_start", {
              consent,
            }),
          stopPush: () =>
            request<import("../core/types").PushState>("mobile_stop"),
          deletePush: () =>
            request<import("../core/types").PushState>("mobile_delete"),
          syncPush: () =>
            request<import("../core/types").PushState>("mobile_sync"),
          requestPushPermission: () => request<void>("mobile_permission"),
          copyPushLogin: (field) =>
            request<void>("mobile_copy_login", { field }),
        },
      }
    : {
        desktop: {
          getAutostart: () => invoke<boolean>("autostart_status"),
          setAutostart: (enabled: boolean) =>
            invoke<boolean>("autostart_set", { enabled }),
        },
      }),
  getSnapshot: () => request<Snapshot>("snapshot"),
  refresh: () => request("refresh"),
  watch: (id, enabled) => request("watch", { id, enabled }),
  saveSettings: (settings) => request("settings", { settings }),
  getConfigDirectory: () =>
    mobile ? Promise.resolve("") : request<string>("config_directory"),
  chooseConfigDirectory: () => invoke<string | null>("choose_config_directory"),
  changeConfigDirectory: (path) =>
    request<string>("set_config_directory", { path }),
  openThread: (id, post) => request("open_thread", { id, post }),
  copyRoomId: (id) => request("copy_room_id", { id }),
  launchMahjongSoul: (id) => request("launch", { id }),
  subscribe: (callback) => subscribe<Snapshot>("state", callback),
  getUpdateState: () =>
    mobile
      ? Promise.resolve(disabledUpdate)
      : invoke<UpdateState>("update_state"),
  checkUpdate: () => invoke("check_update"),
  downloadUpdate: () => invoke("download_update"),
  installUpdate: () => invoke("install_update"),
  openRelease: () => invoke("open_release"),
  subscribeUpdate: (callback) =>
    mobile ? () => {} : subscribe<UpdateState>("update-state", callback),
};
