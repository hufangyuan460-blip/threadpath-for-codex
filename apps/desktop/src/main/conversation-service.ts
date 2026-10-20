import { ActiveTurnError, AppServerError, CompatibilityError, ConfigurationError, ProtocolError, ThreadUnavailableError, type ForkThreadOptions, type JsonObject, type JsonValue, type StartTurnOptions, type TerminalTurnEvent, type Thread, type Turn, type TurnInput, type TurnItem, type TurnPage, isJsonObject, readString, terminalTurnEvent } from "../../../../threadpath-protocol/src/protocol.ts";
import type { ConversationItemView, ConversationPagingState, ConversationThreadView, ConversationTurnView, ConversationUpdate, SearchResult, StartTurnResult } from "../shared/api";
import { type ThreadClient, type ThreadClientProvider, validateThreadId } from "./thread-service.ts";
import { buildTurnOutline } from "../shared/outline.ts";
import { applyConversationUpdate } from "../shared/conversation-state.ts";
import { searchLoadedTurns } from "./search-service.ts";
import { ObservatoryService } from "./observatory-service.ts";
import { knownTerminalStatus, UNCONFIRMED_TURN_STATUS_MESSAGE } from "../../../../threadpath-protocol/src/protocol.ts";

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
  startThread(options: { cwd: string; ephemeral?: boolean; model?: string }): Promise<Thread>;
  listTurns(threadId: string, options?: { limit?: number; cursor?: string }): Promise<TurnPage>;
  resumeThread(threadId: string, options?: { sandbox?: "read-only" }): Promise<Thread>;
  forkThread?(threadId: string, options?: ForkThreadOptions): Promise<Thread>;
  startTurn(threadId: string, input: readonly TurnInput[], options?: StartTurnOptions): Promise<Turn>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  waitForTurnTerminal?(turnId: string): Promise<TerminalTurnEvent>;
  onNotification(listener: (event: { method: string; params: JsonObject }) => void): () => void;
}

export interface ConversationClientProvider {
  getReadyClient(): ConversationClient;
}

export type ConversationUpdateListener = (update: ConversationUpdate) => void;

export interface ConversationReconciliation {
  readonly thread: ConversationThreadView;
  readonly activity: "active" | "idle";
}

export class ConversationService {
  readonly observatory = new ObservatoryService();
  private readonly clientProvider: ConversationClientProvider;
  private readonly updateListeners = new Set<ConversationUpdateListener>();
  private boundClient: ConversationClient | undefined;
  private unsubscribeNotifications: (() => void) | undefined;
  private readonly loadedThreads = new Map<string, ConversationThreadView>();
  private readonly historyReadEpoch = new Map<string, number>();
  private nextHistoryReadEpoch = 0;
  /** Accepted text is independent of history/UI caches until a raw server echo confirms it. */
  private readonly pendingLocalInputs = new Map<string, Map<string, string>>();
  private readonly lastReadActiveTurnIds = new Map<string, readonly string[]>();
  private readonly olderCachedTurnIds = new Map<string, Set<string>>();
  private readonly remoteActiveThreads = new Set<string>();
  private readonly remoteActiveTurnIds = new Map<string, string>();
  /**
   * Current app-server versions do not guarantee that turn/item notifications
   * include a threadId. Keep only the turn ownership learned from thread data
   * and turns started through this client so those notifications stay scoped.
   */
  private readonly threadIdByTurnId = new Map<string, string>();
  private readonly recentUpdates = new Map<string, ConversationUpdate[]>();
  private readonly settledTurnIds = new Set<string>();
  private activeTurn: { threadId: string; turnId: string } | undefined;
  private startingTurn = false;
  private readonly isReadOnlyThread: (threadId: string) => boolean;

  constructor(clientProvider: ConversationClientProvider, isReadOnlyThread: (threadId: string) => boolean = () => false) {
    this.clientProvider = clientProvider;
    this.isReadOnlyThread = isReadOnlyThread;
  }

