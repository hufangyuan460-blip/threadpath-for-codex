import { ConfigurationError, ProtocolError, type JsonObject, type JsonValue, type Thread, type Turn, type TurnInput, type TurnItem, isJsonObject, readString } from "../../../../threadpath-protocol/src/protocol.ts";
import type { ConversationItemView, ConversationThreadView, ConversationTurnView, ConversationUpdate, StartTurnResult } from "../shared/api";
import { type ThreadClient, type ThreadClientProvider, validateThreadId } from "./thread-service.ts";
import { buildTurnOutline } from "../shared/outline.ts";

const MAX_DISPLAY_SUMMARY_LENGTH = 500;

export interface ConversationClient extends ThreadClient {
  startTurn(threadId: string, input: readonly TurnInput[]): Promise<Turn>;
  onNotification(listener: (event: { method: string; params: JsonObject }) => void): () => void;
}

export interface ConversationClientProvider {
  getReadyClient(): ConversationClient;
}

export type ConversationUpdateListener = (update: ConversationUpdate) => void;

export class ConversationService {
  private readonly clientProvider: ConversationClientProvider;
  private readonly updateListeners = new Set<ConversationUpdateListener>();
  private boundClient: ConversationClient | undefined;
  private unsubscribeNotifications: (() => void) | undefined;
  private activeTurn: { threadId: string; turnId: string } | undefined;
  private startingTurn = false;

  constructor(clientProvider: ConversationClientProvider) {
    this.clientProvider = clientProvider;
  }

  async readThread(threadId: unknown): Promise<ConversationThreadView> {
    const validThreadId = validateThreadId(threadId);
    const client = this.clientProvider.getReadyClient();
    this.bindNotifications(client);
    return toConversationThreadView(await client.readThread(validThreadId));
  }

  async startTurn(threadId: unknown, text: unknown): Promise<StartTurnResult> {
    const validThreadId = validateThreadId(threadId);
    if (typeof text !== "string" || text.trim() === "" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new ConfigurationError("turn text must be non-empty plain text");
    }
    if (this.startingTurn || this.activeTurn !== undefined) throw new ProtocolError("only one turn may run at a time");
    this.startingTurn = true;
    try {
      const client = this.clientProvider.getReadyClient();
      this.bindNotifications(client);
      const turn = await client.startTurn(validThreadId, [{ type: "text", text: text.trim() }]);
      this.activeTurn = { threadId: validThreadId, turnId: turn.id };
      return { threadId: validThreadId, turnId: turn.id };
    } finally {
      this.startingTurn = false;
    }
  }

