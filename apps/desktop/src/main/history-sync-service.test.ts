import assert from "node:assert/strict";
import { AppServerError, type ThreadSummary } from "../../../../threadpath-protocol/src/protocol.ts";
import { CodexHistorySyncService, type HistoryListClient } from "./history-sync-service.ts";

async function main(): Promise<void> {
  const first: ThreadSummary = { id: "thread-1", title: "Fresh", updatedAt: "2026-09-16T00:00:00Z" };
  const old: ThreadSummary = { id: "thread-old", title: "Old" };
  let calls = 0;
  const client: HistoryListClient = {
    threadListFacts: { archivedFilter: true, pagination: true },
    listThreads: async (options) => { calls += 1; return options?.archived === true ? [old, first] : [first]; },
  };
  const service = new CodexHistorySyncService({ getReadyClient: () => client });
  const result = await service.sync();
  assert.equal(calls, 2);
  assert.equal(result.snapshot.state, "complete");
  assert.deepEqual(result.threads.map((thread) => thread.id), ["thread-1", "thread-old"]);
  assert.deepEqual(service.getCurrentResult().threads.map((thread) => thread.id), result.threads.map((thread) => thread.id));
  assert.equal(calls, 2, "reading the current snapshot must not trigger another scan");

  const failing = new CodexHistorySyncService({ getReadyClient: () => ({ listThreads: async () => { throw new AppServerError("offline", "process"); } }) });
  await assert.rejects(failing.sync(), AppServerError);
  assert.equal(failing.getSnapshot().state, "failed");

  let second = false;
  const partialClient: HistoryListClient = {
    listThreads: async (options) => { if (options?.archived === true) throw new Error("archive unsupported"); return second ? [first] : [first, old]; },
  };
  const partial = new CodexHistorySyncService({ getReadyClient: () => partialClient });
  assert.equal((await partial.sync()).snapshot.state, "partial");
  second = true;
  const retained = await partial.sync();
  assert.equal(retained.snapshot.state, "partial");
  assert.ok(retained.snapshot.missingThreadIds.includes("thread-old"));

  let resolveSync: (() => void) | undefined;
  const syncGate = new Promise<void>((resolve) => { resolveSync = resolve; });
  let concurrentCalls = 0;
  const concurrentClient: HistoryListClient = {
    threadListFacts: { archivedFilter: true, pagination: true },
    listThreads: async () => {
      concurrentCalls += 1;
      await syncGate;
      return [first];
    },
  };
  const concurrentService = new CodexHistorySyncService({ getReadyClient: () => concurrentClient });
  const firstSync = concurrentService.sync();
  const secondSync = concurrentService.sync();
  assert.equal(firstSync, secondSync);
  resolveSync?.();
  await firstSync;
  assert.equal(concurrentCalls, 2, "concurrent sync calls must share one two-scan operation");
  const branch: ThreadSummary = { id: "local-branch", forkedFromId: first.id };
  const completeWithoutBranches = new CodexHistorySyncService({ getReadyClient: () => concurrentClient }, {
    getHistoryMirror: () => [first, old],
    getRetainedThreadIds: () => [first.id, branch.id],
    setHistoryMirror: async () => undefined,
  });
  const scanning = completeWithoutBranches.sync();
  await completeWithoutBranches.rememberThread(branch);
  const withBranch = await scanning;
  assert.ok(withBranch.threads.some((thread) => thread.id === branch.id), "a local fork created during scanning must remain navigable");
  assert.ok(!withBranch.threads.some((thread) => thread.id === old.id), "unrelated missing threads still follow complete-sync rules");
  const created: ThreadSummary = { id: "created-not-indexed", title: "Created locally" };
  let saved: readonly ThreadSummary[] = [];
  const newConversation = new CodexHistorySyncService({ getReadyClient: () => client }, {
    getHistoryMirror: () => [], getRetainedThreadIds: () => [created.id], setHistoryMirror: async (threads) => { saved = threads; },
  });
  await newConversation.rememberThread(created);
  const indexedLater = await newConversation.sync();
  assert.ok(indexedLater.threads.some((thread) => thread.id === created.id));
  assert.ok(indexedLater.snapshot.missingThreadIds.includes(created.id));
  assert.ok(saved.some((thread) => thread.id === created.id));
  const restartedCreated = new CodexHistorySyncService({ getReadyClient: () => client }, { getHistoryMirror: () => [...saved], getRetainedThreadIds: () => [created.id], setHistoryMirror: async () => undefined });
  assert.ok((await restartedCreated.sync()).threads.some((thread) => thread.id === created.id));
  let archivedIndex = false;
  const archiveClient: HistoryListClient = {
    threadListFacts: { archivedFilter: true, pagination: true },
    listThreads: async (options) => options?.archived === archivedIndex ? [{ id: "archive-target", title: "No archived field" }] : [],
  };
  let archiveSaved: readonly ThreadSummary[] = [];
  const archiveSync = new CodexHistorySyncService({ getReadyClient: () => archiveClient }, {
    getHistoryMirror: () => [], setHistoryMirror: async (threads) => { archiveSaved = threads; },
  });
  assert.equal((await archiveSync.sync()).threads[0]?.archived, false);
  await archiveSync.confirmArchived("archive-target", true);
  assert.equal(archiveSaved[0]?.archived, true);
  assert.equal((await archiveSync.sync()).threads[0]?.archived, true, "a delayed ordinary list must not undo accepted archival");
  archivedIndex = true;
  assert.equal((await archiveSync.sync()).threads[0]?.archived, true, "archived filter supplies missing metadata");
  archivedIndex = false;
  assert.equal((await archiveSync.sync()).threads[0]?.archived, false, "external changes are authoritative after index confirmation");
  await archiveSync.confirmArchived("archive-target", true);
  archivedIndex = true;
  await archiveSync.sync();
  await archiveSync.confirmArchived("archive-target", false);
  assert.equal((await archiveSync.sync()).threads[0]?.archived, false, "delayed archived list must not undo restoration");
  let releaseScan: (() => void) | undefined;
  const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
  const racingArchive = new CodexHistorySyncService({ getReadyClient: () => ({
    threadListFacts: { archivedFilter: true, pagination: true },
    listThreads: async (options) => { await scanGate; return options?.archived ? [] : [{ id: "racing", title: "Old list" }]; },
  }) });
  await racingArchive.rememberThread({ id: "racing" });
  const oldScan = racingArchive.sync();
  await racingArchive.confirmArchived("racing", true);
  releaseScan?.();
  assert.equal((await oldScan).threads[0]?.archived, true, "an in-flight scan must not overwrite an accepted operation");
  const unsavedArchive = new CodexHistorySyncService({ getReadyClient: () => archiveClient }, {
    getHistoryMirror: () => [{ id: "unsaved" }], setHistoryMirror: async () => { throw new Error("synthetic write failure"); },
  });
  await assert.rejects(unsavedArchive.confirmArchived("unsaved", true));
  assert.equal(unsavedArchive.getCurrentResult().threads[0]?.archived, true, "failed mirror persistence cannot undo successful remote archival");
  console.log("[desktop-test] history sync checks passed");
}

main().catch((error: unknown) => { console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
