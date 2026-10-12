import assert from "node:assert/strict";
import type { WorkspaceState } from "./api.ts";
import { filterWorkspaceHistory, replaceThreadTitle } from "./workspace-state.ts";

function main(): void {
  const state: WorkspaceState = {
    directories: [{ path: "C:\\project", name: "project", expanded: true, threads: [{ id: "a", title: "Old A", status: "active", turnCount: 1 }] }],
    unclassifiedThreads: [{ id: "b", title: "Old B", status: "active", turnCount: 2 }],
    configuredWorkspaces: [],
    sync: { state: "complete", threadCount: 2, missingThreadIds: [] },
  };
  const renamed = replaceThreadTitle(state, "a", "New A");
  assert.equal(renamed.directories[0]?.threads[0]?.title, "New A");
  assert.equal(renamed.unclassifiedThreads[0]?.title, "Old B");
  assert.equal(state.directories[0]?.threads[0]?.title, "Old A");
  const unclassified = replaceThreadTitle(state, "b", "New B");
  assert.equal(unclassified.unclassifiedThreads[0]?.title, "New B");
  assert.equal(unclassified.directories[0]?.threads[0]?.title, "Old A");
  const historyState: WorkspaceState = {
    directories: [
      { path: "C:\\favorite", name: "favorite", expanded: true, favorite: true, threads: [{ id: "plain", title: "Plain", status: "idle", turnCount: null }, { id: "saved", title: "Saved", status: "idle", turnCount: null, favorite: true }] },
      { path: "C:\\hidden", name: "hidden", expanded: true, hidden: true, threads: [{ id: "inherited", title: "Inherited", status: "idle", turnCount: null }, { id: "explicit", title: "Explicit", status: "idle", turnCount: null, hidden: true }] },
      { path: "C:\\mixed", name: "mixed", expanded: true, threads: [{ id: "visible", title: "Visible", status: "idle", turnCount: null }, { id: "private", title: "Private", status: "idle", turnCount: null, hidden: true }] },
    ],
    unclassifiedThreads: [{ id: "loose", title: "Loose", status: "idle", turnCount: null, hidden: true }],
    configuredWorkspaces: [],
    sync: { state: "idle", threadCount: 0, missingThreadIds: [] },
  };
  const favorites = filterWorkspaceHistory(historyState, "favorites");
  assert.deepEqual(favorites.directories[0]?.threads.map((thread) => thread.id), ["plain", "saved"]);
  const hidden = filterWorkspaceHistory(historyState, "hidden");
  assert.deepEqual(hidden.directories.map((directory) => directory.name), ["hidden", "mixed"]);
  assert.deepEqual(hidden.directories[0]?.threads.map((thread) => thread.id), ["inherited", "explicit"]);
  assert.deepEqual(hidden.directories[1]?.threads.map((thread) => thread.id), ["private"]);
  assert.deepEqual(hidden.unclassifiedThreads.map((thread) => thread.id), ["loose"]);
  const archivedState: WorkspaceState = { ...historyState, directories: historyState.directories.map((directory) => ({ ...directory, threads: [...directory.threads, { id: `archived-${directory.name}`, title: "Archived", status: "idle", turnCount: null, archived: true, favorite: true }] })), unclassifiedThreads: [{ id: "archived-loose", title: "Loose archive", status: "idle", turnCount: null, archived: true }] };
  for (const filter of ["all", "favorites", "updated", "unclassified"] as const) {
    const view = filterWorkspaceHistory(archivedState, filter);
    assert.ok([...view.directories.flatMap((directory) => directory.threads), ...view.unclassifiedThreads].every((thread) => !thread.archived), `${filter} must not include archived conversations`);
  }
  const archives = filterWorkspaceHistory(archivedState, "archived");
  assert.equal(archives.directories.length, 3, "hidden workspaces must not make archived conversations irrecoverable");
  assert.ok(archives.directories.flatMap((directory) => directory.threads).every((thread) => thread.archived));
  assert.equal(archives.unclassifiedThreads[0]?.id, "archived-loose");
  console.log("[desktop-test] workspace state title checks passed");
}

try { main(); } catch (error: unknown) { console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
