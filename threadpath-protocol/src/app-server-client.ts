import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { type JsonObject, type JsonValue, type TerminalTurnEvent, ConfigurationError, ProcessError, ProtocolError, TimeoutError, errorFromServer, isJsonObject, terminalTurnEvent } from "./protocol.ts";

type RequestId = number;
type JsonRpcId = number | string;
type NotificationListener = (event: { method: string; params: JsonObject }) => void;
interface PendingRequest { method: string; resolve: (value: JsonValue) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout; }
interface PendingTurn { resolve: (event: TerminalTurnEvent) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout; }
export interface AppServerClientOptions {
  readonly cwd: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly onStderr?: (text: string) => void;
  readonly onProtocolWarning?: (error: ProtocolError) => void;
}

export class AppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly pendingRequests = new Map<RequestId, PendingRequest>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly terminalTurns = new Map<string, TerminalTurnEvent>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly onProtocolWarning: (error: ProtocolError) => void;
  private nextRequestId = 1;
  private closing = false;
  private fatalError: Error | undefined;

  constructor(options: AppServerClientOptions) {
    if (options.cwd.trim() === "") throw new ConfigurationError("app-server working directory must not be empty");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) throw new ConfigurationError("request timeout must be a positive number");
    this.onProtocolWarning = options.onProtocolWarning ?? (() => undefined);
    const spawnOptions: SpawnOptionsWithoutStdio = { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] };
    this.child = spawn(options.executable ?? "codex", options.args ?? ["app-server", "--stdio"], spawnOptions);
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line: string) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString()));
    this.child.on("error", (error: Error) => this.failAll(new ProcessError(`could not start app-server: ${error.message}`)));
    this.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (!this.closing) this.failAll(new ProcessError(`app-server exited with code=${code ?? "none"}, signal=${signal ?? "none"}`));
    });
  }

  onNotification(listener: NotificationListener): () => void { this.notificationListeners.add(listener); return () => this.notificationListeners.delete(listener); }

  request(method: string, params: JsonObject = {}): Promise<JsonValue> {
    if (this.fatalError !== undefined) return Promise.reject(this.fatalError);
    const id = this.nextRequestId++;
    return new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending === undefined) return;
        this.pendingRequests.delete(id);
        reject(new TimeoutError(`timed out waiting for ${method}`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, { method, resolve, reject, timeout });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timeout); this.pendingRequests.delete(id); reject(error instanceof Error ? error : new ProcessError(String(error))); }
    });
  }

  notify(method: string, params: JsonObject = {}): void { this.write({ jsonrpc: "2.0", method, params }); }

  waitForTurnTerminal(turnId: string, timeoutMs = this.requestTimeoutMs): Promise<TerminalTurnEvent> {
    const completed = this.terminalTurns.get(turnId);
    if (completed !== undefined) { this.terminalTurns.delete(turnId); return Promise.resolve(completed); }
    if (this.fatalError !== undefined) return Promise.reject(this.fatalError);
    if (this.pendingTurns.has(turnId)) return Promise.reject(new ProtocolError(`already waiting for terminal event for turn ${turnId}`));
    return new Promise<TerminalTurnEvent>((resolve, reject) => {
      const timeout = setTimeout(() => { if (this.pendingTurns.delete(turnId)) reject(new TimeoutError(`timed out waiting for terminal event for turn ${turnId}`)); }, timeoutMs);
      this.pendingTurns.set(turnId, { resolve, reject, timeout });
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.rejectAll(new ProcessError("app-server client was closed"));
    if (this.child.exitCode !== null || this.child.killed) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1_000);
      this.child.once("exit", () => { clearTimeout(timeout); resolve(); });
      this.child.kill();
    });
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let message: JsonValue;
    try { message = JSON.parse(line) as JsonValue; }
    catch { this.failAll(new ProtocolError(`app-server wrote non-JSON output to stdout: ${line.slice(0, 200)}`)); return; }
    if (!isJsonObject(message)) { this.failAll(new ProtocolError("app-server JSONL message must be an object")); return; }
    const method = typeof message.method === "string" ? message.method : undefined;
    const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
    if (method !== undefined) {
      const params = isJsonObject(message.params) ? message.params : {};
      this.publishNotification(method, params);
      if (id !== undefined) this.replyUnsupportedServerRequest(id, method);
      return;
    }
    if (id === undefined) { this.failAll(new ProtocolError("app-server response has neither a numeric id nor a method")); return; }
    if (typeof id !== "number") { this.warn(new ProtocolError(`received a response for unexpected string request id ${id}`)); return; }
    const pending = this.pendingRequests.get(id);
    if (pending === undefined) { this.warn(new ProtocolError(`received a response for unknown request id ${id}`)); return; }
    this.pendingRequests.delete(id);
    clearTimeout(pending.timeout);
    if (message.error !== undefined) { pending.reject(errorFromServer(message.error)); return; }
    if (message.result === undefined) { pending.reject(new ProtocolError(`response for ${pending.method} is missing both result and error`)); return; }
    pending.resolve(message.result);
  }

  private publishNotification(method: string, params: JsonObject): void {
    const event = terminalTurnEvent(method, params);
    if (event !== undefined) {
      const pending = this.pendingTurns.get(event.turnId);
      if (pending === undefined) this.terminalTurns.set(event.turnId, event);
      else { this.pendingTurns.delete(event.turnId); clearTimeout(pending.timeout); pending.resolve(event); }
    }
    for (const listener of this.notificationListeners) listener({ method, params });
  }

  private replyUnsupportedServerRequest(id: JsonRpcId, method: string): void {
    try { this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Client does not implement server request ${method}` } }); }
    catch (error) { this.failAll(error instanceof Error ? error : new ProcessError(String(error))); }
  }
  private write(message: JsonObject): void {
    if (this.fatalError !== undefined) throw this.fatalError;
    if (!this.child.stdin.writable) throw new ProcessError("app-server stdin is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private warn(error: ProtocolError): void { this.onProtocolWarning(error); }
  private failAll(error: Error): void { if (this.fatalError === undefined) this.fatalError = error; this.rejectAll(error); }
  private rejectAll(error: Error): void {
    for (const pending of this.pendingRequests.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pendingRequests.clear();
    for (const pending of this.pendingTurns.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pendingTurns.clear();
  }
}
