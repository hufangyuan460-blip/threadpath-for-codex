import assert from "node:assert/strict";
import { ConfigurationError, ProtocolError, type Thread, type ThreadSummary } from "../../../../threadpath-protocol/src/protocol.ts";
import { ThreadService, type ThreadClient, type ThreadClientProvider } from "./thread-service.ts";

const threadSummary: ThreadSummary = { id: "thread-1", title: "  Fixture thread  ", status: "active", turnCount: 3, createdAt: "2026-01-01T00:00:00Z" };
const thread: Thread = { ...threadSummary, turns: [{ id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" }] };

async function main(): Promise<void> {
  let readId: string | undefined;
  const client: ThreadClient = {
    listThreads: async () => [threadSummary],
    readThread: async (threadId) => {
      readId = threadId;
      return thread;
    },
  };
  const provider: ThreadClientProvider = { getReadyClient: () => client };
  const service = new ThreadService(provider);

  assert.deepEqual(await service.listThreads(), [{ id: "thread-1", title: "Fixture thread", status: "active", turnCount: 3, createdAt: "2026-01-01T00:00:00Z" }]);
  assert.deepEqual(await service.readThread("thread-1"), { id: "thread-1", title: "Fixture thread", status: "active", turnCount: 3, createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(readId, "thread-1");

  const failingClient: ThreadClient = {
    listThreads: async () => { throw new ProtocolError("fixture list failure"); },
    readThread: async () => { throw new ProtocolError("fixture read failure"); },
  };
  const failingService = new ThreadService({ getReadyClient: () => failingClient });
  await assert.rejects(failingService.listThreads(), ProtocolError);
  await assert.rejects(failingService.readThread("thread-1"), ProtocolError);

  for (const invalidId of ["", " thread-1", "thread-1 ", "thread\u0000-1", 42, null]) {
    await assert.rejects(service.readThread(invalidId), ConfigurationError);
  }
  await assert.rejects(service.readThread("x".repeat(257)), ConfigurationError);
  console.log("[desktop-test] thread service checks passed");
}

main().catch((error: unknown) => {
  console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
