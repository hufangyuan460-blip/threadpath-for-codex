export type ConnectionState = "idle" | "connecting" | "ready" | "error" | "stopped";
export type AppRunMode = "setup" | "history" | "workspace";
export type Language = "zh-CN" | "en-US";

export interface AppInfo {
  readonly version: string;
  readonly language: Language;
}

export type OnboardingState = "detecting" | "found" | "connecting" | "ready" | "error";
export type CodexDiscoverySource = "environment" | "saved" | "path" | "known-install" | "manual";

export interface OnboardingSnapshot {
  readonly state: OnboardingState;
  readonly executablePath?: string;
  readonly version?: string;
  readonly source?: CodexDiscoverySource;
  readonly cwd?: string;
  readonly error?: string;
}

export interface ConnectionStateSnapshot {
  readonly state: ConnectionState;
  readonly mode?: AppRunMode;
  readonly error?: string;
  readonly serverVersion?: string;
  readonly protocolVersion?: string;
  readonly capabilitiesKnown?: boolean;
}

export type HistorySyncState = "idle" | "syncing" | "complete" | "partial" | "failed";

export interface HistorySyncSnapshot {
  readonly state: HistorySyncState;
  readonly threadCount: number;
  readonly missingThreadIds: readonly string[];
  readonly syncedAt?: string;
  readonly error?: string;
}

export interface HistorySyncWorkspaceResult {
  readonly workspace: WorkspaceState;
  readonly snapshot: HistorySyncSnapshot;
}

export interface ThreadListItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly turnCount: number | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly archived?: boolean;
  readonly workspacePath?: string;
  readonly workingDirectory?: string;
  readonly missingFromLatestSnapshot?: boolean;
}

export interface WorkingDirectoryView {
  readonly path: string;
  readonly name: string;
  readonly expanded: boolean;
  readonly threads: readonly ThreadListItem[];
}

export type WorkspaceDirectoryAccess = "read" | "write";
export type WorkspaceSource = "synced" | "user-configured" | "local-organization";
export type WorkspaceApplyState = "not-applied" | "applied" | "verification-failed";

export interface ConfiguredWorkspaceDirectory {
  readonly path: string;
  readonly access: WorkspaceDirectoryAccess;
}

export interface ConfiguredWorkspace {
  readonly id: string;
  readonly primaryDirectory: string;
  readonly additionalDirectories: readonly ConfiguredWorkspaceDirectory[];
  readonly source: WorkspaceSource;
  readonly applyState: WorkspaceApplyState;
}

export interface WorkspaceState {
  readonly currentPath?: string;
  readonly directories: readonly WorkingDirectoryView[];
  readonly unclassifiedThreads: readonly ThreadListItem[];
  readonly configuredWorkspaces: readonly ConfiguredWorkspace[];
  readonly sync: HistorySyncSnapshot;
}

export interface ConversationTurnView {
  readonly id: string;
  readonly index: number;
  readonly status: string;
  readonly createdAt?: string;
  readonly items: readonly ConversationItemView[];
}

export interface ConversationPagingState {
  readonly orderedTurnIds: readonly string[];
  readonly firstItemIndex: number;
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
  readonly loadMoreError?: string;
}

export type ConversationItemView =
  | { readonly kind: "text"; readonly id: string; readonly role: "user" | "assistant" | "system"; readonly text: string; readonly phase: "historical" | "streaming" | "final" }
  | { readonly kind: "tool"; readonly id: string; readonly name: string; readonly status: "running" | "completed" | "failed" | "unknown"; readonly summary?: string }
  | { readonly kind: "status"; readonly id: string; readonly text: string };

export interface ConversationThreadView {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly canAcceptDirectInput?: boolean;
  readonly workspacePath?: string;
  readonly remoteActive?: boolean;
  readonly remoteActiveTurnId?: string;
  readonly writeState?: ThreadWriteState;
  readonly writeStateMessage?: string;
  readonly turns: readonly ConversationTurnView[];
  readonly outline: readonly TurnOutlineEntry[];
  readonly paging: ConversationPagingState;
}

