import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, Language } from "../shared/api";

const desktopApi: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  setLanguage: (language: Language) => ipcRenderer.invoke("app:set-language", language),
  getOnboardingState: () => ipcRenderer.invoke("onboarding:get-state"),
  rediscoverCodex: () => ipcRenderer.invoke("onboarding:rediscover"),
  chooseCodexExecutable: () => ipcRenderer.invoke("onboarding:choose-executable"),
  chooseWorkingDirectory: () => ipcRenderer.invoke("onboarding:choose-directory"),
  getConnectionState: () => ipcRenderer.invoke("app:get-connection-state"),
  connect: () => ipcRenderer.invoke("app:connect"),
  disconnect: () => ipcRenderer.invoke("app:disconnect"),
  reconnect: () => ipcRenderer.invoke("app:reconnect"),
  listThreads: () => ipcRenderer.invoke("threads:list"),
  setThreadDisplayName: (threadId: string, name: string | null) => ipcRenderer.invoke("threads:set-display-name", threadId, name),
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
