export type ConnectionState = "idle" | "connecting" | "ready" | "error" | "stopped";

export interface AppInfo {
  readonly version: string;
}

export interface ConnectionStateSnapshot {
  readonly state: ConnectionState;
  readonly error?: string;
  readonly serverVersion?: string;
  readonly protocolVersion?: string;
  readonly capabilitiesKnown?: boolean;
}

export interface ThreadListItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly turnCount: number | null;
  readonly createdAt?: string;
}

export interface ConversationTurnView {
  readonly id: string;
  readonly index: number;
  readonly status: string;
  readonly createdAt?: string;
  readonly items: readonly ConversationItemView[];
}

export type ConversationItemView =
  | { readonly kind: "text"; readonly id: string; readonly role: "user" | "assistant" | "system"; readonly text: string }
  | { readonly kind: "tool"; readonly id: string; readonly name: string; readonly status: "running" | "completed" | "failed" | "unknown"; readonly summary?: string }
  | { readonly kind: "status"; readonly id: string; readonly text: string };

export interface ConversationThreadView {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly turns: readonly ConversationTurnView[];
}

export type ThreadDetails = ConversationThreadView;

export interface DesktopApi {
  readonly getAppInfo: () => Promise<AppInfo>;
  readonly getConnectionState: () => Promise<ConnectionStateSnapshot>;
  readonly connect: () => Promise<ConnectionStateSnapshot>;
  readonly disconnect: () => Promise<ConnectionStateSnapshot>;
  readonly reconnect: () => Promise<ConnectionStateSnapshot>;
  readonly listThreads: () => Promise<ThreadListItem[]>;
  readonly readThread: (threadId: string) => Promise<ThreadDetails>;
}