  async readThread(threadId: unknown): Promise<ConversationThreadView> {
    const validThreadId = validateThreadId(threadId);
    const epoch = this.beginHistoryRead(validThreadId);
    const client = this.clientProvider.getReadyClient();
    this.bindNotifications(client);
    const thread = await client.readThread(validThreadId);
    this.requireCurrentHistoryRead(validThreadId, epoch);
    if (thread.id !== validThreadId) throw new ProtocolError("History response belongs to another thread");
    const page = await client.listTurns(validThreadId, { limit: 20 });
    this.requireCurrentHistoryRead(validThreadId, epoch);
    this.observatory.observeHistory(validThreadId, [...(thread.turns ?? []), ...page.turns]);
    this.lastReadActiveTurnIds.set(validThreadId, [...new Set([...(thread.turns ?? []), ...page.turns].filter(isActiveTurn).map((turn) => turn.id))]);
    const readTurns = normalizeTurnCollection(thread.turns ?? [], client.threadReadOrder ?? DEFAULT_THREAD_READ_ORDER);
    const pageTurns = normalizeTurnCollection(page.turns, client.turnPageOrder ?? DEFAULT_TURN_PAGE_ORDER);
    const parsedTurns = mergeConversationSources(
      readTurns.map((turn, index) => toConversationTurnView(turn, index)),
      pageTurns.map((turn, index) => toConversationTurnView(turn, index)),
    );
    const previouslyLoaded = this.loadedThreads.get(validThreadId);
    const cachedTurns = new Map(previouslyLoaded?.turns.map((turn) => [turn.id, this.withoutLocalInput(validThreadId, turn)]));
    const protectedTurns = parsedTurns.map((turn) => {
      const cached = cachedTurns.get(turn.id);
      return cached !== undefined && (cached.itemsView !== undefined || turn.itemsView !== undefined) ? mergeConversationTurn(cached, turn) : turn;
    });
    const freshTurns = protectedTurns;
    const view = withPaging(toConversationThreadView({ ...thread, turns: [] }), {
      nextCursor: page.nextCursor,
      hasMore: page.nextCursor !== undefined,
      loadMoreError: undefined,
    });
    const bufferedUpdates = this.recentUpdates.get(validThreadId) ?? [];
    const bufferedTurnId = bufferedUpdates.at(-1)?.turnId;
    const localTurnId = this.activeTurn?.threadId === validThreadId ? this.activeTurn.turnId : bufferedTurnId;
    const cachedLocalTurn = localTurnId === undefined ? undefined : previouslyLoaded?.turns.find((turn) => turn.id === localTurnId);
    const localTurn = localTurnId === undefined || freshTurns.some((turn) => turn.id === localTurnId)
      ? undefined
      : cachedLocalTurn === undefined ? { id: localTurnId, index: freshTurns.length + 1, status: "running", items: [] } : this.withoutLocalInput(validThreadId, cachedLocalTurn);
    const freshWithLocalTurn = localTurn === undefined ? freshTurns : [...freshTurns, localTurn];
    for (const turn of freshWithLocalTurn) this.rememberTurn(validThreadId, turn.id);
    const freshIds = new Set(freshWithLocalTurn.map((turn) => turn.id));
    const cachedOlderIds = this.olderCachedTurnIds.get(validThreadId) ?? new Set<string>();
    const readSnapshotIds = new Set(readTurns.map((turn) => turn.id));
    const readSnapshotIsComplete = thread.turns !== undefined && thread.historyMode !== "paginated"
      && ![...thread.turns, ...page.turns].some((turn) => turn.itemsView === "notLoaded" || turn.itemsView === "summary");
    const cachedOlderTurns = previouslyLoaded?.turns.filter((turn) => cachedOlderIds.has(turn.id) && !freshIds.has(turn.id) && (!readSnapshotIsComplete || readSnapshotIds.has(turn.id))).map((turn) => this.withoutLocalInput(validThreadId, turn)) ?? [];
    const mergedInitialTurns = mergeConversationTurns(cachedOlderTurns, freshWithLocalTurn, "append");
    const firstItemIndex = cachedOlderTurns.length > 0 && previouslyLoaded !== undefined ? previouslyLoaded.paging.firstItemIndex : view.paging.firstItemIndex;
    const initialView = { ...view, turns: mergedInitialTurns, outline: buildTurnOutline(mergedInitialTurns), paging: { ...view.paging, firstItemIndex, orderedTurnIds: mergedInitialTurns.map((turn) => turn.id) } };
    let nextView = this.applyObservedActivity(validThreadId, initialView, [...(thread.turns ?? []), ...page.turns], thread.status);
    if (localTurn !== undefined && cachedLocalTurn === undefined) {
      for (const update of bufferedUpdates.filter((update) => update.turnId === localTurn.id)) nextView = applyConversationUpdate(nextView, update);
    }
    if (localTurnId !== undefined) this.recentUpdates.delete(validThreadId);
    this.olderCachedTurnIds.set(validThreadId, new Set(cachedOlderTurns.map((turn) => turn.id)));
    nextView = this.withObservedCompactions(validThreadId, nextView);
    const turns = this.preserveAcceptedInput(validThreadId, nextView.turns, previouslyLoaded, [...readTurns, ...pageTurns]);
    nextView = withPaging({ ...nextView, turns, outline: buildTurnOutline(turns) }, {});
    this.loadedThreads.set(validThreadId, nextView);
    return nextView;
  }

