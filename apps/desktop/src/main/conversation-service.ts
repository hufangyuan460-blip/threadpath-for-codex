import { AppServerError, ConfigurationError, ProtocolError, ThreadUnavailableError, type JsonObject, type JsonValue, type Thread, type Turn, type TurnInput, type TurnItem, type TurnPage, isJsonObject, readString } from "../../../../threadpath-protocol/src/protocol.ts";
import type { ConversationItemView, ConversationPagingState, ConversationThreadView, ConversationTurnView, ConversationUpdate, SearchResult, StartTurnResult } from "../shared/api";
import { type ThreadClient, type ThreadClientProvider, validateThreadId } from "./thread-service.ts";
import { buildTurnOutline } from "../shared/outline.ts";
import { applyConversationUpdate } from "../shared/conversation-state.ts";
import { searchLoadedTurns } from "./search-service.ts";

const MAX_DISPLAY_SUMMARY_LENGTH = 500;
const INITIAL_FIRST_ITEM_INDEX = 1_000_000;
type ToolStatus = Extract<ConversationItemView, { kind: "tool" }>["status"];

export interface ConversationClient extends ThreadClient {
  listTurns(threadId: string, options?: { limit?: number; cursor?: string }): Promise<TurnPage>;
  resumeThread(threadId: string): Promise<Thread>;
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
  private readonly loadedThreads = new Map<string, ConversationThreadView>();
  private activeTurn: { threadId: string; turnId: string } | undefined;
  private startingTurn = false;

  constructor(clientProvider: ConversationClientProvider) {
    this.clientProvider = clientProvider;
  }

  async readThread(threadId: unknown): Promise<ConversationThreadView> {
    const validThreadId = validateThreadId(threadId);
    const client = this.clientProvider.getReadyClient();
    this.bindNotifications(client);
    const thread = await client.readThread(validThreadId);
    const page = await client.listTurns(validThreadId, { limit: 20 });
    const sourceTurns = page.turns.length === 0 && (thread.turns?.length ?? 0) > 0 ? (thread.turns ?? []) : page.turns;
    const initialTurns = mergeConversationTurns([], sourceTurns.map((turn, index) => toConversationTurnView(turn, index)));
    const view = withPaging(toConversationThreadView({ ...thread, turns: [] }), {
      nextCursor: page.nextCursor,
      hasMore: page.nextCursor !== undefined,
      loadMoreError: undefined,
    });
    const initialView = { ...view, turns: initialTurns, outline: buildTurnOutline(initialTurns), paging: { ...view.paging, orderedTurnIds: initialTurns.map((turn) => turn.id) } };
    this.loadedThreads.set(validThreadId, initialView);
    return initialView;
  }

  async loadMoreTurns(threadId: unknown): Promise<ConversationThreadView> {
    const validThreadId = validateThreadId(threadId);
    const current = this.loadedThreads.get(validThreadId);
    if (current === undefined) throw new ProtocolError("thread must be loaded before requesting earlier turns");
    if (!current.paging.hasMore) return current;
    if (current.paging.isLoadingMore) throw new ProtocolError("an earlier-turn request is already running");
    const client = this.clientProvider.getReadyClient();
    this.bindNotifications(client);
    const loading = withPaging(current, { isLoadingMore: true, loadMoreError: undefined });
    this.loadedThreads.set(validThreadId, loading);
    try {
      const page = await client.listTurns(validThreadId, { limit: 20, cursor: current.paging.nextCursor });
      const turns = mergeConversationTurns(current.turns, page.turns.map((turn, index) => toConversationTurnView(turn, index)));
      const addedTurnCount = Math.max(0, turns.length - current.turns.length);
      const repeatedCursor = page.nextCursor !== undefined && page.nextCursor === current.paging.nextCursor;
      const next = withPaging({ ...current, turns, outline: buildTurnOutline(turns) }, {
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== undefined && !repeatedCursor,
        isLoadingMore: false,
        loadMoreError: undefined,
        firstItemIndex: Math.max(1, current.paging.firstItemIndex - addedTurnCount),
      });
      this.loadedThreads.set(validThreadId, next);
      return next;
    } catch (error: unknown) {
      const failed = withPaging(current, { isLoadingMore: false, loadMoreError: error instanceof Error ? error.message : String(error) });
      this.loadedThreads.set(validThreadId, failed);
      throw error;
    }
  }

  async searchTurns(threadId: unknown, query: unknown): Promise<SearchResult[]> {
    const validThreadId = validateThreadId(threadId);
    if (typeof query !== "string") throw new ConfigurationError("search query must be plain text");
    const thread = this.loadedThreads.get(validThreadId);
    return thread === undefined ? [] : searchLoadedTurns(thread, query);
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
      // thread/read only reads history. thread/resume is the verified app-server
      // operation that reactivates an existing thread for a subsequent turn.
      try {
        const resumedThread = await client.resumeThread(validThreadId);
        if (resumedThread.canAcceptDirectInput === false) {
          throw new ThreadUnavailableError("This thread cannot accept direct input. Refresh the thread list and choose another thread.");
        }
      } catch (error: unknown) {
        if (isThreadUnavailable(error)) throw new ThreadUnavailableError(undefined, error.code);
        throw error;
      }
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

  getLoadedThread(threadId: string): ConversationThreadView | undefined {
    return this.loadedThreads.get(threadId);
  }

  close(): void {
    this.unsubscribeNotifications?.();
    this.unsubscribeNotifications = undefined;
    this.boundClient = undefined;
    this.activeTurn = undefined;
    this.loadedThreads.clear();
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
      const loadedThread = this.loadedThreads.get(update.threadId);
      if (loadedThread !== undefined) this.loadedThreads.set(update.threadId, applyConversationUpdate(loadedThread, update));
      for (const listener of this.updateListeners) listener(update);
    });
  }
}

