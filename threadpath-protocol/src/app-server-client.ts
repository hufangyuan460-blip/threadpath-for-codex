import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { type JsonObject, type JsonValue, type DiagnosticRecord, type InitializeResult, type StartThreadOptions, type TerminalTurnEvent, type Thread, type ThreadSummary, type Turn, type TurnInput, AppServerError, ConfigurationError, ProcessError, ProtocolError, TimeoutError, errorFromServer, getThread, getThreads, getTurnId, getTurns, isJsonObject, terminalTurnEvent } from "./protocol.ts";

type RequestId = number;
type JsonRpcId = number | string;
type NotificationListener = (event: { method: string; params: JsonObject }) => void;
interface PendingRequest { method: string; resolve: (value: JsonValue) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout; startedAt: number; }
interface PendingTurn { resolve: (event: TerminalTurnEvent) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout; startedAt: number; }
export interface AppServerClientOptions {
  readonly cwd: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly onStderr?: (text: string) => void;
  readonly onProtocolWarning?: (error: ProtocolError) => void;
  readonly clientInfo?: { name: string; title?: string; version?: string };
  readonly onDiagnostic?: (record: DiagnosticRecord) => void;
}

export class AppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly pendingRequests = new Map<RequestId, PendingRequest>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly terminalTurns = new Map<string, TerminalTurnEvent>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly onProtocolWarning: (error: ProtocolError) => void;
  private readonly clientInfo: { name: string; title: string; version: string };
  private readonly onDiagnostic: (record: DiagnosticRecord) => void;
  private nextRequestId = 1;
  private closing = false;
  private fatalError: Error | undefined;

  constructor(options: AppServerClientOptions) {
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
    if (options.cwd.trim() === "") {
      const error = new ConfigurationError("app-server working directory must not be empty");
      this.onDiagnostic({ event: "client.failed", method: "client", status: "failed", errorCategory: error.category });
      throw error;
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      const error = new ConfigurationError("request timeout must be a positive number");
      this.onDiagnostic({ event: "client.failed", method: "client", status: "failed", errorCategory: error.category });
      throw error;
    }
    this.onProtocolWarning = options.onProtocolWarning ?? (() => undefined);
    this.clientInfo = { name: options.clientInfo?.name ?? "threadpath-protocol", title: options.clientInfo?.title ?? "ThreadPath protocol client", version: options.clientInfo?.version ?? "0.0.2" };
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
        const error = new TimeoutError(`timed out waiting for ${method}`);
        this.emitRequestFailure(id, method, startedAt, error);
        reject(error);
      }, this.requestTimeoutMs);
      const startedAt = Date.now();
      this.pendingRequests.set(id, { method, resolve, reject, timeout, startedAt });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        const processError = error instanceof Error ? error : new ProcessError(String(error));
        this.emitRequestFailure(id, method, startedAt, processError);
        reject(processError);
      }
    });
  }

  async initialize(): Promise<InitializeResult> {
    const response = await this.request("initialize", { clientInfo: this.clientInfo, capabilities: null });
    this.notify("initialized");
    const object = this.requireObject(response, "initialize");
    return {
      userAgent: typeof object.userAgent === "string" ? object.userAgent : undefined,
      codexHome: typeof object.codexHome === "string" ? object.codexHome : undefined,
      platformFamily: typeof object.platformFamily === "string" ? object.platformFamily : undefined,
      platformOs: typeof object.platformOs === "string" ? object.platformOs : undefined,
    };
  }

  async listThreads(options: { archived?: boolean; limit?: number } = {}): Promise<ThreadSummary[]> {
    const response = await this.request("thread/list", {
      archived: options.archived ?? false,
      limit: options.limit ?? 10,
    });
    const object = this.requireObject(response, "thread/list");
    if (!Array.isArray(object.data) && !Array.isArray(object.threads)) throw new ProtocolError("thread/list response is missing a thread list");
    return getThreads(object);
  }

  async readThread(threadId: string): Promise<Thread> {
    const response = await this.request("thread/read", { threadId, includeTurns: true });
    const thread = getThread(this.requireObject(response, "thread/read"));
    if (thread === undefined) throw new ProtocolError("thread/read response did not contain a thread id");
    return thread;
  }

  async listTurns(threadId: string, limit = 10): Promise<Turn[]> {
    const response = await this.request("thread/turns/list", { threadId, limit });
    const object = this.requireObject(response, "thread/turns/list");
    if (!Array.isArray(object.data)) throw new ProtocolError("thread/turns/list response is missing a turn list");
    return getTurns(object);
  }

  async startThread(options: StartThreadOptions): Promise<Thread> {
    const params: JsonObject = { cwd: options.cwd };
    if (options.ephemeral !== undefined) params.ephemeral = options.ephemeral;
    if (options.approvalPolicy !== undefined) params.approvalPolicy = options.approvalPolicy;
    if (options.sandbox !== undefined) params.sandbox = options.sandbox;
    const response = await this.request("thread/start", params);
    const thread = getThread(this.requireObject(response, "thread/start"));
    if (thread === undefined) throw new ProtocolError("thread/start response did not contain a thread id");
    return thread;
  }

  async startTurn(threadId: string, input: readonly TurnInput[]): Promise<Turn> {
    const response = await this.request("turn/start", {
      threadId,
      input: input.map((item) => ({ type: item.type, text: item.text })),
    });
    const turnId = getTurnId(this.requireObject(response, "turn/start"));
    if (turnId === undefined) throw new ProtocolError("turn/start response did not contain a turn id");
    return { id: turnId };
  }

  notify(method: string, params: JsonObject = {}): void { this.write({ jsonrpc: "2.0", method, params }); }

  waitForTurnTerminal(turnId: string, timeoutMs = this.requestTimeoutMs): Promise<TerminalTurnEvent> {
    const completed = this.terminalTurns.get(turnId);
    if (completed !== undefined) {
      this.terminalTurns.delete(turnId);
      this.emitTurnDiagnostic(completed, 0);
      return Promise.resolve(completed);
    }
    if (this.fatalError !== undefined) return Promise.reject(this.fatalError);
    if (this.pendingTurns.has(turnId)) return Promise.reject(new ProtocolError(`already waiting for terminal event for turn ${turnId}`));
    return new Promise<TerminalTurnEvent>((resolve, reject) => {
      const timeout = setTimeout(() => { if (this.pendingTurns.delete(turnId)) reject(new TimeoutError(`timed out waiting for terminal event for turn ${turnId}`)); }, timeoutMs);
      this.pendingTurns.set(turnId, { resolve, reject, timeout, startedAt: Date.now() });
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
    if (message.error !== undefined) {
      const error = errorFromServer(message.error);
      this.emitRequestFailure(id, pending.method, pending.startedAt, error);
      pending.reject(error);
      return;
    }
    if (message.result === undefined) {
      const error = new ProtocolError(`response for ${pending.method} is missing both result and error`);
      this.emitRequestFailure(id, pending.method, pending.startedAt, error);
      pending.reject(error);
      return;
    }
    this.onDiagnostic({ event: "request.completed", method: pending.method, status: "completed", requestId: id, startedAt: new Date(pending.startedAt).toISOString(), durationMs: Date.now() - pending.startedAt });
    pending.resolve(message.result);
  }

  private publishNotification(method: string, params: JsonObject): void {
    this.onDiagnostic({ event: "notification", method, status: "received" });
    const event = terminalTurnEvent(method, params);
    if (event !== undefined) {
      const pending = this.pendingTurns.get(event.turnId);
      if (pending === undefined) this.terminalTurns.set(event.turnId, event);
      else {
        this.pendingTurns.delete(event.turnId);
        clearTimeout(pending.timeout);
        this.emitTurnDiagnostic(event, Date.now() - pending.startedAt, pending.startedAt);
        pending.resolve(event);
      }
    }
    for (const listener of this.notificationListeners) listener({ method, params });
  }

  private replyUnsupportedServerRequest(id: JsonRpcId, method: string): void {
    try { this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Client does not implement server request ${method}` } }); }
    catch (error) { this.failAll(error instanceof Error ? error : new ProcessError(String(error))); }
  }
  private requireObject(value: JsonValue, method: string): JsonObject {
    if (!isJsonObject(value)) throw new ProtocolError(`${method} response must be a JSON object`);
    return value;
  }
  private emitRequestFailure(requestId: number, method: string, startedAt: number, error: Error): void {
    this.onDiagnostic({ event: "request.failed", method, status: "failed", requestId, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, errorCategory: error instanceof AppServerError ? error.category : "process" });
  }
  private emitTurnDiagnostic(event: TerminalTurnEvent, durationMs: number, startedAt?: number): void {
    this.onDiagnostic({ event: "turn.terminal", method: event.method, status: "terminal", turnId: event.turnId, ...(startedAt === undefined ? {} : { startedAt: new Date(startedAt).toISOString() }), durationMs, outcome: event.outcome, errorCategory: event.error?.category });
  }
  private write(message: JsonObject): void {
    if (this.fatalError !== undefined) throw this.fatalError;
    if (!this.child.stdin.writable) throw new ProcessError("app-server stdin is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private warn(error: ProtocolError): void { this.onProtocolWarning(error); }
  private failAll(error: Error): void { if (this.fatalError === undefined) this.fatalError = error; this.rejectAll(error); }
  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      this.emitRequestFailure(requestId, pending.method, pending.startedAt, error);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const pending of this.pendingTurns.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pendingTurns.clear();
  }
}