export type ThreadWriteState = "available" | "localTurnRunning" | "externalThreadWriter" | "workspaceLocked" | "stateUnknown" | "inputUnavailable";

export type ThreadDetails = ConversationThreadView;

export interface TurnOutlineEntry {
  readonly turnId: string;
  readonly index: number;
  readonly label: string;
  readonly status: string;
}

export type SearchMatchKind = "title" | "user" | "assistant" | "status";

export interface SearchResult {
  readonly turnId: string;
  readonly index: number;
  readonly label: string;
  readonly snippet: string;
  readonly matchKind: SearchMatchKind;
  readonly score: number;
}

export type ConversationUpdate =
  | { readonly type: "turn/started"; readonly threadId: string; readonly turnId: string }
  | { readonly type: "item/started"; readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly itemType?: string; readonly itemName?: string }
  | { readonly type: "item/agentMessage/delta"; readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly delta: string }
  | { readonly type: "item/completed"; readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly status: "running" | "completed" | "failed" | "unknown"; readonly itemType?: string; readonly itemName?: string; readonly summary?: string }
  | { readonly type: "turn/completed" | "turn/failed" | "turn/interrupted"; readonly threadId: string; readonly turnId: string; readonly message?: string };

export interface StartTurnResult {
  readonly threadId: string;
  readonly turnId: string;
  readonly displayName?: string;
}

export interface StartNewConversationResult extends StartTurnResult {
  readonly workspacePath: string;
}

export interface ThreadDisplayNameUpdate {
  readonly threadId: string;
  readonly title: string;
}

export interface DesktopApi {
  readonly getAppInfo: () => Promise<AppInfo>;
  readonly setLanguage: (language: Language) => Promise<Language>;
  readonly getOnboardingState: () => Promise<OnboardingSnapshot>;
  readonly rediscoverCodex: () => Promise<OnboardingSnapshot>;
  readonly chooseCodexExecutable: () => Promise<OnboardingSnapshot>;
  readonly chooseWorkingDirectory: () => Promise<OnboardingSnapshot>;
  readonly getConnectionState: () => Promise<ConnectionStateSnapshot>;
  readonly connect: () => Promise<ConnectionStateSnapshot>;
  readonly disconnect: () => Promise<ConnectionStateSnapshot>;
  readonly reconnect: () => Promise<ConnectionStateSnapshot>;
  readonly listThreads: () => Promise<ThreadListItem[]>;
  readonly getHistorySyncState: () => Promise<HistorySyncSnapshot>;
  readonly syncHistory: () => Promise<HistorySyncWorkspaceResult>;
  readonly getWorkspaceState: () => Promise<WorkspaceState>;
  readonly onWorkspaceStateChanged: (listener: (state: WorkspaceState) => void) => () => void;
  readonly chooseWorkspaceDirectory: () => Promise<WorkspaceState>;
  readonly setCurrentWorkspace: (path: string) => Promise<WorkspaceState>;
  readonly toggleWorkspace: (path: string) => Promise<WorkspaceState>;
  readonly associateThreadWorkspace: (threadId: string, path: string | null) => Promise<WorkspaceState>;
  readonly setThreadDisplayName: (threadId: string, name: string | null) => Promise<ThreadDisplayNameUpdate>;
  readonly readThread: (threadId: string) => Promise<ThreadDetails>;
  readonly refreshThread: (threadId: string) => Promise<ThreadDetails>;
  readonly loadMoreTurns: (threadId: string) => Promise<ThreadDetails>;
  readonly searchTurns: (threadId: string, query: string) => Promise<SearchResult[]>;
  readonly startTurn: (threadId: string, text: string) => Promise<StartTurnResult>;
  readonly startNewConversation: (workspacePath: string, text: string) => Promise<StartNewConversationResult>;
  readonly onConversationUpdate: (listener: (update: ConversationUpdate) => void) => () => void;
}