function isThreadUnavailable(error: unknown): error is AppServerError {
  return error instanceof AppServerError && (/thread[\s_-]*(not[\s_-]*found|unavailable|deleted)/i.test(error.message) || (typeof error.code === "string" && /thread[\s_-]*(not[\s_-]*found|unavailable|deleted)/i.test(error.code)));
}

export function toConversationThreadView(thread: Thread): ConversationThreadView {
  const turns = (thread.turns ?? []).map((turn, index) => toConversationTurnView(turn, index));
  return {
    id: thread.id,
    title: thread.title?.trim() || thread.name?.trim() || "Untitled thread",
    status: thread.status?.trim() || "unknown",
    turns,
    outline: buildTurnOutline(turns),
    paging: { orderedTurnIds: turns.map((turn) => turn.id), firstItemIndex: INITIAL_FIRST_ITEM_INDEX, hasMore: false, isLoadingMore: false },
  };
}

function withPaging(thread: ConversationThreadView, update: Partial<ConversationPagingState>): ConversationThreadView {
  return { ...thread, paging: { ...thread.paging, ...update, orderedTurnIds: thread.turns.map((turn) => turn.id) } };
}

export function mergeConversationTurns(existing: readonly ConversationTurnView[], incoming: readonly ConversationTurnView[]): ConversationTurnView[] {
  const byId = new Map<string, ConversationTurnView>();
  const order: string[] = [];
  for (const turn of [...existing, ...incoming]) {
    const prior = byId.get(turn.id);
    if (prior === undefined) order.push(turn.id);
    byId.set(turn.id, prior === undefined ? turn : mergeConversationTurn(prior, turn));
  }
  const sorted = order.map((id) => byId.get(id)).filter((turn): turn is ConversationTurnView => turn !== undefined);
  sorted.sort((left, right) => {
    if (left.createdAt === undefined || right.createdAt === undefined) return order.indexOf(left.id) - order.indexOf(right.id);
    const difference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return Number.isNaN(difference) ? order.indexOf(left.id) - order.indexOf(right.id) : difference;
  });
  return sorted.map((turn, index) => ({ ...turn, index: index + 1 }));
}

function mergeConversationTurn(existing: ConversationTurnView, incoming: ConversationTurnView): ConversationTurnView {
  const items = mergeConversationItems(existing.items, incoming.items);
  return {
    ...existing,
    status: richerTurnStatus(existing.status, incoming.status),
    ...(existing.createdAt === undefined && incoming.createdAt !== undefined ? { createdAt: incoming.createdAt } : {}),
    items,
  };
}

function mergeConversationItems(existing: readonly ConversationItemView[], incoming: readonly ConversationItemView[]): ConversationItemView[] {
  const byId = new Map<string, ConversationItemView>();
  const order: string[] = [];
  for (const item of [...existing, ...incoming]) {
    const prior = byId.get(item.id);
    if (prior === undefined) order.push(item.id);
    byId.set(item.id, prior === undefined ? item : mergeConversationItem(prior, item));
  }
  return order.map((id) => byId.get(id)).filter((item): item is ConversationItemView => item !== undefined);
}

function mergeConversationItem(existing: ConversationItemView, incoming: ConversationItemView): ConversationItemView {
  if (existing.kind === "text" && incoming.kind === "text") return { ...existing, ...incoming, text: incoming.text.length >= existing.text.length ? incoming.text : existing.text };
  if (existing.kind === "tool" && incoming.kind === "tool") return { ...existing, ...incoming, status: richerToolStatus(existing.status, incoming.status), ...(longerText(existing.summary, incoming.summary) === undefined ? {} : { summary: longerText(existing.summary, incoming.summary) }) };
  if (existing.kind === "status" && incoming.kind === "status") return incoming.text.length >= existing.text.length ? incoming : existing;
  return incoming.kind === "status" && existing.kind !== "status" ? existing : incoming;
}

function longerText(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return right.length >= left.length ? right : left;
}

function richerTurnStatus(left: string, right: string): string {
  const rank = (value: string): number => value === "unknown" ? 0 : value === "running" || value === "active" ? 1 : 2;
  return rank(right) >= rank(left) ? right : left;
}

function richerToolStatus(left: ToolStatus, right: ToolStatus): ToolStatus {
  const rank = (value: string): number => value === "unknown" ? 0 : value === "running" ? 1 : 2;
  return rank(right) >= rank(left) ? right : left;
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
