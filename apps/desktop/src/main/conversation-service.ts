import { ActiveTurnError, AppServerError, ConfigurationError, ProtocolError, ThreadUnavailableError, type JsonObject, type JsonValue, type Thread, type Turn, type TurnInput, type TurnItem, type TurnPage, isJsonObject, readString } from "../../../../threadpath-protocol/src/protocol.ts";
import type { ConversationItemView, ConversationPagingState, ConversationThreadView, ConversationTurnView, ConversationUpdate, SearchResult, StartTurnResult } from "../shared/api";
import { type ThreadClient, type ThreadClientProvider, validateThreadId } from "./thread-service.ts";
import { buildTurnOutline } from "../shared/outline.ts";
import { applyConversationUpdate } from "../shared/conversation-state.ts";
import { searchLoadedTurns } from "./search-service.ts";

const MAX_DISPLAY_SUMMARY_LENGTH = 500;
const INITIAL_FIRST_ITEM_INDEX = 1_000_000;
export type TurnCollectionOrder = "oldest-first" | "newest-first";
// Adapter facts established by the checked-in protocol fixtures: thread/read
// is oldest-first, while thread/turns/list returns the newest page first and
// its nextCursor walks toward older pages.
const DEFAULT_THREAD_READ_ORDER: TurnCollectionOrder = "oldest-first";
const DEFAULT_TURN_PAGE_ORDER: TurnCollectionOrder = "newest-first";
type ToolStatus = Extract<ConversationItemView, { kind: "tool" }>["status"];

