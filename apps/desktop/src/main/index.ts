import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexProcessManager, type ConnectionStateSnapshot as ManagerConnectionState } from "./codex-process-manager";
import { CodexDiscoveryService, selectedDialogPath, type CodexDiscoveryResult } from "./codex-discovery";
import { ThreadService } from "./thread-service";
import { ConversationService } from "./conversation-service";
import { validateThreadId } from "./thread-service";
import { UserPreferencesService, firstReadableUserText } from "./user-preferences";
import { AppServerError, ProcessError, ThreadUnavailableError } from "../../../../threadpath-protocol/src/protocol.ts";
import type { AppInfo, ConnectionStateSnapshot, Language, OnboardingSnapshot, ThreadDisplayNameUpdate } from "../shared/api";

if (process.env.THREADPATH_E2E === "1") app.disableHardwareAcceleration();

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
let isQuitting = false;
let processManager: CodexProcessManager;
let discoveryService: CodexDiscoveryService;
let threadService: ThreadService;
let conversationService: ConversationService;
let preferencesService: UserPreferencesService;
let onboardingSnapshot: OnboardingSnapshot = { state: "detecting" };

function publicConnectionState(snapshot: ManagerConnectionState): ConnectionStateSnapshot {
  return {
    state: snapshot.state,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    ...(snapshot.serverVersion === undefined ? {} : { serverVersion: snapshot.serverVersion }),
    ...(snapshot.protocolVersion === undefined ? {} : { protocolVersion: snapshot.protocolVersion }),
    ...(snapshot.capabilities === undefined ? {} : { capabilitiesKnown: snapshot.capabilities.known }),
  };
}

function setOnboardingSnapshot(snapshot: OnboardingSnapshot): void {
  onboardingSnapshot = snapshot;
}

function publicDiscoveryResult(result: CodexDiscoveryResult, state: OnboardingSnapshot["state"]): OnboardingSnapshot {
  return {
    state,
    executablePath: result.executablePath,
    version: result.version,
    source: result.source,
    ...(result.cwd === undefined ? {} : { cwd: result.cwd }),
  };
}

async function applyDiscoveryResult(result: CodexDiscoveryResult): Promise<OnboardingSnapshot> {
  processManager.configure({ cwd: result.cwd ?? "", executable: result.executablePath });
  const found = publicDiscoveryResult(result, result.cwd === undefined ? "found" : "connecting");
  setOnboardingSnapshot(found);
  if (result.cwd === undefined) return found;
  const connection = await processManager.connect();
  if (connection.state === "ready") {
    const ready = publicDiscoveryResult(result, "ready");
    setOnboardingSnapshot(ready);
    return ready;
  }
  const error = connection.error ?? "Codex app-server could not be started";
  const failed: OnboardingSnapshot = { ...publicDiscoveryResult(result, "error"), error };
  setOnboardingSnapshot(failed);
  return failed;
}

async function discoverCodex(): Promise<OnboardingSnapshot> {
  setOnboardingSnapshot({ state: "detecting" });
  try {
    if (processManager.getConnectionState().state === "ready") await processManager.disconnect();
    return await applyDiscoveryResult(await discoveryService.discover());
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const failed: OnboardingSnapshot = { state: "error", error: message };
    setOnboardingSnapshot(failed);
    processManager.reportError(error instanceof AppServerError ? error : new ProcessError(message));
    return failed;
  }
}

async function chooseCodexExecutable(): Promise<OnboardingSnapshot> {
  const selection = await dialog.showOpenDialog({
    title: "Choose Codex CLI",
    properties: ["openFile"],
    filters: [{ name: "Codex CLI", extensions: ["exe", "cmd", "bat"] }],
  });
  const selectedPath = selectedDialogPath(selection.canceled, selection.filePaths);
  if (selectedPath === undefined) return onboardingSnapshot;
  try {
    return await applyDiscoveryResult(await discoveryService.selectExecutable(selectedPath));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const failed: OnboardingSnapshot = { ...onboardingSnapshot, state: "error", error: message };
    setOnboardingSnapshot(failed);
    return failed;
  }
}

async function chooseWorkingDirectory(): Promise<OnboardingSnapshot> {
  const selection = await dialog.showOpenDialog({ title: "Choose working directory", properties: ["openDirectory", "createDirectory"] });
  const selectedPath = selectedDialogPath(selection.canceled, selection.filePaths);
  if (selectedPath === undefined) return onboardingSnapshot;
  try {
    const cwd = await discoveryService.selectWorkingDirectory(selectedPath);
    const executablePath = onboardingSnapshot.executablePath;
    if (executablePath === undefined) throw new ProcessError("Choose a Codex CLI before selecting a working directory");
    return await applyDiscoveryResult({ executablePath, version: onboardingSnapshot.version ?? "unknown", source: onboardingSnapshot.source ?? "manual", cwd });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const failed: OnboardingSnapshot = { ...onboardingSnapshot, state: "error", error: message };
    setOnboardingSnapshot(failed);
    return failed;
  }
}

function localizeThreadView<T extends { id: string; title: string; turns?: readonly { items: readonly { kind: string; role?: string; text?: string }[] }[] }>(thread: T): T {
  return { ...thread, title: preferencesService.getThreadDisplayName(thread.id, thread.title, firstReadableUserText(thread.turns)) };
}