  onConversationUpdate(listener: ConversationUpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  close(): void {
    this.unsubscribeNotifications?.();
    this.unsubscribeNotifications = undefined;
    this.boundClient = undefined;
    this.activeTurn = undefined;
  }

  private bindNotifications(client: ConversationClient): void {
    if (this.boundClient === client) return;
    this.unsubscribeNotifications?.();
    this.boundClient = client;
    this.unsubscribeNotifications = client.onNotification(({ method, params }) => {
      const update = toConversationUpdate(method, params);
      if (update === undefined) return;
      if (update.type === "turn/completed" || update.type === "turn/failed" || update.type === "turn/interrupted") {
        if (this.activeTurn?.threadId === update.threadId && this.activeTurn.turnId === update.turnId) this.activeTurn = undefined;
      }
      for (const listener of this.updateListeners) listener(update);
    });
  }
}

export function toConversationThreadView(thread: Thread): ConversationThreadView {
  const turns = (thread.turns ?? []).map((turn, index) => toConversationTurnView(turn, index));
  return {
    id: thread.id,
    title: thread.title?.trim() || "Untitled thread",
    status: thread.status?.trim() || "unknown",
    turns,
    outline: buildTurnOutline(turns),
  };
}

export function toConversationUpdate(method: string, params: JsonObject): ConversationUpdate | undefined {
  const turn = isJsonObject(params.turn) ? params.turn : undefined;
  const item = isJsonObject(params.item) ? params.item : undefined;
  const threadId = readString(params, "threadId") ?? (turn === undefined ? undefined : readString(turn, "threadId"));
  const turnId = readString(params, "turnId") ?? (turn === undefined ? undefined : readString(turn, "id"));
  if (threadId === undefined || turnId === undefined) return undefined;

  if (method === "turn/started") return { type: method, threadId, turnId };
  if (method === "turn/completed" || method === "turn/failed" || method === "turn/interrupted") {
    const message = errorMessage(params.error) ?? (turn === undefined ? undefined : errorMessage(turn.error));
    return { type: method, threadId, turnId, ...(message === undefined ? {} : { message }) };
  }

  const itemId = readString(params, "itemId") ?? (item === undefined ? undefined : readString(item, "id")) ?? `${turnId}:item`;
  if (method === "item/started") {
    const itemType = item === undefined ? undefined : readString(item, "type");
    const itemName = item === undefined ? undefined : readString(item, "name");
    return { type: method, threadId, turnId, itemId, ...(itemType === undefined ? {} : { itemType }), ...(itemName === undefined ? {} : { itemName }) };
  }
  if (method === "item/agentMessage/delta") {
    const delta = readString(params, "delta") ?? (item === undefined ? undefined : readString(item, "delta"));
    return { type: method, threadId, turnId, itemId, delta: delta ?? "" };
  }
  if (method === "item/completed") {
    const status = toolStatus(readString(params, "status") ?? (item === undefined ? undefined : readString(item, "status")));
    const itemType = item === undefined ? undefined : readString(item, "type");
    const itemName = item === undefined ? undefined : readString(item, "name");
    const summary = readString(params, "summary") ?? (item === undefined ? undefined : readString(item, "summary"));
    return { type: method, threadId, turnId, itemId, status, ...(itemType === undefined ? {} : { itemType }), ...(itemName === undefined ? {} : { itemName }), ...(summary === undefined ? {} : { summary: limitDisplayText(summary) }) };
  }
  return undefined;
}

function toConversationTurnView(turn: Turn, index: number): ConversationTurnView {
  return {
    id: turn.id,
    index: index + 1,
    status: turn.status?.trim() || "unknown",
    ...(turn.createdAt === undefined ? {} : { createdAt: turn.createdAt }),
    items: (turn.items ?? []).map((item, itemIndex) => toConversationItemView(item, turn.id, itemIndex)),
  };
}

function toConversationItemView(item: TurnItem, turnId: string, itemIndex: number): ConversationItemView {
  const id = item.id?.trim() || `${turnId}:item-${itemIndex + 1}`;
  const type = item.type?.trim().toLowerCase() ?? "";
  const text = displayText(item.text ?? item.content);
  const role = textRole(item, type);
  if (role !== undefined) return { kind: "text", id, role, text: text || "(No text provided)" };
  if (isToolItem(item, type)) {
    const summary = displayText(item.summary ?? item.aggregatedOutput);
    return { kind: "tool", id, name: item.name?.trim() || toolName(type), status: toolStatus(item.status), ...(summary === "" ? {} : { summary: limitDisplayText(summary) }) };
  }
  return { kind: "status", id, text: limitDisplayText(text || (type === "" ? "Unknown conversation item" : `Unsupported item type: ${type}`)) };
}

function textRole(item: TurnItem, type: string): "user" | "assistant" | "system" | undefined {
  const role = item.role?.trim().toLowerCase();
  if (role === "user" || role === "assistant" || role === "system") return role;
  if (type.includes("user")) return "user";
  if (type.includes("agent") || type.includes("assistant")) return "assistant";
  if (type.includes("system")) return "system";
  return undefined;
}

function isToolItem(item: TurnItem, type: string): boolean {
  return item.name !== undefined || item.command !== undefined || /tool|command|execution|function|search/.test(type);
}

function toolName(type: string): string { return type === "" ? "Tool" : type; }

function toolStatus(value: string | undefined): "running" | "completed" | "failed" | "unknown" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "running" || normalized === "in_progress") return "running";
  if (normalized === "completed" || normalized === "complete" || normalized === "succeeded") return "completed";
  if (normalized === "failed" || normalized === "error") return "failed";
  return "unknown";
}

function errorMessage(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  return isJsonObject(value) ? readString(value, "message") : undefined;
}

function displayText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => displayText(item)).filter((item) => item !== "").join("\n");
  if (value !== null && typeof value === "object") {
    const text = displayText(value.text);
    return text === "" ? displayText(value.content) : text;
  }
  return "";
}

function limitDisplayText(value: string): string {
  return value.length <= MAX_DISPLAY_SUMMARY_LENGTH ? value : `${value.slice(0, MAX_DISPLAY_SUMMARY_LENGTH)}…`;
}
