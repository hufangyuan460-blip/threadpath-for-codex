import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/api";

const desktopApi: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  getConnectionState: () => ipcRenderer.invoke("app:get-connection-state"),
  connect: () => ipcRenderer.invoke("app:connect"),
  disconnect: () => ipcRenderer.invoke("app:disconnect"),
  reconnect: () => ipcRenderer.invoke("app:reconnect"),
  listThreads: () => ipcRenderer.invoke("threads:list"),
  readThread: (threadId) => ipcRenderer.invoke("threads:read", threadId),
};

contextBridge.exposeInMainWorld("threadPath", desktopApi);
