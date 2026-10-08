import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Api, Snapshot, UpdateState } from "../core/types";

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
export const api: Api = {
  getSnapshot: () => request<Snapshot>("snapshot"),
  refresh: () => request("refresh"),
  watch: (id, enabled) => request("watch", { id, enabled }),
  saveSettings: (settings) => request("settings", { settings }),
  openThread: (id, post) => request("open_thread", { id, post }),
  copyRoomId: (id) => request("copy_room_id", { id }),
  launchMahjongSoul: (id) => request("launch", { id }),
  subscribe: (callback) => subscribe<Snapshot>("state", callback),
  getUpdateState: () => invoke<UpdateState>("update_state"),
  checkUpdate: () => invoke("check_update"),
  downloadUpdate: () => invoke("download_update"),
  installUpdate: () => invoke("install_update"),
  openRelease: () => invoke("open_release"),
  subscribeUpdate: (callback) =>
    subscribe<UpdateState>("update-state", callback),
};
