export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ErrorCategory = "configuration" | "process" | "protocol" | "timeout" | "network-timeout" | "server";

export interface AppServerCapabilities {
  readonly known: boolean;
  readonly methods: readonly string[];
  readonly events: readonly string[];
}

export interface CompatibilityInfo {
  readonly status?: string;
  readonly message?: string;
}

export interface InitializeResult {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
  serverVersion?: string;
  protocolVersion?: string;
  capabilities: AppServerCapabilities;
  compatibility?: CompatibilityInfo;
}

export interface StartThreadOptions {
  cwd: string;
  ephemeral?: boolean;
  approvalPolicy?: string;
  sandbox?: string;
}

export interface TurnInput {
  type: "text";
  text: string;
}

export class AppServerError extends Error {
  readonly category: ErrorCategory;
  readonly code: JsonValue | undefined;

  constructor(message: string, category: ErrorCategory, code?: JsonValue) {
    super(message);
    this.name = "AppServerError";
    this.category = category;
    this.code = code;
  }
}

export class ConfigurationError extends AppServerError {
  constructor(message: string) { super(message, "configuration"); this.name = "ConfigurationError"; }
}
export class ProcessError extends AppServerError {
  constructor(message: string) { super(message, "process"); this.name = "ProcessError"; }
}
export class ProtocolError extends AppServerError {
  constructor(message: string) { super(message, "protocol"); this.name = "ProtocolError"; }
}
export class CompatibilityError extends AppServerError {
  constructor(message: string) { super(message, "protocol"); this.name = "CompatibilityError"; }
}
export class TimeoutError extends AppServerError {
  constructor(message: string) { super(message, "timeout"); this.name = "TimeoutError"; }
}
export class NetworkTimeoutError extends AppServerError {
  constructor(message: string, code?: JsonValue) { super(message, "network-timeout", code); this.name = "NetworkTimeoutError"; }
}

export interface ThreadSummary { id: string; title?: string; status?: string; turnCount?: number; createdAt?: string; }
export interface Thread extends ThreadSummary { turns?: Turn[]; }
export interface Turn { id: string; status?: string; createdAt?: string; items?: TurnItem[]; }
export interface TurnItem { id?: string; type?: string; role?: string; text?: string; content?: JsonValue; name?: string; status?: string; summary?: string; command?: string; aggregatedOutput?: string; }
export interface TurnEvent { method: string; params: JsonObject; }
export interface TerminalTurnEvent extends TurnEvent {
  turnId: string;
  outcome: "completed" | "failed" | "interrupted";
  error?: AppServerError;
}