export interface ConversationClient extends ThreadClient {
  readonly threadReadOrder?: TurnCollectionOrder;
  readonly turnPageOrder?: TurnCollectionOrder;
  startThread(options: { cwd: string; ephemeral?: boolean }): Promise<Thread>;
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
  private readonly olderCachedTurnIds = new Map<string, Set<string>>();
  private readonly remoteActiveThreads = new Set<string>();
  private readonly remoteActiveTurnIds = new Map<string, string>();
  private readonly recentUpdates = new Map<string, ConversationUpdate[]>();
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
    const readTurns = normalizeTurnCollection(thread.turns ?? [], client.threadReadOrder ?? DEFAULT_THREAD_READ_ORDER);
    const pageTurns = normalizeTurnCollection(page.turns, client.turnPageOrder ?? DEFAULT_TURN_PAGE_ORDER);
    const freshTurns = mergeConversationSources(
      readTurns.map((turn, index) => toConversationTurnView(turn, index)),
      pageTurns.map((turn, index) => toConversationTurnView(turn, index)),
    );
    const view = withPaging(toConversationThreadView({ ...thread, turns: [] }), {
      nextCursor: page.nextCursor,
      hasMore: page.nextCursor !== undefined,
      loadMoreError: undefined,
    });
    const previouslyLoaded = this.loadedThreads.get(validThreadId);
    const bufferedUpdates = this.recentUpdates.get(validThreadId) ?? [];
    const bufferedTurnId = bufferedUpdates.at(-1)?.turnId;
    const localTurnId = this.activeTurn?.threadId === validThreadId ? this.activeTurn.turnId : bufferedTurnId;
    const cachedLocalTurn = localTurnId === undefined ? undefined : previouslyLoaded?.turns.find((turn) => turn.id === localTurnId);
    const localTurn = localTurnId === undefined || freshTurns.some((turn) => turn.id === localTurnId)
      ? undefined
      : cachedLocalTurn ?? { id: localTurnId, index: freshTurns.length + 1, status: "running", items: [] };
    const freshWithLocalTurn = localTurn === undefined ? freshTurns : [...freshTurns, localTurn];
    const freshIds = new Set(freshWithLocalTurn.map((turn) => turn.id));
    const cachedOlderIds = this.olderCachedTurnIds.get(validThreadId) ?? new Set<string>();
    const readSnapshotIds = new Set(readTurns.map((turn) => turn.id));
    const readSnapshotIsComplete = thread.turns !== undefined;
    const cachedOlderTurns = previouslyLoaded?.turns.filter((turn) => cachedOlderIds.has(turn.id) && !freshIds.has(turn.id) && (!readSnapshotIsComplete || readSnapshotIds.has(turn.id))) ?? [];
    const mergedInitialTurns = mergeConversationTurns(cachedOlderTurns, freshWithLocalTurn, "append");
    const firstItemIndex = cachedOlderTurns.length > 0 && previouslyLoaded !== undefined ? previouslyLoaded.paging.firstItemIndex : view.paging.firstItemIndex;
    const initialView = { ...view, turns: mergedInitialTurns, outline: buildTurnOutline(mergedInitialTurns), paging: { ...view.paging, firstItemIndex, orderedTurnIds: mergedInitialTurns.map((turn) => turn.id) } };
    if (this.remoteActiveThreads.has(validThreadId) && !initialView.remoteActive && !page.turns.some(isActiveTurn)) this.clearRemoteActive(validThreadId);
    let nextView = this.applyObservedActivity(validThreadId, initialView, [...(thread.turns ?? []), ...page.turns]);
    if (localTurn !== undefined && cachedLocalTurn === undefined) {
      for (const update of bufferedUpdates.filter((update) => update.turnId === localTurn.id)) nextView = applyConversationUpdate(nextView, update);
    }
    if (localTurnId !== undefined) this.recentUpdates.delete(validThreadId);
    this.olderCachedTurnIds.set(validThreadId, new Set(cachedOlderTurns.map((turn) => turn.id)));
    this.loadedThreads.set(validThreadId, nextView);
    return nextView;
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
      const incomingTurns = normalizeTurnCollection(page.turns, client.turnPageOrder ?? DEFAULT_TURN_PAGE_ORDER).map((turn, index) => toConversationTurnView(turn, index));
      const turns = mergeConversationTurns(current.turns, incomingTurns, "prepend");
      const existingIds = new Set(current.turns.map((turn) => turn.id));
      const addedTurnCount = incomingTurns.filter((turn) => !existingIds.has(turn.id)).length;
      const olderIds = this.olderCachedTurnIds.get(validThreadId) ?? new Set<string>();
      for (const turn of incomingTurns) if (!existingIds.has(turn.id)) olderIds.add(turn.id);
      this.olderCachedTurnIds.set(validThreadId, olderIds);
      const repeatedCursor = page.nextCursor !== undefined && page.nextCursor === current.paging.nextCursor;
      const next = this.applyObservedActivity(validThreadId, withPaging({ ...current, turns, outline: buildTurnOutline(turns) }, {
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== undefined && !repeatedCursor,
        isLoadingMore: false,
        loadMoreError: undefined,
        firstItemIndex: Math.max(1, current.paging.firstItemIndex - addedTurnCount),
      }), page.turns);
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
    if (this.remoteActiveThreads.has(validThreadId)) throw new ActiveTurnError();
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
        const activeTurn = (resumedThread.turns ?? []).find(isActiveTurn);
        if (activeTurn !== undefined) {
          this.markRemoteActive(validThreadId, activeTurn?.id);
          throw new ActiveTurnError();
        }
      } catch (error: unknown) {
        if (error instanceof ActiveTurnError) throw error;
        if (isActiveWriterError(error)) {
          this.markRemoteActive(validThreadId);
          throw new ActiveTurnError();
        }
        if (isThreadUnavailable(error)) throw new ThreadUnavailableError(undefined, error.code);
        throw error;
      }
      let turn: Turn;
      try {
        turn = await client.startTurn(validThreadId, [{ type: "text", text: text.trim() }]);
      } catch (error: unknown) {
        if (isActiveWriterError(error)) {
          this.markRemoteActive(validThreadId);
          throw new ActiveTurnError();
        }
        throw error;
      }
      this.activeTurn = { threadId: validThreadId, turnId: turn.id };
      return { threadId: validThreadId, turnId: turn.id };
    } finally {
      this.startingTurn = false;
    }
  }

  async startNewConversation(cwd: unknown, text: unknown): Promise<StartTurnResult> {
    if (typeof cwd !== "string" || cwd.trim() === "") throw new ConfigurationError("workspace path must be a non-empty directory path");
    const validText = validateTurnText(text);
    if (this.startingTurn || this.activeTurn !== undefined) throw new ProtocolError("only one turn may run at a time");
    this.startingTurn = true;
    try {
      const client = this.clientProvider.getReadyClient();
      this.bindNotifications(client);
      const thread = await client.startThread({ cwd: cwd.trim(), ephemeral: false });
      this.loadedThreads.set(thread.id, toConversationThreadView(thread));
      let turn: Turn;
      try {
        turn = await client.startTurn(thread.id, [{ type: "text", text: validText }]);
      } catch (error: unknown) {
        if (isActiveWriterError(error)) {
          this.markRemoteActive(thread.id);
          throw new ActiveTurnError();
        }
        throw error;
      }
      this.activeTurn = { threadId: thread.id, turnId: turn.id };
      const current = this.loadedThreads.get(thread.id) ?? toConversationThreadView(thread);
      const createdTurn: ConversationTurnView = { id: turn.id, index: current.turns.length + 1, status: "running", items: [{ kind: "text", id: `${turn.id}:user`, role: "user", text: validText, phase: "historical" }] };
      const turns = mergeConversationTurns(current.turns, [createdTurn], "append");
      this.loadedThreads.set(thread.id, { ...current, turns, outline: buildTurnOutline(turns), paging: { ...current.paging, orderedTurnIds: turns.map((item) => item.id) } });
      return { threadId: thread.id, turnId: turn.id };
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
    this.remoteActiveThreads.clear();
    this.remoteActiveTurnIds.clear();
    this.recentUpdates.clear();
    this.olderCachedTurnIds.clear();
    this.loadedThreads.clear();
  }

  private bindNotifications(client: ConversationClient): void {
    if (this.boundClient === client) return;
    this.unsubscribeNotifications?.();
    this.boundClient = client;
    this.unsubscribeNotifications = client.onNotification(({ method, params }) => {
      const update = toConversationUpdate(method, params);
      if (update === undefined) return;
      const updates = this.recentUpdates.get(update.threadId) ?? [];
      updates.push(update);
      this.recentUpdates.set(update.threadId, updates.slice(-32));
      if (update.type === "turn/started") this.markRemoteActive(update.threadId, update.turnId);
      if (update.type === "turn/completed" || update.type === "turn/failed" || update.type === "turn/interrupted") {
        if (this.activeTurn?.threadId === update.threadId && this.activeTurn.turnId === update.turnId) this.activeTurn = undefined;
        this.clearRemoteActive(update.threadId, update.turnId);
      }
      const loadedThread = this.loadedThreads.get(update.threadId);
      if (loadedThread !== undefined) this.loadedThreads.set(update.threadId, applyConversationUpdate(loadedThread, update));
      for (const listener of this.updateListeners) listener(update);
    });
  }

  private applyObservedActivity(threadId: string, view: ConversationThreadView, observedTurns: readonly Turn[]): ConversationThreadView {
    const activeTurn = observedTurns.find(isActiveTurn);
    if (activeTurn !== undefined) this.markRemoteActive(threadId, activeTurn.id);
    return this.withKnownActivity(threadId, view);
  }

  private withKnownActivity(threadId: string, view: ConversationThreadView): ConversationThreadView {
    if (!this.remoteActiveThreads.has(threadId)) return withoutRemoteActivity(view);
    const activeTurnId = this.remoteActiveTurnIds.get(threadId);
    return { ...withoutRemoteActivity(view), remoteActive: true, ...(activeTurnId === undefined ? {} : { remoteActiveTurnId: activeTurnId }) };
  }

  private markRemoteActive(threadId: string, turnId?: string): void {
    this.remoteActiveThreads.add(threadId);
    if (turnId !== undefined) this.remoteActiveTurnIds.set(threadId, turnId);
    const loaded = this.loadedThreads.get(threadId);
    if (loaded !== undefined) this.loadedThreads.set(threadId, this.withKnownActivity(threadId, loaded));
  }

  private clearRemoteActive(threadId: string, turnId?: string): void {
    const knownTurnId = this.remoteActiveTurnIds.get(threadId);
    if (turnId !== undefined && knownTurnId !== undefined && turnId !== knownTurnId) return;
    this.remoteActiveThreads.delete(threadId);
    this.remoteActiveTurnIds.delete(threadId);
    const loaded = this.loadedThreads.get(threadId);
    if (loaded !== undefined) this.loadedThreads.set(threadId, withoutRemoteActivity(loaded));
  }
}

