import { contextBridge, ipcRenderer } from "electron";
import type { Api, Snapshot, UpdateState } from "../core/types";
const api: Api = {
  getUpdateState: () => ipcRenderer.invoke("update-state"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  openRelease: () => ipcRenderer.invoke("open-release"),
  subscribeUpdate: (callback) => {
    const listener = (_: Electron.IpcRendererEvent, value: UpdateState) =>
      callback(value);
    ipcRenderer.on("update-state", listener);
    return () => ipcRenderer.removeListener("update-state", listener);
  },
  getSnapshot: () => ipcRenderer.invoke("snapshot"),
  refresh: () => ipcRenderer.invoke("refresh"),
  watch: (id, enabled) => ipcRenderer.invoke("watch", id, enabled),
  saveSettings: (settings) => ipcRenderer.invoke("settings", settings),
  openThread: (id, post) => ipcRenderer.invoke("open-thread", id, post),
  copyRoomId: (id) => ipcRenderer.invoke("copy-room-id", id),
  launchMahjongSoul: (id) => ipcRenderer.invoke("launch-mahjong-soul", id),
  subscribe: (callback) => {
    const listener = (_: Electron.IpcRendererEvent, value: Snapshot) =>
      callback(value);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
};
contextBridge.exposeInMainWorld("sureneco", api);
