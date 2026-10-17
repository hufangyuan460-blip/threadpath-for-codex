import { isJsonObject, readString, type JsonObject, type Turn } from "../../../../threadpath-protocol/src/protocol.ts";
import { parseThreadTokenUsageUpdatedNotification, type ThreadTokenUsageUpdatedNotification } from "../../../../threadpath-protocol/src/token-usage.ts";
import type { CompactionObservation, ThreadObservatoryState } from "../shared/observatory.ts";

/** Auxiliary memory only. No RPCs, persistence, totals arithmetic or billing ledger. */
export class ObservatoryService {
  private readonly states = new Map<string, ThreadObservatoryState>();
  private readonly listeners = new Set<(state: ThreadObservatoryState) => void>();
  private readonly pendingResumes = new Map<string, { confirmed: boolean; snapshot?: { event: ThreadTokenUsageUpdatedNotification; receivedAt: string } }>();
  private revision = 0;

  get(threadId: string): ThreadObservatoryState {
    return this.states.get(threadId) ?? { threadId, revision: 0, usage: null, compactions: [] };
  }

  subscribe(listener: (state: ThreadObservatoryState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginResume(threadId: string): void {
    this.pendingResumes.set(threadId, { confirmed: false });
  }

  completeResume(threadId: string): void {
    const pending = this.pendingResumes.get(threadId);
    if (pending === undefined) return;
    pending.confirmed = true;
    if (pending.snapshot !== undefined) {
      this.pendingResumes.delete(threadId);
      this.publishUsage(pending.snapshot.event, "resumed", pending.snapshot.receivedAt);
    }
  }

  cancelResume(threadId: string): void {
    const pending = this.pendingResumes.get(threadId);
    this.pendingResumes.delete(threadId);
    // A rejected attempt cannot establish replay provenance. Still accept valid
    // server data received during it; identical snapshots remain unchanged.
    if (pending?.snapshot !== undefined) this.publishUsage(pending.snapshot.event, "live", pending.snapshot.receivedAt);
  }

  observeLiveTurn(threadId: string, _turnId: string): void {
    // Once a new turn starts, delayed reports cannot reliably be called replay.
    this.cancelResume(threadId);
  }

  disconnected(): void {
    for (const threadId of [...this.pendingResumes.keys()]) this.cancelResume(threadId);
    this.pendingResumes.clear();
    for (const state of this.states.values()) {
      const compactions = state.compactions.map((item): CompactionObservation => item.status === "started" ? { ...item, status: "unknown" } : item);
      if (state.usage !== null || compactions.some((item, index) => item !== state.compactions[index])) {
        this.publish({ ...state, usage: state.usage === null ? null : { ...state.usage, stale: true }, compactions });
      }
    }
  }

  observeHistory(threadId: string, turns: readonly Turn[]): void {
    for (const turn of turns) for (const item of turn.items ?? []) {
      if (item.type === "contextCompaction" && item.id !== undefined && item.id.trim() !== "") {
        this.compaction(threadId, { turnId: turn.id, itemId: item.id, status: "unknown", source: "history" });
      }
    }
  }

  observeNotification(method: string, params: JsonObject, knownThreadId?: string): void {
    if (method === "thread/tokenUsage/updated") {
      let event: ThreadTokenUsageUpdatedNotification;
      try {
        event = parseThreadTokenUsageUpdatedNotification(params);
      } catch {
        // Only parsing failures mean invalid payload; delivery runs separately.
        const threadId = readString(params, "threadId");
        if (threadId !== undefined && threadId.trim() !== "") {
          const pending = this.pendingResumes.get(threadId);
          if (pending !== undefined) delete pending.snapshot;
          this.publish({ ...this.get(threadId), usage: null, usageError: "invalid-payload" });
        }
        return;
      }
      const pending = this.pendingResumes.get(event.threadId);
      if (pending !== undefined && !pending.confirmed) {
        // app-server can send replay before the resume response. Keep only the
        // latest absolute snapshot until success/failure determines its source.
        pending.snapshot = { event, receivedAt: new Date().toISOString() };
        return;
      }
      this.pendingResumes.delete(event.threadId);
      this.publishUsage(event, pending === undefined ? "live" : "resumed");
      return;
    }
    const threadId = readString(params, "threadId") ?? knownThreadId;
    const turn = isJsonObject(params.turn) ? params.turn : undefined;
    const turnId = readString(params, "turnId") ?? (turn === undefined ? undefined : readString(turn, "id"));
    if (threadId === undefined || turnId === undefined) return;
    if (method === "turn/started") this.observeLiveTurn(threadId, turnId);
    if (method === "turn/completed" || method === "turn/failed" || method === "turn/interrupted") {
      const state = this.get(threadId);
      const compactions = state.compactions.map((item): CompactionObservation => item.turnId === turnId && item.status === "started" ? { ...item, status: "unknown" } : item);
      if (compactions.some((item, index) => item !== state.compactions[index])) this.publish({ ...state, compactions });
    }
    const item = isJsonObject(params.item) ? params.item : undefined;
    if ((method === "item/started" || method === "item/completed") && item?.type === "contextCompaction") {
      const itemId = readString(item, "id");
      if (itemId !== undefined && itemId.trim() !== "") this.compaction(threadId, { turnId, itemId, status: method === "item/started" ? "started" : "completed", source: "live" });
    }
  }

  private publishUsage(event: ThreadTokenUsageUpdatedNotification, source: "live" | "resumed", receivedAt = new Date().toISOString()): void {
    const state = this.get(event.threadId);
    const usage = { ...event.tokenUsage, threadId: event.threadId, reportedTurnId: event.turnId, source, stale: false } as const;
    const prior = state.usage;
    // A consumed replay marker must not relabel a duplicate as live. Only a
    // newly confirmed resume can give an identical snapshot new provenance.
    const duplicate = prior !== null && !prior.stale && state.usageError === undefined
      && JSON.stringify({ ...prior, receivedAt: undefined, source: undefined }) === JSON.stringify({ ...usage, source: undefined });
    if (duplicate && (source === "live" || prior.source === source)) return;
    this.publish({ threadId: event.threadId, revision: state.revision, compactions: state.compactions, usage: { ...usage, receivedAt } });
  }

  private compaction(threadId: string, incoming: CompactionObservation): void {
    const state = this.get(threadId);
    const prior = state.compactions.find((item) => item.itemId === incoming.itemId && item.turnId === incoming.turnId);
    // History has no lifecycle status; it must not overwrite an observed event.
    if (prior !== undefined && (incoming.source === "history" || prior.status === "completed" || prior.status === incoming.status)) return;
    this.publish({ ...state, compactions: [...state.compactions.filter((item) => item !== prior), incoming] });
  }

  private publish(state: ThreadObservatoryState): void {
    const next = { ...state, revision: ++this.revision };
    this.states.set(state.threadId, next);
    for (const listener of this.listeners) {
      try { listener(next); }
      catch {
        // Fixed diagnostic only: never log the payload or subscriber error,
        // which may contain conversation content. Even diagnostics are optional.
        try { console.warn("[observatory] listener delivery failed"); } catch { /* Keep the core call independent of diagnostics. */ }
      }
    }
  }
}