function isThreadUnavailable(error: unknown): error is AppServerError {
  return error instanceof AppServerError && (/thread[\s_-]*(not[\s_-]*found|unavailable|deleted)/i.test(error.message) || (typeof error.code === "string" && /thread[\s_-]*(not[\s_-]*found|unavailable|deleted)/i.test(error.code)));
}

function isActiveWriterError(error: unknown): boolean {
  if (!(error instanceof AppServerError)) return error instanceof Error && /already has an active writer|active writer/i.test(error.message);
  return /already has an active writer|active writer/i.test(`${error.message} ${String(error.code)}`);
}

function validateTurnText(text: unknown): string {
  if (typeof text !== "string" || text.trim() === "" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new ConfigurationError("turn text must be non-empty plain text");
  return text.trim();
}

function isActiveStatus(status: string | undefined): boolean {
  return status !== undefined && /^(running|in_progress|started|pending|queued)$/i.test(status.trim());
}

function isActiveTurn(turn: Turn): boolean { return isActiveStatus(turn.status); }

function normalizeTurnCollection(turns: readonly Turn[], order: TurnCollectionOrder): Turn[] {
  if (order === "oldest-first") return [...turns];
  const normalized: Turn[] = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn !== undefined) normalized.push(turn);
  }
  return normalized;
}

