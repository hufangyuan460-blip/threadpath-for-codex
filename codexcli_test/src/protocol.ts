export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ErrorCategory = "configuration" | "process" | "protocol" | "timeout" | "network-timeout" | "server";

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
export class TimeoutError extends AppServerError {
  constructor(message: string) { super(message, "timeout"); this.name = "TimeoutError"; }
}
export class NetworkTimeoutError extends AppServerError {
  constructor(message: string, code?: JsonValue) { super(message, "network-timeout", code); this.name = "NetworkTimeoutError"; }
}

export interface ThreadSummary { id: string; title?: string; status?: string; }
export interface Thread extends ThreadSummary { turns?: Turn[]; }
export interface Turn { id: string; status?: string; }
export interface TurnEvent { method: string; params: JsonObject; }
export interface TerminalTurnEvent extends TurnEvent {
  turnId: string;
  outcome: "completed" | "failed" | "interrupted";
  error?: AppServerError;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

export function getThreads(value: JsonValue): ThreadSummary[] {
  if (!isJsonObject(value)) return [];
  const source = Array.isArray(value.data) ? value.data : Array.isArray(value.threads) ? value.threads : [];
  return source.flatMap((item) => {
    if (!isJsonObject(item)) return [];
    const id = readString(item, "id");
    return id === undefined ? [] : [{ id, title: readString(item, "title"), status: readString(item, "status") }];
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
