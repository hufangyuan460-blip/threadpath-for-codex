import { AppServerError, type ThreadListOptions, type ThreadSummary } from "../../../../threadpath-protocol/src/protocol.ts";
import type { HistorySyncSnapshot } from "../shared/api";

export interface HistoryListClient {
  listThreads(options?: ThreadListOptions): Promise<ThreadSummary[]>;
  /** Set by adapters only after their thread/list pagination behavior is known. */
  readonly threadListFacts?: { readonly archivedFilter: boolean; readonly pagination: boolean };
}

export interface HistoryListClientProvider {
  getReadyClient(): HistoryListClient;
}

export interface HistoryMirrorStore {
  getHistoryMirror(): ThreadSummary[];
  setHistoryMirror(threads: readonly ThreadSummary[]): Promise<void>;
  getRetainedThreadIds?(): readonly string[];
}

export interface HistorySyncResult {
  readonly threads: readonly ThreadSummary[];
  readonly snapshot: HistorySyncSnapshot;
}

export class CodexHistorySyncService {
  private readonly provider: HistoryListClientProvider;
  private readonly mirror = new Map<string, ThreadSummary>();
  private readonly visible = new Map<string, ThreadSummary>();
  private snapshot: HistorySyncSnapshot = { state: "idle", threadCount: 0, missingThreadIds: [] };
  private running: Promise<HistorySyncResult> | undefined;
  private readonly pendingArchiveStates = new Map<string, boolean>();

  constructor(provider: HistoryListClientProvider, mirrorStore?: HistoryMirrorStore) {
    this.provider = provider;
    for (const thread of mirrorStore?.getHistoryMirror() ?? []) {
      this.mirror.set(thread.id, thread);
      this.visible.set(thread.id, thread);
    }
    this.snapshot = { state: "idle", threadCount: this.visible.size, missingThreadIds: [] };
    this.mirrorStore = mirrorStore;
  }

  private readonly mirrorStore: HistoryMirrorStore | undefined;

  getSnapshot(): HistorySyncSnapshot { return this.snapshot; }
  getMirrorThreads(): ThreadSummary[] { return [...this.mirror.values()]; }
  getCurrentResult(): HistorySyncResult { return { threads: [...this.visible.values()], snapshot: this.snapshot }; }

  async rememberThread(thread: ThreadSummary): Promise<void> {
    this.mirror.set(thread.id, thread);
    this.visible.set(thread.id, thread);
    await this.mirrorStore?.setHistoryMirror([...this.mirror.values()]);
  }

  /** Called only after Codex accepted archive/unarchive; bridge delayed list indexing. */
  async confirmArchived(threadId: string, archived: boolean): Promise<void> {
    const thread = this.visible.get(threadId) ?? this.mirror.get(threadId);
    if (thread === undefined) throw new Error("Archived thread is not present in history");
    this.pendingArchiveStates.set(threadId, archived);
    await this.rememberThread({ ...thread, archived });
  }

  sync(): Promise<HistorySyncResult> {
    if (this.running !== undefined) return this.running;
    this.snapshot = { state: "syncing", threadCount: this.mirror.size, missingThreadIds: [] };
    const running = this.syncInternal();
    const tracked = running.finally(() => {
      if (this.running === tracked) this.running = undefined;
    });
    this.running = tracked;
    return tracked;
  }

  private async syncInternal(): Promise<HistorySyncResult> {
    const client = this.provider.getReadyClient();
    const facts = client.threadListFacts;
    const current = new Map<string, ThreadSummary>();
    let partial = facts?.archivedFilter !== true || facts.pagination !== true;
    let errorMessage: string | undefined;
    try {
      for (const archived of [false, true]) {
        try {
          const threads = await client.listThreads({ archived, limit: 100 });
          for (const thread of threads) current.set(thread.id, facts?.archivedFilter === true ? { ...thread, archived } : thread);
        } catch (error: unknown) {
          if (!archived) throw error;
          partial = true;
          errorMessage = error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.snapshot = { state: "failed", threadCount: this.mirror.size, missingThreadIds: [], error: message };
      throw error;
    }

    for (const [id, archived] of this.pendingArchiveStates) {
      const fetched = current.get(id);
      if (fetched?.archived === archived) this.pendingArchiveStates.delete(id);
      else {
        const thread = fetched ?? this.mirror.get(id);
        if (thread !== undefined) current.set(id, { ...thread, archived });
      }
    }
    const missing = [...this.mirror.keys()].filter((id) => !current.has(id));
    for (const thread of current.values()) this.mirror.set(thread.id, thread);
    const retained = new Set(this.mirrorStore?.getRetainedThreadIds?.() ?? []);
    if (partial || retained.size > 0) {
      for (const id of missing) {
        const old = this.mirror.get(id);
        if (old !== undefined && (partial || retained.has(id))) current.set(id, old);
      }
    }
    const syncedAt = new Date().toISOString();
    const state = partial ? "partial" : "complete";
    const snapshot: HistorySyncSnapshot = {
      state,
      threadCount: current.size,
      missingThreadIds: missing,
      syncedAt,
      ...(errorMessage === undefined ? {} : { error: errorMessage }),
    };
    this.snapshot = snapshot;
    this.visible.clear();
    for (const thread of current.values()) this.visible.set(thread.id, thread);
    await this.mirrorStore?.setHistoryMirror([...this.mirror.values()]);
    return { threads: [...current.values()], snapshot };
  }
}

export function isHistorySyncFailure(error: unknown): error is AppServerError {
  return error instanceof AppServerError;
}
