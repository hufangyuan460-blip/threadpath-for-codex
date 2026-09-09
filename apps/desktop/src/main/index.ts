import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexProcessManager, type ConnectionStateSnapshot as ManagerConnectionState } from "./codex-process-manager";
import { ThreadService } from "./thread-service";
import { ConversationService } from "./conversation-service";
import type { AppInfo, ConnectionStateSnapshot } from "../shared/api";
import { ProcessError } from "../../../../threadpath-protocol/src/protocol.ts";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
let isQuitting = false;
const processManager = new CodexProcessManager({
  cwd: process.env.CODEX_CWD ?? process.cwd(),
  executable: process.env.CODEX_EXECUTABLE?.trim() || undefined,
  onStateChange: ({ state }) => console.log(`[desktop] connection state: ${state}`),
});
const threadService = new ThreadService(processManager);
const conversationService = new ConversationService(processManager);

function publicConnectionState(snapshot: ManagerConnectionState): ConnectionStateSnapshot {
  return {
    state: snapshot.state,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    ...(snapshot.serverVersion === undefined ? {} : { serverVersion: snapshot.serverVersion }),
    ...(snapshot.protocolVersion === undefined ? {} : { protocolVersion: snapshot.protocolVersion }),
    ...(snapshot.capabilities === undefined ? {} : { capabilitiesKnown: snapshot.capabilities.known }),
  };
}

function registerApi(): void {
  ipcMain.handle("app:get-info", (): AppInfo => ({ version: app.getVersion() }));
  ipcMain.handle("app:get-connection-state", (): ConnectionStateSnapshot => publicConnectionState(processManager.getConnectionState()));
  ipcMain.handle("app:connect", async (): Promise<ConnectionStateSnapshot> => publicConnectionState(await processManager.connect()));
  ipcMain.handle("app:disconnect", async (): Promise<ConnectionStateSnapshot> => publicConnectionState(await processManager.disconnect()));
  ipcMain.handle("app:reconnect", async (): Promise<ConnectionStateSnapshot> => publicConnectionState(await processManager.reconnect()));
  ipcMain.handle("threads:list", async () => withReadyConnection(() => threadService.listThreads()));
  ipcMain.handle("threads:read", async (_event, threadId: unknown) => withReadyConnection(() => conversationService.readThread(threadId)));
  ipcMain.handle("search:turns", async (_event, threadId: unknown, query: unknown) => withReadyConnection(() => conversationService.searchTurns(threadId, query)));
  ipcMain.handle("conversation:start-turn", async (_event, threadId: unknown, text: unknown) => withReadyConnection(() => conversationService.startTurn(threadId, text)));
  conversationService.onConversationUpdate((update) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("conversation:update", update);
  });
}

async function withReadyConnection<T>(action: () => Promise<T>): Promise<T> {
  const state = await processManager.connect();
  if (state.state !== "ready") throw new ProcessError(state.error ?? "Codex app-server is not ready");
  return action();
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    webPreferences: {
      preload: join(currentDirectory, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(currentDirectory, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerApi();
  createWindow();
  void processManager.connect();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  void processManager.disconnect().finally(() => app.quit());
});
