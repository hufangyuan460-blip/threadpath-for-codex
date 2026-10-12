import type { ConversationThreadView } from "../shared/api.ts";

export interface BranchPointTarget { readonly threadId: string; readonly turnId: string; }
export interface BranchPointResult { readonly thread: ConversationThreadView; readonly outcome: "found" | "missing" | "cancelled"; }

/** Locate by stable identity; display labels and page-relative indices are never navigation keys. */
export async function locateBranchPoint(initial: ConversationThreadView, turnId: string, loadEarlier: () => Promise<ConversationThreadView>, isCurrent: () => boolean): Promise<BranchPointResult> {
  let thread = initial;
  const cursors = new Set<string>();
  while (isCurrent()) {
    if (thread.turns.some((turn) => turn.id === turnId)) return { thread, outcome: "found" };
    const cursor = thread.paging.nextCursor;
    if (cursor !== undefined && cursors.has(cursor)) throw new Error("History pagination repeated a cursor");
    if (!thread.paging.hasMore || cursor === undefined) return { thread, outcome: "missing" };
    cursors.add(cursor);
    const next = await loadEarlier();
    if (next.id !== initial.id) throw new Error("Branch point response belongs to another conversation");
    if (next.paging.nextCursor === cursor && !next.turns.some((turn) => turn.id === turnId)) throw new Error("History pagination did not advance");
    thread = next;
  }
  return { thread, outcome: "cancelled" };
}

export function inheritedTurnIds(thread: ConversationThreadView, cutoffId: string): ReadonlySet<string> | undefined {
  const cutoff = thread.turns.findIndex((turn) => turn.id === cutoffId);
  return cutoff < 0 ? undefined : new Set(thread.turns.slice(0, cutoff + 1).map((turn) => turn.id));
}
