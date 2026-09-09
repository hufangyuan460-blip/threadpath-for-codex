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
  loadMoreTurns: (threadId) => ipcRenderer.invoke("conversation:load-more", threadId),
  searchTurns: (threadId, query) => ipcRenderer.invoke("search:turns", threadId, query),
  startTurn: (threadId, text) => ipcRenderer.invoke("conversation:start-turn", threadId, text),
  onConversationUpdate: (listener) => {
    const handler = (_event: unknown, update: Parameters<typeof listener>[0]): void => listener(update);
    ipcRenderer.on("conversation:update", handler);
    return () => ipcRenderer.removeListener("conversation:update", handler);
  },
};

contextBridge.exposeInMainWorld("threadPath", desktopApi);
