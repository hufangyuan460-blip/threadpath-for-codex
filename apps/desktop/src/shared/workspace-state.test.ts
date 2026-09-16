import assert from "node:assert/strict";
import type { WorkspaceState } from "./api.ts";
import { replaceThreadTitle } from "./workspace-state.ts";

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
  console.log("[desktop-test] workspace state title checks passed");
}

try { main(); } catch (error: unknown) { console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
