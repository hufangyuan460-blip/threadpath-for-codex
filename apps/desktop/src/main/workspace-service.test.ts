import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadListItem } from "../shared/api.ts";
import { UserPreferencesService } from "./user-preferences.ts";
import { WorkspaceService, workspaceDisplayName } from "./workspace-service.ts";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "threadpath-workspaces-"));
  const first = join(root, "threadPath");
  const second = join(root, "another-project");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(first);
  await mkdir(second);
  const preferences = new UserPreferencesService(join(root, "preferences.json"), "en-US");
  await preferences.load();
  const service = new WorkspaceService({ preferences });
  await service.addDirectory(first);
  await service.addDirectory(second);
  await service.associateThread("thread-a", first);
  const threads: ThreadListItem[] = [
    { id: "thread-a", title: "A", status: "active", turnCount: 1 },
    { id: "thread-b", title: "B", status: "active", turnCount: 2 },
  ];
  const state = await service.getState(threads);
  assert.equal(state.currentPath, second);
  assert.deepEqual(state.directories.map((directory) => directory.name), ["threadPath", "another-project"]);
  assert.deepEqual(state.directories[0]?.threads.map((thread) => thread.id), ["thread-a"]);
  assert.deepEqual(state.unclassifiedThreads.map((thread) => thread.id), ["thread-b"]);
  await service.associateThread("thread-a", null);
  assert.deepEqual((await service.getState(threads)).unclassifiedThreads.map((thread) => thread.id), ["thread-a", "thread-b"]);
  await service.associateThread("thread-a", first);
  await service.toggle(first);
  assert.equal((await service.getState(threads)).directories[0]?.expanded, false);
  assert.equal(workspaceDisplayName(`${first}\\`), "threadPath");
  console.log("[desktop-test] workspace service checks passed");
}

main().catch((error: unknown) => { console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
