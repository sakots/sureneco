import { contextBridge, ipcRenderer } from "electron";
import type { Api, Snapshot } from "../core/types";
const api: Api = {
  getSnapshot: () => ipcRenderer.invoke("snapshot"),
  refresh: () => ipcRenderer.invoke("refresh"),
  watch: (id, enabled) => ipcRenderer.invoke("watch", id, enabled),
  saveSettings: (settings) => ipcRenderer.invoke("settings", settings),
  openThread: (id, post) => ipcRenderer.invoke("open-thread", id, post),
  subscribe: (callback) => {
    const listener = (_: Electron.IpcRendererEvent, value: Snapshot) =>
      callback(value);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
};
contextBridge.exposeInMainWorld("sureneco", api);