  async loadMoreTurns(threadId: unknown): Promise<ConversationThreadView> {
    const validThreadId = validateThreadId(threadId);
    const current = this.loadedThreads.get(validThreadId);
    if (current === undefined) throw new ProtocolError("thread must be loaded before requesting earlier turns");
    if (!current.paging.hasMore) return current;
    if (current.paging.isLoadingMore) throw new ProtocolError("an earlier-turn request is already running");
    const epoch = this.beginHistoryRead(validThreadId);
    const client = this.clientProvider.getReadyClient();
    this.bindNotifications(client);
    const loading = withPaging(current, { isLoadingMore: true, loadMoreError: undefined });
    this.loadedThreads.set(validThreadId, loading);
    try {
      const page = await client.listTurns(validThreadId, { limit: 20, cursor: current.paging.nextCursor });
      this.requireCurrentHistoryRead(validThreadId, epoch);
      this.observatory.observeHistory(validThreadId, page.turns);
      const parsed = normalizeTurnCollection(page.turns, client.turnPageOrder ?? DEFAULT_TURN_PAGE_ORDER).map((turn, index) => toConversationTurnView(turn, index));
      const cached = this.loadedThreads.get(validThreadId) ?? current;
      const serverCachedTurns = cached.turns.map((turn) => this.withoutLocalInput(validThreadId, turn));
      for (const turn of parsed) this.rememberTurn(validThreadId, turn.id);
      const serverTurns = mergeConversationTurns(serverCachedTurns, parsed, "prepend");
      const turns = this.preserveAcceptedInput(validThreadId, serverTurns, cached, page.turns);
      const existingIds = new Set(cached.turns.map((turn) => turn.id));
      const addedTurnCount = parsed.filter((turn) => !existingIds.has(turn.id)).length;
      const olderIds = this.olderCachedTurnIds.get(validThreadId) ?? new Set<string>();
      for (const turn of parsed) if (!existingIds.has(turn.id)) olderIds.add(turn.id);
      this.olderCachedTurnIds.set(validThreadId, olderIds);
      const repeatedCursor = page.nextCursor !== undefined && page.nextCursor === current.paging.nextCursor;
      const next = this.withObservedCompactions(validThreadId, this.applyObservedActivity(validThreadId, withPaging({ ...cached, turns, outline: buildTurnOutline(turns) }, {
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== undefined && !repeatedCursor,
        isLoadingMore: false,
        loadMoreError: undefined,
        firstItemIndex: Math.max(1, current.paging.firstItemIndex - addedTurnCount),
      }), page.turns));
      this.loadedThreads.set(validThreadId, next);
      return next;
    } catch (error: unknown) {
      if (this.historyReadEpoch.get(validThreadId) !== epoch && this.loadedThreads.get(validThreadId) === loading) {
        this.loadedThreads.set(validThreadId, withPaging(loading, { isLoadingMore: false }));
      }
      this.requireCurrentHistoryRead(validThreadId, epoch);
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

  async reconcileThread(threadId: unknown): Promise<ConversationReconciliation> {
    const validThreadId = validateThreadId(threadId);
    // Reconciliation is deliberately read-only. Calling thread/resume here and
    // again immediately before turn/start made one send perform two resumes;
    // some app-server versions can report the second call as an active writer.
    const thread = await this.readThread(validThreadId);
    const localTurnId = this.activeTurn?.threadId === validThreadId ? this.activeTurn.turnId : undefined;
    // Accepted-message placeholders are display state, not server activity evidence.
    const activeTurnId = this.lastReadActiveTurnIds.get(validThreadId)?.find((turnId) => turnId !== localTurnId);
    const serverActive = activeTurnId !== undefined || isActiveThreadStatus(thread.status);
    if (serverActive) {
      this.markRemoteActive(validThreadId, activeTurnId);
      return { thread: this.withKnownActivity(validThreadId, thread), activity: "active" };
    }
    // A successful idle snapshot is authoritative. It also recovers a local
    // running flag when a terminal notification was missed.
    if (this.activeTurn?.threadId === validThreadId) this.activeTurn = undefined;
    this.clearRemoteActive(validThreadId);
    const idleThread = withoutRemoteActivity(thread);
    this.loadedThreads.set(validThreadId, idleThread);
    return { thread: idleThread, activity: "idle" };
  }

  async startTurn(threadId: unknown, text: unknown, options: unknown = undefined): Promise<StartTurnResult> {
    const validThreadId = validateThreadId(threadId);
    if (typeof text !== "string" || text.trim() === "" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new ConfigurationError("turn text must be non-empty plain text");
    }
    const startOptions = validateComposerOptions(options);
    if (this.remoteActiveThreads.has(validThreadId)) throw new ActiveTurnError("This conversation has a confirmed active turn. Refresh its status before sending another message.");
    if (this.startingTurn || this.activeTurn !== undefined) throw new ProtocolError("only one turn may run at a time");
    this.startingTurn = true;
    try {
      const client = this.clientProvider.getReadyClient();
      this.bindNotifications(client);
      // thread/read only reads history. thread/resume is the verified app-server
      // operation that reactivates an existing thread for a subsequent turn.
      try {
        this.observatory.beginResume(validThreadId);
        const resumedThread = await client.resumeThread(validThreadId, this.isReadOnlyThread(validThreadId) ? { sandbox: "read-only" } : undefined);
        this.observatory.completeResume(validThreadId);
        this.observatory.observeHistory(validThreadId, resumedThread.turns ?? []);
        if (resumedThread.canAcceptDirectInput === false) {
          throw new ThreadUnavailableError("This thread cannot accept direct input. Refresh the thread list and choose another thread.");
        }
        const activeTurn = (resumedThread.turns ?? []).find(isActiveTurn);
        if (activeTurn !== undefined) {
          this.markRemoteActive(validThreadId, activeTurn?.id);
          throw new ActiveTurnError("This conversation has a confirmed active turn. Refresh its status before sending another message.");
        }
      } catch (error: unknown) {
        this.observatory.cancelResume(validThreadId);
        if (error instanceof ActiveTurnError) throw error;
        if (isActiveWriterError(error)) {
          throw new ActiveTurnError("Codex reported an active writer, but no active turn was confirmed. Refresh status and try again.");
        }
        if (isThreadUnavailable(error)) throw new ThreadUnavailableError(undefined, error.code);
        throw error;
      }
      let turn: Turn;
      try {
        // After issuing turn/start, an uncorrelated usage notification may
        // belong to the new turn even before its RPC response arrives.
        this.observatory.cancelResume(validThreadId);
        turn = await client.startTurn(validThreadId, [{ type: "text", text: text.trim() }], startOptions);
      } catch (error: unknown) {
        if (isActiveWriterError(error)) {
          throw new ActiveTurnError("Codex reported an active writer, but no active turn was confirmed. Refresh status and try again.");
        }
        throw error;
      }
      if (!this.settledTurnIds.has(turn.id)) this.activeTurn = { threadId: validThreadId, turnId: turn.id };
      this.observatory.observeLiveTurn(validThreadId, turn.id);
      this.rememberTurn(validThreadId, turn.id);
      this.watchTurnTerminal(client, validThreadId, turn.id);
      this.rememberAcceptedInput(validThreadId, turn.id, text.trim());
      return { threadId: validThreadId, turnId: turn.id };
    } finally {
      // Success consumes the marker on a snapshot or new turn; every failure
      // path also clears it, including a rejected turn/start after resume.
      this.observatory.cancelResume(validThreadId);
      this.startingTurn = false;
    }
  }

  async interruptTurn(threadId: unknown): Promise<void> {
    const validThreadId = validateThreadId(threadId);
    const active = this.activeTurn;
    if (active === undefined || active.threadId !== validThreadId) throw new ActiveTurnError("Only a turn started by ThreadPath can be stopped here.");
    const client = this.clientProvider.getReadyClient();
    this.bindNotifications(client);
    await client.interruptTurn(validThreadId, active.turnId);
  }

  async forkConversation(threadId: unknown, turnId: unknown, cwd: string): Promise<Thread> {
    const sourceId = validateThreadId(threadId);
    const cutoffId = validateThreadId(turnId);
    const source = this.loadedThreads.get(sourceId);
    const cutoff = source?.turns.find((turn) => turn.id === cutoffId);
    if (cutoff === undefined) throw new ConfigurationError("Load the source turn before branching");
    if (cutoff.terminalIssue !== undefined || !["completed", "failed", "interrupted"].includes(cutoff.status)) throw new ActiveTurnError("Only a confirmed ended turn can be used as a branch point");
    if (source?.remoteActive || this.startingTurn || this.activeTurn !== undefined) throw new ActiveTurnError("Wait for the running conversation before branching");
    const client = this.clientProvider.getReadyClient();
    if (client.forkThread === undefined) throw new CompatibilityError("This Codex client does not support branching");
    this.bindNotifications(client);
    this.startingTurn = true;
    try {
      const fork = await client.forkThread(sourceId, { lastTurnId: cutoffId, cwd, ephemeral: false, sandbox: "read-only" });
      if (fork.id === sourceId || fork.forkedFromId !== sourceId) throw new ProtocolError("Codex did not return the expected branch source");
      this.loadedThreads.set(fork.id, toConversationThreadView(fork));
      this.observatory.observeHistory(fork.id, fork.turns ?? []);
      return fork;
    } finally { this.startingTurn = false; }
  }

  async startNewConversation(cwd: unknown, text: unknown, options: unknown = undefined): Promise<StartTurnResult> {
    if (typeof cwd !== "string" || cwd.trim() === "") throw new ConfigurationError("workspace path must be a non-empty directory path");
    const validText = validateTurnText(text);
    const startOptions = validateComposerOptions(options);
    if (this.startingTurn || this.activeTurn !== undefined) throw new ProtocolError("only one turn may run at a time");
    this.startingTurn = true;
    try {
      const client = this.clientProvider.getReadyClient();
      this.bindNotifications(client);
      const thread = await client.startThread({ cwd: cwd.trim(), ephemeral: false, ...(startOptions.model === undefined ? {} : { model: startOptions.model }) });
      this.loadedThreads.set(thread.id, toConversationThreadView(thread));
      let turn: Turn;
      try {
        turn = await client.startTurn(thread.id, [{ type: "text", text: validText }], startOptions);
      } catch (error: unknown) {
        if (isActiveWriterError(error)) {
          this.markRemoteActive(thread.id);
          throw new ActiveTurnError();
        }
        throw error;
      }
      if (!this.settledTurnIds.has(turn.id)) this.activeTurn = { threadId: thread.id, turnId: turn.id };
      this.observatory.observeLiveTurn(thread.id, turn.id);
      this.rememberTurn(thread.id, turn.id);
      this.watchTurnTerminal(client, thread.id, turn.id);
      this.rememberAcceptedInput(thread.id, turn.id, validText);
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
    this.observatory.disconnected();
    this.unsubscribeNotifications?.();
    this.unsubscribeNotifications = undefined;
    this.boundClient = undefined;
    this.activeTurn = undefined;
    this.remoteActiveThreads.clear();
    this.remoteActiveTurnIds.clear();
    this.threadIdByTurnId.clear();
    this.settledTurnIds.clear();
    this.recentUpdates.clear();
    this.olderCachedTurnIds.clear();
    this.loadedThreads.clear();
    this.historyReadEpoch.clear();
    this.pendingLocalInputs.clear();
    this.lastReadActiveTurnIds.clear();
  }

  private rememberAcceptedInput(threadId: string, turnId: string, text: string): void {
    const current = this.loadedThreads.get(threadId) ?? toConversationThreadView({ id: threadId, turns: [] });
    const existing = current.turns.find((turn) => turn.id === turnId);
    const user: ConversationItemView = { kind: "text", id: `${turnId}:user`, role: "user", text, phase: "historical" };
    const created: ConversationTurnView = { ...existing, id: turnId, index: existing?.index ?? current.turns.length + 1, status: existing?.status ?? "running", items: [user, ...existing?.items.filter((item) => !(item.kind === "text" && item.role === "user")) ?? []] };
    const turns = current.turns.some((turn) => turn.id === turnId) ? current.turns.map((turn) => turn.id === turnId ? created : turn) : [...current.turns, created];
    let next: ConversationThreadView = { ...current, turns, outline: buildTurnOutline(turns), paging: { ...current.paging, orderedTurnIds: turns.map((turn) => turn.id) } };
    if (existing === undefined) {
      for (const update of this.recentUpdates.get(threadId) ?? []) {
        if (update.turnId === turnId) next = applyConversationUpdate(next, update);
      }
    }
    this.loadedThreads.set(threadId, next);
    const pending = this.pendingLocalInputs.get(threadId) ?? new Map<string, string>();
    pending.set(turnId, text);
    this.pendingLocalInputs.set(threadId, pending);
  }

  private beginHistoryRead(threadId: string): number {
    const epoch = ++this.nextHistoryReadEpoch;
    this.historyReadEpoch.set(threadId, epoch);
    return epoch;
  }

  private requireCurrentHistoryRead(threadId: string, epoch: number): void {
    if (this.historyReadEpoch.get(threadId) !== epoch) throw new ProtocolError("History request was superseded by a newer request");
  }

  private withoutLocalInput(threadId: string, turn: ConversationTurnView): ConversationTurnView {
    return this.pendingLocalInputs.get(threadId)?.has(turn.id)
      ? { ...turn, items: turn.items.filter((item) => item.id !== `${turn.id}:user`) } : turn;
  }

  private preserveAcceptedInput(threadId: string, fresh: readonly ConversationTurnView[], cached: ConversationThreadView | undefined, serverTurns: readonly Turn[]): ConversationTurnView[] {
    const pending = this.pendingLocalInputs.get(threadId);
    if (pending === undefined) return [...fresh];
    const projected = [...fresh];
    for (const [turnId, text] of pending) {
      const confirmed = serverTurns.some((serverTurn) => serverTurn.id === turnId && serverTurn.itemsView !== "notLoaded" && serverTurn.items?.some((item) =>
        typeof item.id === "string" && item.id.trim() !== "" && textRole(item, item.type?.toLowerCase() ?? "") === "user" && displayText(item.text ?? item.content) === text));
      if (confirmed) {
        pending.delete(turnId);
        continue;
      }
      const index = projected.findIndex((turn) => turn.id === turnId);
      const remote = index < 0 ? cached?.turns.find((turn) => turn.id === turnId) ?? { id: turnId, index: projected.length + 1, status: "running", items: [] } : projected[index]!;
      const accepted: ConversationItemView = { kind: "text", id: `${turnId}:user`, role: "user", text, phase: "historical" };
      // Keep the existing empty/partial input deferral only for stable raw IDs.
      // Unidentifiable server users stay visible; they cannot confirm or be silently discarded.
      const partialIds = new Set(serverTurns.filter((turn) => turn.id === turnId && turn.itemsView !== "notLoaded").flatMap((turn) => turn.items ?? []).filter((item) =>
        typeof item.id === "string" && item.id.trim() !== "" && textRole(item, item.type?.toLowerCase() ?? "") === "user" && text.startsWith(displayText(item.text ?? item.content))).map((item) => item.id));
      const items = [accepted, ...remote.items.filter((item) => item.id !== accepted.id && !partialIds.has(item.id))];
      const turn = { ...remote, items };
      if (index < 0) projected.push(turn);
      else projected[index] = turn;
    }
    if (pending.size === 0) this.pendingLocalInputs.delete(threadId);
    return projected.map((turn, index) => ({ ...turn, index: index + 1 }));
  }

  private withObservedCompactions(threadId: string, view: ConversationThreadView): ConversationThreadView {
    const observations = this.observatory.get(threadId).compactions;
    if (observations.length === 0) return view;
    const turns = view.turns.map((turn) => ({ ...turn, items: turn.items.map((item) => {
      if (item.kind !== "compaction") return item;
      const observed = observations.find((candidate) => candidate.turnId === turn.id && candidate.itemId === item.id);
      // Reuse the existing merge rule; historical unknown cannot erase a live
      // status. The observatory already owns the thread/turn/item identity.
      return observed === undefined ? item : mergeConversationItem({ kind: "compaction", id: item.id, status: observed.status }, item);
    }) }));
    return { ...view, turns };
  }

  private bindNotifications(client: ConversationClient): void {
    if (this.boundClient === client) return;
    this.unsubscribeNotifications?.();
    this.boundClient = client;
    this.unsubscribeNotifications = client.onNotification(({ method, params }) => {
      this.observatory.observeNotification(method, params, this.threadIdForNotification(params));
      const update = toConversationUpdate(method, params, this.threadIdForNotification(params));
      if (update === undefined) return;
      this.receiveUpdate(update);
    });
  }

  connectionChanged(state: string): void {
    if (state === "ready") this.bindNotifications(this.clientProvider.getReadyClient());
    else {
      this.unsubscribeNotifications?.();
      this.unsubscribeNotifications = undefined;
      this.boundClient = undefined;
      this.observatory.disconnected();
      for (const [id, thread] of this.loadedThreads) this.loadedThreads.set(id, { ...thread, turns: thread.turns.map((turn) => ({ ...turn, items: turn.items.map((item) => item.kind === "compaction" && item.status === "started" ? { ...item, status: "unknown" as const } : item) })) });
    }
  }

  private watchTurnTerminal(client: ConversationClient, threadId: string, turnId: string): void {
    if (client.waitForTurnTerminal === undefined) return;
    void client.waitForTurnTerminal(turnId).then((terminal) => {
      const type = terminal.outcome === "failed" ? "turn/failed" : terminal.outcome === "interrupted" ? "turn/interrupted" : "turn/completed";
      this.receiveUpdate({ type, threadId, turnId, ...(terminal.error === undefined ? {} : { message: terminal.error.message }), ...(terminal.error instanceof CompatibilityError ? { terminalIssue: "compatibility" as const } : {}) });
    }).catch(() => undefined);
  }

  private receiveUpdate(update: ConversationUpdate): void {
    if (update.type === "turn/started" && this.settledTurnIds.has(update.turnId)) return;
    const terminal = update.type === "turn/completed" || update.type === "turn/failed" || update.type === "turn/interrupted";
    if (terminal && this.activeTurn?.threadId === update.threadId && this.activeTurn.turnId === update.turnId) this.activeTurn = undefined;
    const previousTerminal = this.recentUpdates.get(update.threadId)?.slice().reverse().find((candidate) => candidate.turnId === update.turnId && (candidate.type === "turn/completed" || candidate.type === "turn/failed" || candidate.type === "turn/interrupted"));
    const previousTurn = this.loadedThreads.get(update.threadId)?.turns.find((turn) => turn.id === update.turnId);
    const resolvesUncertainty = terminal && update.terminalIssue === undefined && (previousTurn?.terminalIssue === "compatibility" || previousTerminal !== undefined && "terminalIssue" in previousTerminal && previousTerminal.terminalIssue === "compatibility");
    if (terminal && this.settledTurnIds.has(update.turnId) && !resolvesUncertainty) return;
    if (terminal) {
      this.settledTurnIds.add(update.turnId);
      while (this.settledTurnIds.size > 512) {
        const oldestTurnId = this.settledTurnIds.values().next().value;
        if (oldestTurnId === undefined) break;
        this.settledTurnIds.delete(oldestTurnId);
      }
    }
    const updates = this.recentUpdates.get(update.threadId) ?? [];
    updates.push(update);
    this.recentUpdates.set(update.threadId, updates.slice(-32));
    if (update.type === "turn/started") this.markRemoteActive(update.threadId, update.turnId);
    if (terminal) {
      if (this.activeTurn?.threadId === update.threadId && this.activeTurn.turnId === update.turnId) this.activeTurn = undefined;
      this.clearRemoteActive(update.threadId, update.turnId);
      this.threadIdByTurnId.delete(update.turnId);
    }
    const loadedThread = this.loadedThreads.get(update.threadId);
    if (loadedThread !== undefined) this.loadedThreads.set(update.threadId, applyConversationUpdate(loadedThread, update));
    for (const listener of this.updateListeners) listener(update);
  }

  private applyObservedActivity(threadId: string, view: ConversationThreadView, observedTurns: readonly Turn[], threadStatus?: string): ConversationThreadView {
    const activeTurn = observedTurns.find(isActiveTurn);
    if (activeTurn !== undefined || isActiveThreadStatus(threadStatus)) this.markRemoteActive(threadId, activeTurn?.id);
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

  private rememberTurn(threadId: string, turnId: string): void {
    this.threadIdByTurnId.set(turnId, threadId);
    // The mapping is only a notification bridge, not persistent history. A
    // bounded cache prevents a long loaded history from retaining every turn.
    while (this.threadIdByTurnId.size > 512) {
      const oldestTurnId = this.threadIdByTurnId.keys().next().value;
      if (oldestTurnId === undefined) return;
      this.threadIdByTurnId.delete(oldestTurnId);
    }
  }

  private threadIdForNotification(params: JsonObject): string | undefined {
    const turn = isJsonObject(params.turn) ? params.turn : undefined;
    const explicitThreadId = readString(params, "threadId") ?? (turn === undefined ? undefined : readString(turn, "threadId"));
    if (explicitThreadId !== undefined) return explicitThreadId;
    const turnId = readString(params, "turnId") ?? (turn === undefined ? undefined : readString(turn, "id"));
    return turnId === undefined ? undefined : this.threadIdByTurnId.get(turnId);
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

function validateComposerOptions(options: unknown): StartTurnOptions {
  if (options === undefined) return {};
  if (!isJsonObject(options) || Object.keys(options).some((key) => key !== "model" && key !== "effort")) throw new ConfigurationError("composer options must contain only model and effort");
  const validate = (key: "model" | "effort"): string | undefined => {
    const value = options[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "" || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw new ConfigurationError(`composer ${key} must be a short plain-text value`);
    return value.trim();
  };
  const model = validate("model");
  const effort = validate("effort");
  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
}

function isActiveStatus(status: string | undefined): boolean {
  return status !== undefined && /^(active|running|in_progress|inprogress|started|pending|queued)$/i.test(status.trim());
}

function isActiveThreadStatus(status: string | undefined): boolean {
  return status !== undefined && (status.trim().toLowerCase() === "active" || isActiveStatus(status));
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
  const before = serverBodyItems(existing);
  const next = serverBodyItems(incoming);
  const byId = new Map(before.map((item) => [item.id, item]));
  // A current full snapshot defines membership, including deletions and emptiness.
  // Compaction strength remains governed by the existing observation rule.
  const items = incoming.itemsView === "full" ? next.map((item) => {
    const prior = byId.get(item.id);
    return prior?.kind === "compaction" && item.kind === "compaction" ? mergeConversationItem(prior, item) : item;
  }) : incoming.itemsView === "notLoaded" ? before : mergeConversationItems(before, next);
  const itemsView = incoming.itemsView === "full" ? "full" : incoming.itemsView === "notLoaded" ? existing.itemsView ?? "notLoaded"
    : items.length > 0 && items.every((item) => item.bodyCompleteness === "full") ? "full" : incoming.itemsView;
  const { itemsView: _oldView, terminalIssue: _oldIssue, ...base } = existing;
  const terminalIssue = incoming.terminalIssue ?? (existing.terminalIssue === "compatibility" && knownTerminalStatus(incoming.status) === undefined ? existing.terminalIssue : undefined);
  return withTerminalUncertainty({
    ...base, ...incoming,
    ...(terminalIssue === undefined ? {} : { terminalIssue }),
    ...(itemsView === undefined ? {} : { itemsView }),
    ...(existing.createdAt === undefined && incoming.createdAt !== undefined ? { createdAt: incoming.createdAt } : {}),
    items,
  });
}

function serverBodyItems(turn: ConversationTurnView): readonly ConversationItemView[] {
  return turn.terminalIssue === "compatibility" ? turn.items.filter((item) => item.id !== `${turn.id}:terminal`) : turn.items;
}

function withTerminalUncertainty(turn: ConversationTurnView): ConversationTurnView {
  const phase = turn.terminalIssue === undefined && knownTerminalStatus(turn.status) === "completed" ? "final" : "streaming";
  const items = serverBodyItems(turn).map((item): ConversationItemView => item.kind === "text" && item.role !== "user" ? { ...item, phase } : item);
  return { ...turn, items: turn.terminalIssue === "compatibility" ? [...items, { kind: "status", id: `${turn.id}:terminal`, text: UNCONFIRMED_TURN_STATUS_MESSAGE }] : items };
}

function mergeConversationItems(existing: readonly ConversationItemView[], incoming: readonly ConversationItemView[]): ConversationItemView[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  const order = [...byId.keys()];
  for (const [index, item] of incoming.entries()) {
    const prior = byId.get(item.id);
    if (prior === undefined) {
      const anchor = incoming.slice(index + 1).find((candidate) => byId.has(candidate.id));
      const before = anchor === undefined ? -1 : order.indexOf(anchor.id);
      if (before < 0) order.push(item.id);
      else order.splice(before, 0, item.id);
    }
    byId.set(item.id, prior === undefined ? item : mergeConversationItem(prior, item));
  }
  return order.map((id) => byId.get(id)).filter((item): item is ConversationItemView => item !== undefined);
}

function mergeConversationItem(existing: ConversationItemView, incoming: ConversationItemView): ConversationItemView {
  if (existing.kind === "compaction" && incoming.kind === "compaction") return existing.status === "completed" || incoming.status === "unknown" ? existing : incoming;
  if (existing.kind === "text" && incoming.kind === "text") {
    return existing.bodyCompleteness === "full" && incoming.bodyCompleteness !== "full" ? { ...existing, phase: incoming.phase } : incoming;
  }
  if (existing.kind === "tool" && incoming.kind === "tool") return existing.bodyCompleteness === "full" && incoming.bodyCompleteness !== "full" ? { ...existing, status: incoming.status } : incoming;
  if (existing.kind === "status" && incoming.kind === "status") return existing.bodyCompleteness === "full" && incoming.bodyCompleteness !== "full" ? existing : incoming;
  return incoming.kind === "status" && existing.kind !== "status" ? existing : incoming;
}

export function toConversationUpdate(method: string, params: JsonObject, knownThreadId?: string): ConversationUpdate | undefined {
  const turn = isJsonObject(params.turn) ? params.turn : undefined;
  const item = isJsonObject(params.item) ? params.item : undefined;
  const threadId = readString(params, "threadId") ?? (turn === undefined ? undefined : readString(turn, "threadId")) ?? knownThreadId;
  const turnId = readString(params, "turnId") ?? (turn === undefined ? undefined : readString(turn, "id"));
  if (threadId === undefined || turnId === undefined) return undefined;

  if (method === "turn/started") return { type: method, threadId, turnId };
  if (method === "turn/completed" || method === "turn/failed" || method === "turn/interrupted") {
    const terminal = terminalTurnEvent(method, params);
    if (terminal === undefined) return undefined;
    const message = terminal.error?.message;
    const type = terminal.outcome === "failed" ? "turn/failed" : terminal.outcome === "interrupted" ? "turn/interrupted" : "turn/completed";
    return { type, threadId, turnId, ...(message === undefined ? {} : { message }), ...(terminal.error instanceof CompatibilityError ? { terminalIssue: "compatibility" as const } : {}) };
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
  const terminal = knownTerminalStatus(turn.status);
  return withTerminalUncertainty({
    id: turn.id,
    index: index + 1,
    status: turn.status?.trim() || "unknown",
    ...(turn.createdAt === undefined ? {} : { createdAt: turn.createdAt }),
    ...(turn.itemsView === undefined ? {} : { itemsView: turn.itemsView }),
    ...(!active && terminal === undefined ? { terminalIssue: "compatibility" as const } : {}),
    items: turn.itemsView === "notLoaded" ? [] : (turn.items ?? []).map((item, itemIndex): ConversationItemView => ({
      ...toConversationItemView(item, turn.id, itemIndex, terminal !== "completed"),
      ...(turn.itemsView === "full" || turn.itemsView === "summary" ? { bodyCompleteness: turn.itemsView } : {}),
    })),
  });
}

function toConversationItemView(item: TurnItem, turnId: string, itemIndex: number, active = false): ConversationItemView {
  const id = item.id?.trim() || `${turnId}:item-${itemIndex + 1}`;
  if (item.type === "contextCompaction") return { kind: "compaction", id, status: "unknown" };
  const type = item.type?.trim().toLowerCase() ?? "";
  const text = displayText(item.text ?? item.content);
  const role = textRole(item, type);
  if (role !== undefined) {
    const phase = role === "user" ? "historical" : active ? "streaming" : "final";
    return { kind: "text", id, role, text: item.text !== undefined || item.content !== undefined ? text : "(No text provided)", phase };
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
