import type { ThreadListItem, WorkspaceState } from "./api";

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
