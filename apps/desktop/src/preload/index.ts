import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, Language, WorkspaceState } from "../shared/api";

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
  listModels: () => ipcRenderer.invoke("models:list"),
  listThreads: () => ipcRenderer.invoke("threads:list"),
  getHistorySyncState: () => ipcRenderer.invoke("history:get-sync-state"),
  syncHistory: () => ipcRenderer.invoke("history:sync"),
  getWorkspaceState: () => ipcRenderer.invoke("workspace:get-state"),
  onWorkspaceStateChanged: (listener: (state: WorkspaceState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WorkspaceState): void => listener(state);
    ipcRenderer.on("workspace:state-changed", handler);
    return () => ipcRenderer.removeListener("workspace:state-changed", handler);
  },
  chooseWorkspaceDirectory: () => ipcRenderer.invoke("workspace:choose-directory"),
  setCurrentWorkspace: (path) => ipcRenderer.invoke("workspace:set-current", path),
  toggleWorkspace: (path) => ipcRenderer.invoke("workspace:toggle", path),
  setWorkspaceHidden: (path, hidden) => ipcRenderer.invoke("workspace:set-hidden", path, hidden),
  associateThreadWorkspace: (threadId, path) => ipcRenderer.invoke("workspace:associate-thread", threadId, path),
  setThreadDisplayName: (threadId: string, name: string | null) => ipcRenderer.invoke("threads:set-display-name", threadId, name),
  setThreadHidden: (threadId, hidden) => ipcRenderer.invoke("threads:set-hidden", threadId, hidden),
  readThread: (threadId) => ipcRenderer.invoke("threads:read", threadId),
  refreshThread: (threadId) => ipcRenderer.invoke("threads:refresh", threadId),
  loadMoreTurns: (threadId) => ipcRenderer.invoke("conversation:load-more", threadId),
  searchTurns: (threadId, query) => ipcRenderer.invoke("search:turns", threadId, query),
  startTurn: (threadId, text, options) => ipcRenderer.invoke("conversation:start-turn", threadId, text, options),
  interruptTurn: (threadId) => ipcRenderer.invoke("conversation:interrupt", threadId),
  startNewConversation: (workspacePath, text, options) => ipcRenderer.invoke("conversation:start-new", workspacePath, text, options),
  onConversationUpdate: (listener) => {
    const handler = (_event: unknown, update: Parameters<typeof listener>[0]): void => listener(update);
    ipcRenderer.on("conversation:update", handler);
    return () => ipcRenderer.removeListener("conversation:update", handler);
  },
};

contextBridge.exposeInMainWorld("threadPath", desktopApi);
