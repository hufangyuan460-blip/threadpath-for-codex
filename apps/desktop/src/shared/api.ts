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

export interface DesktopApi {
  readonly getAppInfo: () => Promise<AppInfo>;
  readonly getConnectionState: () => Promise<ConnectionStateSnapshot>;
  readonly connect: () => Promise<ConnectionStateSnapshot>;
  readonly disconnect: () => Promise<ConnectionStateSnapshot>;
  readonly reconnect: () => Promise<ConnectionStateSnapshot>;
}
