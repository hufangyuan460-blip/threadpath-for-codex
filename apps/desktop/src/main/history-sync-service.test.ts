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
  console.log("[desktop-test] history sync checks passed");
}

main().catch((error: unknown) => { console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