function registerApi(): void {
  ipcMain.handle("app:get-info", (): AppInfo => ({ version: app.getVersion(), language: preferencesService.getLanguage() }));
  ipcMain.handle("app:set-language", async (_event, language: unknown): Promise<Language> => {
    if (language !== "zh-CN" && language !== "en-US") throw new ProcessError("language must be zh-CN or en-US");
    return preferencesService.setLanguage(language);
  });
  ipcMain.handle("onboarding:get-state", (): OnboardingSnapshot => onboardingSnapshot);
  ipcMain.handle("onboarding:rediscover", async (): Promise<OnboardingSnapshot> => discoverCodex());
  ipcMain.handle("onboarding:choose-executable", async (): Promise<OnboardingSnapshot> => chooseCodexExecutable());
  ipcMain.handle("onboarding:choose-directory", async (): Promise<OnboardingSnapshot> => chooseWorkingDirectory());
  ipcMain.handle("app:get-connection-state", (): ConnectionStateSnapshot => publicConnectionState(processManager.getConnectionState()));
  ipcMain.handle("app:connect", async (): Promise<ConnectionStateSnapshot> => {
    const state = await processManager.connect();
    if (state.state === "ready" && onboardingSnapshot.executablePath !== undefined && onboardingSnapshot.cwd !== undefined) setOnboardingSnapshot({ ...onboardingSnapshot, state: "ready", error: undefined });
    else if (state.state !== "ready") setOnboardingSnapshot({ ...onboardingSnapshot, state: "error", error: state.error ?? "Codex app-server could not be started" });
    return publicConnectionState(state);
  });
  ipcMain.handle("app:disconnect", async (): Promise<ConnectionStateSnapshot> => publicConnectionState(await processManager.disconnect()));
  ipcMain.handle("app:reconnect", async (): Promise<ConnectionStateSnapshot> => {
    const state = await processManager.reconnect();
    if (state.state === "ready" && onboardingSnapshot.executablePath !== undefined && onboardingSnapshot.cwd !== undefined) setOnboardingSnapshot({ ...onboardingSnapshot, state: "ready", error: undefined });
    else if (state.state !== "ready") setOnboardingSnapshot({ ...onboardingSnapshot, state: "error", error: state.error ?? "Codex app-server could not be started" });
    return publicConnectionState(state);
  });
  ipcMain.handle("threads:list", async () => withReadyConnection(() => threadService.listThreads()));
  ipcMain.handle("threads:set-display-name", async (_event, threadId: unknown, name: unknown): Promise<ThreadDisplayNameUpdate> => {
    const validThreadId = validateThreadId(threadId);
    if (name !== null && typeof name !== "string") throw new ProcessError("thread display name must be plain text or null");
    const threads = await withReadyConnection(() => threadService.listThreads());
    const existing = threads.find((thread) => thread.id === validThreadId);
    if (existing === undefined) throw new ThreadUnavailableError();
    const serverThread = await threadService.getServerThread(validThreadId);
    await preferencesService.setThreadDisplayName(validThreadId, name);
    const loaded = conversationService.getLoadedThread(validThreadId);
    return { threadId: validThreadId, title: preferencesService.getThreadDisplayName(validThreadId, serverThread?.title, firstReadableUserText(loaded?.turns)) };
  });
  ipcMain.handle("threads:read", async (_event, threadId: unknown) => withReadyConnection(async () => localizeThreadView(await conversationService.readThread(threadId))));
  ipcMain.handle("conversation:load-more", async (_event, threadId: unknown) => withReadyConnection(async () => localizeThreadView(await conversationService.loadMoreTurns(threadId))));
  ipcMain.handle("search:turns", async (_event, threadId: unknown, query: unknown) => withReadyConnection(() => conversationService.searchTurns(threadId, query)));
  ipcMain.handle("conversation:start-turn", async (_event, threadId: unknown, text: unknown) => withReadyConnection(async () => {
    const result = await conversationService.startTurn(threadId, text);
    const validText = typeof text === "string" ? text : undefined;
    const loaded = conversationService.getLoadedThread(result.threadId);
    return { ...result, displayName: preferencesService.getThreadDisplayName(result.threadId, loaded?.title, firstReadableUserText(loaded?.turns) ?? validText) };
  }));
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
    backgroundColor: "#101318",
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? {} : {
      titleBarOverlay: {
        color: "#101318",
        symbolColor: "#e8edf5",
        height: 32,
      },
    }),
    webPreferences: {
      preload: join(currentDirectory, "../preload/index.cjs"),
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

app.whenReady().then(async () => {
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  discoveryService = new CodexDiscoveryService({
    configPath: join(app.getPath("userData"), "threadpath-config.json"),
    env: process.env,
    platform: process.platform,
  });
  processManager = new CodexProcessManager({
    cwd: "",
    executable: undefined,
    onStateChange: ({ state }) => console.log(`[desktop] connection state: ${state}`),
  });
  const locale = process.env.THREADPATH_E2E_LANGUAGE ?? app.getLocale();
  preferencesService = new UserPreferencesService(join(app.getPath("userData"), "threadpath-ui.json"), locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US");
  await preferencesService.load();
  threadService = new ThreadService(processManager, preferencesService);
  conversationService = new ConversationService(processManager);
  registerApi();
  createWindow();
  void discoverCodex();
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
