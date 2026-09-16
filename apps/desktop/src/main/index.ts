import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexProcessManager, type ConnectionStateSnapshot as ManagerConnectionState } from "./codex-process-manager";
import { CodexDiscoveryService, selectedDialogPath, type CodexDiscoveryResult } from "./codex-discovery";
import { ThreadService } from "./thread-service";
import { ConversationService } from "./conversation-service";
import { validateThreadId } from "./thread-service";
import { UserPreferencesService, firstReadableUserText } from "./user-preferences";
import { WorkspaceService, validateWorkspacePath } from "./workspace-service";
import { CodexHistorySyncService } from "./history-sync-service";
import { WorkspaceLockService } from "./workspace-lock-service";
import { AppServerError, ProcessError, ThreadUnavailableError } from "../../../../threadpath-protocol/src/protocol.ts";
import type { AppInfo, AppRunMode, ConnectionStateSnapshot, ConversationThreadView, Language, OnboardingSnapshot, ThreadDisplayNameUpdate, ThreadWriteState } from "../shared/api";

if (process.env.THREADPATH_E2E === "1") app.disableHardwareAcceleration();

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
let isQuitting = false;
let processManager: CodexProcessManager;
let discoveryService: CodexDiscoveryService;
let threadService: ThreadService;
let conversationService: ConversationService;
let preferencesService: UserPreferencesService;
let onboardingSnapshot: OnboardingSnapshot = { state: "detecting" };
let workspaceService: WorkspaceService;
let historySyncService: CodexHistorySyncService;
let workspaceLockService: WorkspaceLockService;
let appRunMode: AppRunMode = "setup";
let historyRuntimeDirectory: string;

function publicConnectionState(snapshot: ManagerConnectionState): ConnectionStateSnapshot {
  return {
    state: snapshot.state,
    mode: appRunMode,
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
  const cwd = result.cwd ?? historyRuntimeDirectory;
  await mkdir(cwd, { recursive: true });
  processManager.configure({ cwd, executable: result.executablePath });
  appRunMode = result.cwd === undefined ? "history" : "workspace";
  if (result.cwd !== undefined) {
    await workspaceService.identityResolver.resolve(result.cwd);
    await preferencesService.addWorkingDirectory(result.cwd);
  }
  const found = publicDiscoveryResult(result, "connecting");
  setOnboardingSnapshot(found);
  const connection = await processManager.connect();
  if (connection.state === "ready") {
    const ready = publicDiscoveryResult(result, "ready");
    setOnboardingSnapshot(ready);
    return ready;
  }
  const error = connection.error ?? "Codex app-server could not be started";
  const failed: OnboardingSnapshot = { ...publicDiscoveryResult(result, "error"), error };
  appRunMode = "setup";
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
    appRunMode = "setup";
    setOnboardingSnapshot(failed);
    processManager.reportError(error instanceof AppServerError ? error : new ProcessError(message));
    return failed;
  }
}

