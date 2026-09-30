import type { ThreadListItem, WorkspaceState } from "./api";

export type HistorySearchMatchKind = "conversation-title" | "conversation-preview" | "workspace-name" | "workspace-path";

export interface HistorySearchResult {
  readonly kind: "thread" | "workspace";
  /** A thread id for conversations and a normalized workspace path for workspaces. */
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly workspacePath?: string;
  readonly hidden: boolean;
  readonly archived: boolean;
  readonly matchKind: HistorySearchMatchKind;
  readonly updatedAt?: string;
}

interface Candidate {
  readonly value: string | undefined;
  readonly matchKind: HistorySearchMatchKind;
  readonly rank: number;
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function matchingCandidate(query: string, candidates: readonly Candidate[]): Candidate | undefined {
  return candidates.find((candidate) => candidate.value !== undefined && normalized(candidate.value).includes(query));
}

function compareResults(left: HistorySearchResult, right: HistorySearchResult): number {
  const rank = matchRank(left.matchKind) - matchRank(right.matchKind);
  if (rank !== 0) return rank;
  const updated = Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? "");
  if (Number.isFinite(updated) && updated !== 0) return updated;
  return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
}

function matchRank(kind: HistorySearchMatchKind): number {
  return kind === "conversation-title" || kind === "workspace-name" ? 0 : kind === "conversation-preview" ? 1 : 2;
}

function searchThread(thread: ThreadListItem, workspacePath: string | undefined, workspaceName: string, workspaceHidden: boolean, query: string): HistorySearchResult | undefined {
  const match = matchingCandidate(query, [
    { value: thread.title, matchKind: "conversation-title", rank: 0 },
    { value: thread.serverTitle, matchKind: "conversation-title", rank: 0 },
    { value: thread.preview, matchKind: "conversation-preview", rank: 1 },
    { value: workspaceName, matchKind: "workspace-name", rank: 2 },
    { value: workspacePath, matchKind: "workspace-path", rank: 3 },
  ]);
  if (match === undefined) return undefined;
  return {
    kind: "thread",
    id: thread.id,
    title: thread.title,
    detail: thread.preview?.trim() || workspaceName,
    ...(workspacePath === undefined ? {} : { workspacePath }),
    hidden: thread.hidden === true || workspaceHidden,
    archived: thread.archived === true,
    matchKind: match.matchKind,
    ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
  };
}

/**
 * Searches only the already-synchronized local history metadata. It neither reads
 * conversation turns nor contacts Codex, so a query remains private to this app.
 */
export function searchHistory(state: WorkspaceState | undefined, rawQuery: string): HistorySearchResult[] {
  const query = normalized(rawQuery.trim());
  if (state === undefined || query === "") return [];

  const results: HistorySearchResult[] = [];
  for (const directory of state.directories) {
    const workspaceMatch = matchingCandidate(query, [
      { value: directory.name, matchKind: "workspace-name", rank: 0 },
      { value: directory.path, matchKind: "workspace-path", rank: 1 },
    ]);
    if (workspaceMatch !== undefined) {
      results.push({ kind: "workspace", id: directory.path, title: directory.name, detail: directory.path, hidden: directory.hidden === true, archived: false, matchKind: workspaceMatch.matchKind });
    }
    for (const thread of directory.threads) {
      const result = searchThread(thread, directory.path, directory.name, directory.hidden === true, query);
      if (result !== undefined) results.push(result);
    }
  }
  for (const thread of state.unclassifiedThreads) {
    const result = searchThread(thread, undefined, "Unclassified history", false, query);
    if (result !== undefined) results.push(result);
  }
  return results.sort(compareResults);
}