export function toConversationThreadView(thread: Thread): ConversationThreadView {
  const turns = (thread.turns ?? []).map((turn, index) => toConversationTurnView(turn, index));
  const activeTurn = turns.find((turn) => isActiveStatus(turn.status));
  return {
    id: thread.id,
    title: thread.title?.trim() || thread.name?.trim() || "Untitled thread",
    status: thread.status?.trim() || "unknown",
    ...(thread.canAcceptDirectInput === undefined ? {} : { canAcceptDirectInput: thread.canAcceptDirectInput }),
    ...(thread.cwd === undefined ? {} : { workspacePath: thread.cwd }),
    ...(activeTurn === undefined ? {} : { remoteActive: true, remoteActiveTurnId: activeTurn.id }),
    turns,
    outline: buildTurnOutline(turns),
    paging: { orderedTurnIds: turns.map((turn) => turn.id), firstItemIndex: INITIAL_FIRST_ITEM_INDEX, hasMore: false, isLoadingMore: false },
  };
}

function withPaging(thread: ConversationThreadView, update: Partial<ConversationPagingState>): ConversationThreadView {
  return { ...thread, paging: { ...thread.paging, ...update, orderedTurnIds: thread.turns.map((turn) => turn.id) } };
}

export function mergeConversationTurns(existing: readonly ConversationTurnView[], incoming: readonly ConversationTurnView[], placement: "append" | "prepend" = "append"): ConversationTurnView[] {
  const byId = new Map<string, ConversationTurnView>();
  const existingIds = new Set(existing.map((turn) => turn.id));
  const newIncoming = incoming.filter((turn) => !existingIds.has(turn.id));
  const order = (placement === "prepend" ? [...newIncoming, ...existing] : [...existing, ...newIncoming]).map((turn) => turn.id);
  for (const turn of existing) byId.set(turn.id, turn);
  for (const turn of incoming) {
    const prior = byId.get(turn.id);
    byId.set(turn.id, prior === undefined ? turn : mergeConversationTurn(prior, turn));
  }
  return order.map((id) => byId.get(id)).filter((turn): turn is ConversationTurnView => turn !== undefined).map((turn, index) => ({ ...turn, index: index + 1 }));
}

function mergeConversationSources(base: readonly ConversationTurnView[], incoming: readonly ConversationTurnView[]): ConversationTurnView[] {
  const byId = new Map(base.map((turn) => [turn.id, turn]));
  const order = base.map((turn) => turn.id);
  for (let incomingIndex = 0; incomingIndex < incoming.length; incomingIndex += 1) {
    const turn = incoming[incomingIndex];
    if (turn === undefined) continue;
    const prior = byId.get(turn.id);
    if (prior !== undefined) {
      byId.set(turn.id, mergeConversationTurn(prior, turn));
      continue;
    }
    const nextKnownId = incoming.slice(incomingIndex + 1).find((candidate) => candidate !== undefined && byId.has(candidate.id))?.id;
    const nextIndex = nextKnownId === undefined ? -1 : order.indexOf(nextKnownId);
    if (nextIndex >= 0) order.splice(nextIndex, 0, turn.id);
    else order.push(turn.id);
    byId.set(turn.id, turn);
  }
  return order.map((id) => byId.get(id)).filter((turn): turn is ConversationTurnView => turn !== undefined).map((turn, index) => ({ ...turn, index: index + 1 }));
}

function withoutRemoteActivity(view: ConversationThreadView): ConversationThreadView {
  const { remoteActive: _remoteActive, remoteActiveTurnId: _remoteActiveTurnId, ...inactiveView } = view;
  return inactiveView;
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
  if (existing.kind === "text" && incoming.kind === "text") {
    const text = incoming.text.length >= existing.text.length ? incoming.text : existing.text;
    const phase = textPhaseRank(incoming.phase) >= textPhaseRank(existing.phase) ? incoming.phase : existing.phase;
    return { ...existing, ...incoming, text, phase };
  }
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

function textPhaseRank(phase: Extract<ConversationItemView, { kind: "text" }>["phase"]): number {
  if (phase === "final") return 2;
  if (phase === "streaming") return 1;
  return 0;
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
  const active = isActiveTurn(turn);
  return {
    id: turn.id,
    index: index + 1,
    status: turn.status?.trim() || "unknown",
    ...(turn.createdAt === undefined ? {} : { createdAt: turn.createdAt }),
    items: (turn.items ?? []).map((item, itemIndex) => toConversationItemView(item, turn.id, itemIndex, active)),
  };
}

function toConversationItemView(item: TurnItem, turnId: string, itemIndex: number, active = false): ConversationItemView {
  const id = item.id?.trim() || `${turnId}:item-${itemIndex + 1}`;
  const type = item.type?.trim().toLowerCase() ?? "";
  const text = displayText(item.text ?? item.content);
  const role = textRole(item, type);
  if (role !== undefined) {
    const phase = role === "user" ? "historical" : active ? "streaming" : "final";
    return { kind: "text", id, role, text: text || "(No text provided)", phase };
  }
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