async function activateWorkspace(path: string): Promise<void> {
  const executable = onboardingSnapshot.executablePath;
  if (executable === undefined) throw new ProcessError("Choose a Codex CLI before selecting a working directory");
  await workspaceService.identityResolver.resolve(path);
  if (processManager.getConnectionState().state === "ready") await processManager.disconnect();
  processManager.configure({ cwd: path, executable });
  const state = await processManager.connect();
  if (state.state !== "ready") {
    appRunMode = "history";
    throw new ProcessError(state.error ?? "Codex app-server could not be started for this workspace");
  }
  appRunMode = "workspace";
  setOnboardingSnapshot({ ...onboardingSnapshot, state: "ready", cwd: path, error: undefined });
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

async function localizeThreadView<T extends { id: string; title: string; turns?: readonly { items: readonly { kind: string; role?: string; text?: string }[] }[]; remoteActive?: boolean; canAcceptDirectInput?: boolean; workspacePath?: string }>(thread: T): Promise<T> {
  const writeState = await getWriteState(thread);
  return { ...thread, title: preferencesService.getThreadDisplayName(thread.id, thread.title, firstReadableUserText(thread.turns)), writeState };
}

async function getWriteState(thread: { id: string; remoteActive?: boolean; canAcceptDirectInput?: boolean; workspacePath?: string }): Promise<ThreadWriteState> {
  const path = preferencesService.getThreadWorkingDirectory(thread.id) ?? thread.workspacePath;
  const identity = path === undefined ? undefined : await workspaceService.identityResolver.resolve(path);
  const key = identity?.key;
  if (thread.canAcceptDirectInput === false) return "inputUnavailable";
  if (thread.remoteActive === true) {
    workspaceLockService.markExternal(thread.id, key);
    return key === undefined ? "externalThreadWriter" : workspaceLockService.state(thread.id, key);
  }
  if (key === undefined) return "stateUnknown";
  workspaceLockService.clearExternal(thread.id);
  return workspaceLockService.state(thread.id, key);
}

async function getSyncedThreads() {
  let result;
  try { result = await historySyncService.sync(); }
  catch (error: unknown) {
    return { threads: threadService.mapThreads(historySyncService.getMirrorThreads()), snapshot: historySyncService.getSnapshot() };
  }
  const threads = threadService.mapThreads(result.threads).map((thread) => result.snapshot.missingThreadIds.includes(thread.id) ? { ...thread, missingFromLatestSnapshot: true } : thread);
  return { threads, snapshot: result.snapshot };
}

async function getWorkspaceState() {
  const result = historySyncService.getCurrentResult();
  const threads = threadService.mapThreads(result.threads).map((thread) => result.snapshot.missingThreadIds.includes(thread.id) ? { ...thread, missingFromLatestSnapshot: true } : thread);
  return workspaceService.getState(threads, result.snapshot);
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
  ipcMain.handle("threads:list", async () => {
    const result = historySyncService.getCurrentResult();
    return threadService.mapThreads(result.threads);
  });
  ipcMain.handle("history:get-sync-state", (): ReturnType<CodexHistorySyncService["getSnapshot"]> => historySyncService.getSnapshot());
  ipcMain.handle("history:sync", async () => {
    const result = await withReadyConnection(getSyncedThreads);
    const workspace = await workspaceService.getState(result.threads, result.snapshot);
    return { workspace, snapshot: result.snapshot };
  });
  ipcMain.handle("workspace:get-state", async () => getWorkspaceState());
  ipcMain.handle("workspace:set-current", async (_event, path: unknown) => {
    const validPath = await validateWorkspacePath(path, workspaceService.identityResolver);
    await workspaceService.setCurrent(validPath);
    if (appRunMode === "history") await activateWorkspace(validPath);
    return getWorkspaceState();
  });
  ipcMain.handle("workspace:toggle", async (_event, path: unknown) => {
    await workspaceService.toggle(path);
    return getWorkspaceState();
  });
  ipcMain.handle("workspace:associate-thread", async (_event, threadId: unknown, path: unknown) => {
    const validThreadId = validateThreadId(threadId);
    if (path === null || path === undefined) await workspaceService.associateThread(validThreadId, path);
    else {
      const validPath = await validateWorkspacePath(path, workspaceService.identityResolver);
      await workspaceService.associateThread(validThreadId, validPath);
      if (appRunMode === "history") await activateWorkspace(validPath);
    }
    return getWorkspaceState();
  });
  ipcMain.handle("workspace:choose-directory", async () => {
    const selection = await dialog.showOpenDialog({ title: "Choose workspace directory", properties: ["openDirectory", "createDirectory"] });
    const selectedPath = selectedDialogPath(selection.canceled, selection.filePaths);
    if (selectedPath !== undefined) {
      await workspaceService.addDirectory(selectedPath);
      await workspaceService.setCurrent(selectedPath);
      await activateWorkspace(await validateWorkspacePath(selectedPath, workspaceService.identityResolver));
    }
    return getWorkspaceState();
  });
  ipcMain.handle("threads:set-display-name", async (_event, threadId: unknown, name: unknown): Promise<ThreadDisplayNameUpdate> => {
    const validThreadId = validateThreadId(threadId);
    if (name !== null && typeof name !== "string") throw new ProcessError("thread display name must be plain text or null");
    const threads = threadService.mapThreads(historySyncService.getCurrentResult().threads);
    const existing = threads.find((thread) => thread.id === validThreadId);
    if (existing === undefined) throw new ThreadUnavailableError();
    const serverThread = await threadService.getServerThread(validThreadId);
    await preferencesService.setThreadDisplayName(validThreadId, name);
    const loaded = conversationService.getLoadedThread(validThreadId);
    return { threadId: validThreadId, title: preferencesService.getThreadDisplayName(validThreadId, serverThread?.title, firstReadableUserText(loaded?.turns)) };
  });
  ipcMain.handle("threads:read", async (_event, threadId: unknown) => withReadyConnection(async () => localizeThreadView(await conversationService.readThread(threadId))));
  ipcMain.handle("threads:refresh", async (_event, threadId: unknown) => withReadyConnection(async () => localizeThreadView(await conversationService.readThread(threadId))));
  ipcMain.handle("conversation:load-more", async (_event, threadId: unknown) => withReadyConnection(async () => localizeThreadView(await conversationService.loadMoreTurns(threadId))));
  ipcMain.handle("search:turns", async (_event, threadId: unknown, query: unknown) => withReadyConnection(() => conversationService.searchTurns(threadId, query)));
  ipcMain.handle("conversation:start-turn", async (_event, threadId: unknown, text: unknown) => withReadyConnection(async () => {
    if (appRunMode !== "workspace") throw new ProcessError("Confirm a working directory before sending.");
    const validThreadId = validateThreadId(threadId);
    const refreshed = await conversationService.readThread(validThreadId);
    if (refreshed.remoteActive) {
      workspaceLockService.markExternal(validThreadId);
      throw new AppServerError("This conversation is already responding. Refresh its status before sending another message.", "server", "active_writer");
    }
    const workspacePath = preferencesService.getThreadWorkingDirectory(validThreadId) ?? refreshed.workspacePath;
    const workspaceKey = workspacePath === undefined ? undefined : (await workspaceService.identityResolver.resolve(workspacePath))?.key;
    if (workspaceKey === undefined) throw new ProcessError("Workspace state is unknown; refresh before sending.");
    workspaceLockService.acquire(validThreadId, workspaceKey);
    let result;
    try { result = await conversationService.startTurn(validThreadId, text); }
    catch (error: unknown) {
      if (error instanceof AppServerError && error.code === "active_writer") workspaceLockService.markExternal(validThreadId, workspaceKey);
      else workspaceLockService.release(validThreadId);
      throw error;
    }
    const validText = typeof text === "string" ? text : undefined;
    const loaded = conversationService.getLoadedThread(result.threadId);
    return { ...result, displayName: preferencesService.getThreadDisplayName(result.threadId, loaded?.title, firstReadableUserText(loaded?.turns) ?? validText) };
  }));
  ipcMain.handle("conversation:start-new", async (_event, workspacePath: unknown, text: unknown) => withReadyConnection(async () => {
    if (appRunMode !== "workspace") throw new ProcessError("Confirm a working directory before sending.");
    const path = await validateWorkspacePath(workspacePath, workspaceService.identityResolver);
    await workspaceService.setCurrent(path);
    const workspaceKey = (await workspaceService.identityResolver.resolve(path))?.key;
    if (workspaceKey === undefined) throw new ProcessError("Workspace state is unknown; refresh before sending.");
    const reservationId = `new-conversation:${workspaceKey}`;
    workspaceLockService.reserveWorkspace(reservationId, workspaceKey);
    let result;
    try { result = await conversationService.startNewConversation(path, text); }
    catch (error: unknown) { workspaceLockService.release(reservationId); throw error; }
    workspaceLockService.transfer(reservationId, result.threadId);
    await workspaceService.associateThread(result.threadId, path);
    const loaded = conversationService.getLoadedThread(result.threadId);
    return { ...result, workspacePath: path, displayName: preferencesService.getThreadDisplayName(result.threadId, loaded?.title, firstReadableUserText(loaded?.turns) ?? (typeof text === "string" ? text : undefined)) };
  }));
  conversationService.onConversationUpdate((update) => {
    const loaded = conversationService.getLoadedThread(update.threadId);
    const activityPath = preferencesService.getThreadWorkingDirectory(update.threadId) ?? loaded?.workspacePath;
    void (async () => {
      const activityKey = activityPath === undefined ? undefined : (await workspaceService.identityResolver.resolve(activityPath))?.key;
      if (update.type === "turn/started") workspaceLockService.markExternal(update.threadId, activityKey);
      if (update.type === "turn/completed" || update.type === "turn/failed" || update.type === "turn/interrupted") workspaceLockService.release(update.threadId);
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("conversation:update", update);
    })();
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
  historyRuntimeDirectory = join(app.getPath("userData"), "history-runtime");
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
  workspaceService = new WorkspaceService({ preferences: preferencesService });
  workspaceService.identityResolver.onResolved(() => {
    void getWorkspaceState().then((state) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("workspace:state-changed", state);
    });
  });
  threadService = new ThreadService(processManager, preferencesService);
  conversationService = new ConversationService(processManager);
  historySyncService = new CodexHistorySyncService(processManager, preferencesService);
  workspaceLockService = new WorkspaceLockService();
  registerApi();
  createWindow();
  void discoverCodex();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("browser-window-focus", () => { if (processManager.getConnectionState().state === "ready") void historySyncService.sync(); });
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