export type DiagnosticEvent = "request.completed" | "request.failed" | "notification" | "turn.terminal" | "client.failed";
export type DiagnosticStatus = "completed" | "failed" | "received" | "terminal";
export interface DiagnosticRecord {
  event: DiagnosticEvent;
  method: string;
  status: DiagnosticStatus;
  requestId?: number;
  turnId?: string;
  startedAt?: string;
  durationMs?: number;
  outcome?: TerminalTurnEvent["outcome"];
  errorCategory?: ErrorCategory;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

export function readNumber(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringList(value: JsonValue | undefined): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === "string" ? [item] : []);
  if (!isJsonObject(value)) return [];
  return Object.entries(value).flatMap(([name, enabled]) => enabled === true ? [name] : []);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function parseCapabilities(value: JsonValue | undefined): AppServerCapabilities {
  if (!isJsonObject(value)) return { known: false, methods: [], events: [] };
  const methodsValue = value.methods ?? value.supportedMethods;
  const eventsValue = value.events ?? value.supportedEvents;
  const methods = uniqueStrings(readStringList(methodsValue));
  const events = uniqueStrings(readStringList(eventsValue));
  return { known: methodsValue !== undefined || eventsValue !== undefined, methods, events };
}

export function parseInitializeResult(value: JsonValue): InitializeResult {
  const object = isJsonObject(value) ? value : {};
  const serverInfo = isJsonObject(object.serverInfo) ? object.serverInfo : undefined;
  const capabilitySource = object.capabilities !== undefined
    ? object.capabilities
    : serverInfo?.capabilities;
  const rawCompatibility = object.compatibility;
  const compatibility = typeof rawCompatibility === "string"
    ? { status: rawCompatibility }
    : isJsonObject(rawCompatibility)
      ? { status: readString(rawCompatibility, "status"), message: readString(rawCompatibility, "message") ?? readString(rawCompatibility, "reason") }
      : undefined;
  return {
    userAgent: readString(object, "userAgent"),
    codexHome: readString(object, "codexHome"),
    platformFamily: readString(object, "platformFamily"),
    platformOs: readString(object, "platformOs"),
    serverVersion: readString(object, "serverVersion") ?? readString(object, "version") ?? (serverInfo === undefined ? undefined : readString(serverInfo, "version")),
    protocolVersion: readString(object, "protocolVersion") ?? (serverInfo === undefined ? undefined : readString(serverInfo, "protocolVersion")),
    capabilities: parseCapabilities(capabilitySource),
    ...(compatibility === undefined ? {} : { compatibility }),
  };
}

export function getThreads(value: JsonValue): ThreadSummary[] {
  if (!isJsonObject(value)) return [];
  const source = Array.isArray(value.data) ? value.data : Array.isArray(value.threads) ? value.threads : [];
  return source.flatMap((item) => {
    if (!isJsonObject(item)) return [];
    const id = readString(item, "id");
    const turnCount = readNumber(item, "turnCount");
    const createdAt = readString(item, "createdAt");
    return id === undefined ? [] : [{ id, title: readString(item, "title"), status: readString(item, "status"), ...(turnCount === undefined ? {} : { turnCount }), ...(createdAt === undefined ? {} : { createdAt }) }];
  });
}

export function getThread(value: JsonValue): Thread | undefined {
  if (!isJsonObject(value)) return undefined;
  const source = isJsonObject(value.thread) ? value.thread : value;
  const id = readString(source, "id");
  if (id === undefined) return undefined;
  const turnCount = readNumber(source, "turnCount");
  const createdAt = readString(source, "createdAt");
  return {
    id,
    title: readString(source, "title"),
    status: readString(source, "status"),
    ...(turnCount === undefined ? {} : { turnCount }),
    ...(createdAt === undefined ? {} : { createdAt }),
    turns: Array.isArray(source.turns) ? source.turns.flatMap((item) => isJsonObject(item) ? [parseTurn(item)] : []).filter((turn): turn is Turn => turn !== undefined) : undefined,
  };
}

function parseTurn(value: JsonObject): Turn | undefined {
  const id = readString(value, "id");
  if (id === undefined) return undefined;
  return {
    id,
    status: readString(value, "status"),
    createdAt: readString(value, "createdAt") ?? readString(value, "timestamp"),
    items: Array.isArray(value.items) ? value.items.flatMap((item) => isJsonObject(item) ? [parseTurnItem(item)] : []) : undefined,
  };
}

function parseTurnItem(value: JsonObject): TurnItem {
  const id = readString(value, "id");
  const type = readString(value, "type");
  const role = readString(value, "role");
  const text = readString(value, "text");
  const name = readString(value, "name");
  const status = readString(value, "status");
  const summary = readString(value, "summary");
  const command = readString(value, "command");
  const aggregatedOutput = readString(value, "aggregatedOutput");
  return {
    ...(id === undefined ? {} : { id }),
    ...(type === undefined ? {} : { type }),
    ...(role === undefined ? {} : { role }),
    ...(text === undefined ? {} : { text }),
    ...(value.content === undefined ? {} : { content: value.content }),
    ...(name === undefined ? {} : { name }),
    ...(status === undefined ? {} : { status }),
    ...(summary === undefined ? {} : { summary }),
    ...(command === undefined ? {} : { command }),
    ...(aggregatedOutput === undefined ? {} : { aggregatedOutput }),
  };
}

export function getTurns(value: JsonValue): Turn[] {
  if (!isJsonObject(value) || !Array.isArray(value.data)) return [];
  return value.data.flatMap((item) => {
    if (!isJsonObject(item)) return [];
    const id = readString(item, "id");
    return id === undefined ? [] : [{ id, status: readString(item, "status") }];
  });
}

export function getThreadId(value: JsonValue): string | undefined {
  if (!isJsonObject(value)) return undefined;
  const directId = readString(value, "threadId");
  if (directId !== undefined) return directId;
  if (isJsonObject(value.thread)) return readString(value.thread, "id");
  return readString(value, "id");
}

export function getTurnId(value: JsonValue): string | undefined {
  if (!isJsonObject(value)) return undefined;
  if (isJsonObject(value.turn)) return readString(value.turn, "id");
  return readString(value, "id");
}

export function errorFromServer(value: JsonValue): AppServerError {
  if (!isJsonObject(value)) return new AppServerError("app-server returned an invalid error response", "server");
  const message = readString(value, "message") ?? "app-server returned an error response";
  const code = value.code;
  const normalizedCode = typeof code === "string" ? code.toLowerCase() : "";
  if (normalizedCode.includes("network") && normalizedCode.includes("timeout")) return new NetworkTimeoutError(message, code);
  return new AppServerError(message, "server", code);
}

export function terminalTurnEvent(method: string, params: JsonObject): TerminalTurnEvent | undefined {
  const outcome = method === "turn/completed" ? "completed" : method === "turn/failed" ? "failed" : method === "turn/interrupted" ? "interrupted" : undefined;
  if (outcome === undefined || !isJsonObject(params.turn)) return undefined;
  const turnId = readString(params.turn, "id");
  if (turnId === undefined) return undefined;
  const rawError = isJsonObject(params.error) ? params.error : isJsonObject(params.turn.error) ? params.turn.error : undefined;
  return { method, params, turnId, outcome, ...(rawError === undefined ? {} : { error: errorFromServer(rawError) }) };
}
