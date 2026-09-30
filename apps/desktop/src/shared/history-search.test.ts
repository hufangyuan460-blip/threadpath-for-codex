import assert from "node:assert/strict";
import type { WorkspaceState } from "./api.ts";
import { searchHistory } from "./history-search.ts";

const state: WorkspaceState = {
  directories: [{
    path: "C:\\work\\ThreadPath",
    name: "ThreadPath workspace",
    expanded: true,
    hidden: true,
    threads: [
      { id: "visible", serverTitle: "Codex release planning", title: "Release planning", preview: "Plan the beta release", status: "idle", turnCount: 1, updatedAt: "2026-09-01T00:00:00Z" },
      { id: "hidden", title: "设计讨论", preview: "首条用户提问", status: "idle", turnCount: 1, hidden: true, archived: true, updatedAt: "2026-09-02T00:00:00Z" },
    ],
  }],
  unclassifiedThreads: [{ id: "loose", title: "Standalone", preview: "Need a workspace", status: "idle", turnCount: 1 }],
  configuredWorkspaces: [],
  sync: { state: "complete", threadCount: 3, missingThreadIds: [] },
};

function main(): void {
  const titleResults = searchHistory(state, "release");
  assert.equal(titleResults.length, 1);
  assert.deepEqual(titleResults[0], { kind: "thread", id: "visible", title: "Release planning", detail: "Plan the beta release", workspacePath: "C:\\work\\ThreadPath", hidden: true, archived: false, matchKind: "conversation-title", updatedAt: "2026-09-01T00:00:00Z" });

  const previewResults = searchHistory(state, "首条用户");
  assert.equal(previewResults[0]?.id, "hidden");
  assert.equal(previewResults[0]?.matchKind, "conversation-preview");
  assert.equal(previewResults[0]?.hidden, true);
  assert.equal(previewResults[0]?.archived, true);

  assert.equal(searchHistory(state, "codex release")[0]?.id, "visible");

  const workspaceResults = searchHistory(state, "threadpath");
  assert.equal(workspaceResults.some((result) => result.kind === "workspace" && result.id === "C:\\work\\ThreadPath"), true);
  assert.equal(workspaceResults.some((result) => result.id === "visible"), true);
  assert.equal(searchHistory(state, "workspace").some((result) => result.id === "loose"), true);
  assert.deepEqual(searchHistory(state, "   "), []);
  console.log("[desktop-test] history search checks passed");
}

try { main(); } catch (error: unknown) { console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
