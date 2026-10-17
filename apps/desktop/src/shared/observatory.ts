import type { ThreadTokenUsage } from "../../../../threadpath-protocol/src/token-usage.ts";

export interface ThreadUsageSnapshot extends ThreadTokenUsage {
  readonly threadId: string;
  readonly reportedTurnId: string;
  readonly receivedAt: string;
  readonly source: "live" | "resumed";
  readonly stale: boolean;
}

export interface CompactionObservation {
  readonly turnId: string;
  readonly itemId: string;
  readonly status: "started" | "completed" | "unknown";
  readonly source: "history" | "live";
}

export interface ThreadObservatoryState {
  readonly threadId: string;
  /** Monotonic in this process; prevents an IPC read from overwriting a newer event. */
  readonly revision: number;
  readonly usage: ThreadUsageSnapshot | null;
  readonly usageError?: "invalid-payload";
  readonly compactions: readonly CompactionObservation[];
}
