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
  readonly outline: readonly TurnOutlineEntry[];
}

export type ThreadDetails = ConversationThreadView;

export interface TurnOutlineEntry {
  readonly turnId: string;
  readonly index: number;
  readonly label: string;
  readonly status: string;
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
}

export interface DesktopApi {
  readonly getAppInfo: () => Promise<AppInfo>;
  readonly getConnectionState: () => Promise<ConnectionStateSnapshot>;
  readonly connect: () => Promise<ConnectionStateSnapshot>;
  readonly disconnect: () => Promise<ConnectionStateSnapshot>;
  readonly reconnect: () => Promise<ConnectionStateSnapshot>;
  readonly listThreads: () => Promise<ThreadListItem[]>;
  readonly readThread: (threadId: string) => Promise<ThreadDetails>;
  readonly startTurn: (threadId: string, text: string) => Promise<StartTurnResult>;
  readonly onConversationUpdate: (listener: (update: ConversationUpdate) => void) => () => void;
}
