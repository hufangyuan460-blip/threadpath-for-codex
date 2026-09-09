export type ConnectionStatus = "not-connected";

export interface AppInfo {
  readonly version: string;
}

export interface ConnectionInfo {
  readonly status: ConnectionStatus;
}

export interface DesktopApi {
  readonly getAppInfo: () => Promise<AppInfo>;
  readonly getConnectionInfo: () => Promise<ConnectionInfo>;
}
