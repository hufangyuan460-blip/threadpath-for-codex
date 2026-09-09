import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/api";

const desktopApi: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  getConnectionInfo: () => ipcRenderer.invoke("app:get-connection-info"),
};

contextBridge.exposeInMainWorld("threadPath", desktopApi);
