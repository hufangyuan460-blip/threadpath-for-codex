import type { ThreadListItem, WorkspaceState } from "./api";

export type HistoryViewFilter = "all" | "favorites" | "hidden" | "archived" | "unclassified" | "updated";

export interface HistoryWorkspaceView {
  readonly directories: WorkspaceState["directories"];
  readonly unclassifiedThreads: readonly ThreadListItem[];
}

/** Derives one tree; a hidden workspace hides every child by inheritance. */
export function filterWorkspaceHistory(state: WorkspaceState, filter: HistoryViewFilter): HistoryWorkspaceView {
  const visibleThread = (thread: ThreadListItem, workspaceHidden: boolean): boolean => {
    const hidden = workspaceHidden || thread.hidden === true;
    if (filter === "hidden") return hidden;
    if (hidden) return false;
    if (filter === "favorites") return thread.favorite === true;
    if (filter === "archived") return thread.archived === true;
    return true;
  };
  const directories = state.directories.flatMap((directory) => {
    const threads = directory.threads.filter((thread) => visibleThread(thread, directory.hidden === true));
    const visible = filter === "all" ? directory.hidden !== true
      : filter === "unclassified" ? false
        : filter === "favorites" ? directory.hidden !== true && (directory.favorite === true || threads.length > 0)
          : filter === "hidden" ? directory.hidden === true || threads.length > 0
            : threads.length > 0;
    if (!visible) return [];
    const displayThreads = filter === "favorites" && directory.favorite === true && directory.hidden !== true
      ? directory.threads.filter((thread) => thread.hidden !== true)
      : threads;
    return [{ ...directory, threads: displayThreads }];
  });
  const unclassifiedThreads = state.unclassifiedThreads.filter((thread) => visibleThread(thread, false) && (filter !== "unclassified" || thread.hidden !== true));
  return { directories, unclassifiedThreads };
}

export function replaceThreadTitle(state: WorkspaceState, threadId: string, title: string): WorkspaceState {
  return {
    ...state,
    directories: state.directories.map((directory) => ({
      ...directory,
      threads: replaceThreadInList(directory.threads, threadId, title),
    })),
    unclassifiedThreads: replaceThreadInList(state.unclassifiedThreads, threadId, title),
  };
}

function replaceThreadInList(threads: readonly ThreadListItem[], threadId: string, title: string): readonly ThreadListItem[] {
  return threads.map((thread) => thread.id === threadId ? { ...thread, title } : thread);
}
