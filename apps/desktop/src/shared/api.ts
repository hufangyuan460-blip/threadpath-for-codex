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

export type ThreadDetails = ThreadListItem;

export interface DesktopApi {
  readonly getAppInfo: () => Promise<AppInfo>;
  readonly getConnectionState: () => Promise<ConnectionStateSnapshot>;
  readonly connect: () => Promise<ConnectionStateSnapshot>;
  readonly disconnect: () => Promise<ConnectionStateSnapshot>;
  readonly reconnect: () => Promise<ConnectionStateSnapshot>;
  readonly listThreads: () => Promise<ThreadListItem[]>;
  readonly readThread: (threadId: string) => Promise<ThreadDetails>;
}
