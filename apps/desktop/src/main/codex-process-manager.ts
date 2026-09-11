import { existsSync, statSync } from "node:fs";
import { AppServerError, ConfigurationError, ProcessError, type AppServerCapabilities, type InitializeResult } from "../../../../threadpath-protocol/src/protocol.ts";
import { AppServerClient } from "../../../../threadpath-protocol/src/app-server-client.ts";

export type ConnectionState = "idle" | "connecting" | "ready" | "error" | "stopped";

export interface ConnectionStateSnapshot {
  readonly state: ConnectionState;
  readonly error?: string;
  readonly serverVersion?: string;
  readonly protocolVersion?: string;
  readonly capabilities?: AppServerCapabilities;
}

export interface CodexProcessManagerOptions {
  readonly cwd: string;
  readonly executable?: string;
  readonly requestTimeoutMs?: number;
  readonly onStateChange?: (snapshot: ConnectionStateSnapshot) => void;
}

export class CodexProcessManager {
  private options: CodexProcessManagerOptions;
  private client: AppServerClient | undefined;
  private connectionAttempt: Promise<ConnectionStateSnapshot> | undefined;
  private snapshot: ConnectionStateSnapshot = { state: "idle" };

  constructor(options: CodexProcessManagerOptions) {
    this.options = options;
  }

  configure(configuration: Pick<CodexProcessManagerOptions, "cwd" | "executable">): void {
    if (this.snapshot.state === "connecting" || this.snapshot.state === "ready") throw new ProcessError("Cannot change Codex configuration while connected");
    this.options = { ...this.options, ...configuration };
  }

  getConnectionState(): ConnectionStateSnapshot {
    return this.snapshot;
  }

  reportError(error: AppServerError): ConnectionStateSnapshot {
    this.setError(error);
    return this.snapshot;
  }

  getReadyClient(): AppServerClient {
    if (this.snapshot.state !== "ready" || this.client === undefined) throw new ProcessError(this.snapshot.error ?? "Codex app-server is not ready");
    return this.client;
  }

  async connect(): Promise<ConnectionStateSnapshot> {
    if (this.snapshot.state === "ready") return this.snapshot;
    if (this.connectionAttempt !== undefined) return this.connectionAttempt;
    const attempt = this.connectInternal();
    this.connectionAttempt = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connectionAttempt === attempt) this.connectionAttempt = undefined;
    }
  }

  async disconnect(): Promise<ConnectionStateSnapshot> {
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) await client.close();
    this.setSnapshot({ state: "stopped" });
    return this.snapshot;
  }

  async reconnect(): Promise<ConnectionStateSnapshot> {
    await this.disconnect();
    return this.connect();
  }

  private async connectInternal(): Promise<ConnectionStateSnapshot> {
    this.setSnapshot({ state: "connecting" });
    let client: AppServerClient | undefined;
    try {
      this.validateConfiguration();
      const executable = this.options.executable?.trim() || "codex";
      client = new AppServerClient({
        cwd: this.options.cwd,
        executable,
        ...(process.platform === "win32" && /\.(cmd|bat)$/i.test(executable) ? { shell: true } : {}),
        requestTimeoutMs: this.options.requestTimeoutMs,
        onFatalError: (error) => {
          if (this.client === client) this.setError(error);
        },
      });
      this.client = client;
      const initialized = await client.initialize();
      if (this.client !== client) return this.snapshot;
      this.setSnapshot({ state: "ready", ...this.connectionInfo(initialized) });
      return this.snapshot;
    } catch (error: unknown) {
      if (client !== undefined) await client.close();
      if (this.client === client) this.client = undefined;
      const appServerError = error instanceof AppServerError
        ? error
        : new ProcessError(error instanceof Error ? error.message : String(error));
      this.setError(appServerError);
      return this.snapshot;
    }
  }

  private validateConfiguration(): void {
    const cwd = this.options.cwd.trim();
    if (cwd === "") throw new ConfigurationError("Codex working directory is empty");
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new ConfigurationError(`Codex working directory does not exist: ${cwd}`);
    const executable = this.options.executable?.trim() || "codex";
    const isPath = executable.includes("\\") || executable.includes("/") || executable.toLowerCase().endsWith(".exe");
    if (isPath && (!existsSync(executable) || statSync(executable).isDirectory())) throw new ConfigurationError(`Codex executable does not exist: ${executable}`);
  }

  private connectionInfo(initialized: InitializeResult): Omit<ConnectionStateSnapshot, "state"> {
    return {
      ...(initialized.serverVersion === undefined ? {} : { serverVersion: initialized.serverVersion }),
      ...(initialized.protocolVersion === undefined ? {} : { protocolVersion: initialized.protocolVersion }),
      capabilities: initialized.capabilities,
    };
  }

  private setError(error: AppServerError): void {
    this.setSnapshot({ state: "error", error: `${error.category}: ${error.message}` });
  }

  private setSnapshot(snapshot: ConnectionStateSnapshot): void {
    this.snapshot = snapshot;
    this.options.onStateChange?.(snapshot);
  }
}
