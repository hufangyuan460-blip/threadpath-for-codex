import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ActiveTurnError, AppServerError, getThread, isJsonObject, ProtocolError, type JsonObject, type Thread } from "../../../../threadpath-protocol/src/protocol.ts";
import { ConversationService, toConversationThreadView, type ConversationClient, type ConversationClientProvider } from "./conversation-service.ts";

const fixturePath = fileURLToPath(new URL("../../../../threadpath-protocol/fixtures/conversation-thread.jsonl", import.meta.url));

function asObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error("fixture message must be a JSON object");
  return value;
}

async function readFixtureThread(): Promise<Thread> {
  const lines = (await readFile(fixturePath, "utf8")).split(/\r?\n/).filter((line) => line.trim() !== "");
  const message = asObject(JSON.parse(lines[1] ?? "null") as unknown);
  const thread = getThread(message.result);
  if (thread === undefined) throw new Error("conversation fixture did not contain a thread");
  return thread;
}

async function main(): Promise<void> {
  const fixtureThread = await readFixtureThread();
  let notificationListener: ((event: { method: string; params: JsonObject }) => void) | undefined;
  const client: ConversationClient = {
    listThreads: async () => [],
    readThread: async () => fixtureThread,
    listTurns: async () => ({ turns: [...(fixtureThread.turns ?? [])].reverse() }),
    resumeThread: async () => ({ id: fixtureThread.id, title: fixtureThread.title, canAcceptDirectInput: true }),
    startTurn: async () => ({ id: "turn-live" }),
    onNotification: (listener) => { notificationListener = listener; return () => { notificationListener = undefined; }; },
  };
  const provider: ConversationClientProvider = { getReadyClient: () => client };
  const service = new ConversationService(provider);
  const view = await service.readThread("thread-conversation");

  assert.equal(view.title, "Fixture conversation");
  assert.equal(view.turns.length, 2);
  assert.deepEqual(view.turns[0], {
    id: "turn-1",
    index: 1,
    status: "completed",
    createdAt: "2026-01-02T03:04:05Z",
    items: [
      { kind: "text", id: "item-user", role: "user", text: "Please inspect this project." },
      { kind: "text", id: "item-assistant", role: "assistant", text: "I will inspect the project." },
      { kind: "tool", id: "item-tool", name: "shell", status: "completed", summary: "Listed project files." },
      { kind: "text", id: "item-system", role: "system", text: "Turn completed." },
      { kind: "status", id: "item-unknown", text: "Unsupported item type: futureitem" },
      { kind: "text", id: "turn-1:item-6", role: "assistant", text: "(No text provided)" },
    ],
  });
  assert.deepEqual(view.outline, [
    { turnId: "turn-1", index: 1, label: "Please inspect this project.", status: "completed" },
    { turnId: "turn-2", index: 2, label: "What did you find?", status: "active" },
  ]);
  assert.equal((await service.searchTurns("thread-conversation", "contains"))[0]?.turnId, "turn-2");
  assert.deepEqual(view.turns[1]?.items, [
    { kind: "text", id: "item-user-2", role: "user", text: "What did you find?" },
    { kind: "text", id: "item-assistant-2", role: "assistant", text: "The project contains a protocol package." },
  ]);
  assert.deepEqual(toConversationThreadView({ id: "empty", turns: [] }), { id: "empty", title: "Untitled thread", status: "unknown", turns: [], outline: [], paging: { orderedTurnIds: [], firstItemIndex: 1000000, hasMore: false, isLoadingMore: false } });

  await assert.rejects(service.readThread(" invalid-id"), (error: unknown) => error instanceof Error && error.name === "ConfigurationError");
  const updates: string[] = [];
  const startService = new ConversationService({ getReadyClient: () => client });
  const unsubscribe = startService.onConversationUpdate((update) => updates.push(update.type));
  const started = await startService.startTurn("thread-conversation", " live input ");
  assert.deepEqual(started, { threadId: "thread-conversation", turnId: "turn-live" });
  await assert.rejects(startService.startTurn("thread-conversation", "second input"), ProtocolError);
  assert.ok(notificationListener);
  notificationListener?.({ method: "turn/started", params: { threadId: "thread-conversation", turnId: "turn-live" } });
  notificationListener?.({ method: "turn/completed", params: { threadId: "thread-conversation", turnId: "turn-live", turn: { id: "turn-live" } } });
  assert.deepEqual(updates, ["turn/started", "turn/completed"]);
  unsubscribe();
  await assert.rejects(service.startTurn("thread-conversation", ""), (error: unknown) => error instanceof Error && error.name === "ConfigurationError");
  let startCalled = false;
  const unavailableClient: ConversationClient = {
    ...client,
    resumeThread: async () => { throw new Error("thread not found"); },
    startTurn: async () => { startCalled = true; return { id: "should-not-start" }; },
  };
  await assert.rejects(new ConversationService({ getReadyClient: () => unavailableClient }).startTurn("thread-conversation", "preserve this text"), /thread not found/);
  assert.equal(startCalled, false);
  let readOnlyStartCalled = false;
  const readOnlyClient: ConversationClient = {
    ...client,
    resumeThread: async () => ({ ...fixtureThread, canAcceptDirectInput: false }),
    startTurn: async () => { readOnlyStartCalled = true; return { id: "should-not-start" }; },
  };
  await assert.rejects(new ConversationService({ getReadyClient: () => readOnlyClient }).startTurn("thread-conversation", "read-only input"), /cannot accept direct input/);
  assert.equal(readOnlyStartCalled, false);
  let busyStartCalled = false;
  const busyClient: ConversationClient = {
    ...client,
    resumeThread: async () => ({ id: fixtureThread.id, status: "active", turns: [{ id: "turn-busy", status: "running" }] }),
    startTurn: async () => { busyStartCalled = true; return { id: "should-not-start" }; },
  };
  await assert.rejects(new ConversationService({ getReadyClient: () => busyClient }).startTurn("thread-conversation", "busy input"), ActiveTurnError);
  assert.equal(busyStartCalled, false);
  let activeOnlyStartCalled = false;
  const activeOnlyClient: ConversationClient = {
    ...client,
    readThread: async () => ({ id: fixtureThread.id, title: "Active-only fixture", status: "active", turns: [] }),
    listTurns: async () => ({ turns: [] }),
    resumeThread: async () => ({ id: fixtureThread.id, title: "Active-only fixture", status: "active", canAcceptDirectInput: true }),
    startTurn: async () => { activeOnlyStartCalled = true; return { id: "turn-active-only" }; },
  };
  const activeOnlyService = new ConversationService({ getReadyClient: () => activeOnlyClient });
  const activeOnlyView = await activeOnlyService.readThread("thread-conversation");
  assert.equal(activeOnlyView.remoteActive, undefined);
  assert.deepEqual(await activeOnlyService.startTurn("thread-conversation", "available input"), { threadId: "thread-conversation", turnId: "turn-active-only" });
  assert.equal(activeOnlyStartCalled, true);
  const activeWriterResponseClient: ConversationClient = {
    ...client,
    readThread: async () => ({ id: fixtureThread.id, title: "Available fixture", status: "completed" }),
    listTurns: async () => ({ turns: [] }),
    resumeThread: async () => ({ id: fixtureThread.id, title: "Available fixture", canAcceptDirectInput: true }),
    startTurn: async () => { throw new AppServerError("thread already has an active writer", "server", "active_writer"); },
  };
  const activeWriterResponseService = new ConversationService({ getReadyClient: () => activeWriterResponseClient });
  await activeWriterResponseService.readThread("thread-conversation");
  await assert.rejects(activeWriterResponseService.startTurn("thread-conversation", "preserve busy input"), ActiveTurnError);
  assert.equal(activeWriterResponseService.getLoadedThread("thread-conversation")?.remoteActive, true);
  const refreshStates = [
    { id: fixtureThread.id, title: "Refresh fixture", status: "completed" },
    { id: fixtureThread.id, title: "Refresh fixture", status: "active" },
  ];
  let refreshIndex = 0;
  const refreshClient: ConversationClient = {
    ...client,
    readThread: async () => refreshStates[Math.min(refreshIndex++, refreshStates.length - 1)] ?? refreshStates[0]!,
    listTurns: async () => ({ turns: [] }),
    resumeThread: async () => ({ id: fixtureThread.id, title: "Refresh fixture", canAcceptDirectInput: true }),
    startTurn: async () => { throw new AppServerError("thread already has an active writer", "server", "active_writer"); },
  };
  const refreshService = new ConversationService({ getReadyClient: () => refreshClient });
  await refreshService.readThread("thread-conversation");
  await assert.rejects(refreshService.startTurn("thread-conversation", "preserve through refresh"), ActiveTurnError);
  assert.equal(refreshService.getLoadedThread("thread-conversation")?.remoteActive, true);
  const refreshedView = await refreshService.readThread("thread-conversation");
  assert.equal(refreshedView.status, "active");
  assert.equal(refreshedView.remoteActive, undefined);
  const failingProvider: ConversationClientProvider = { getReadyClient: () => ({ ...client, readThread: async () => { throw new ProtocolError("fixture read failed"); } }) };
  await assert.rejects(new ConversationService(failingProvider).readThread("thread-conversation"), ProtocolError);
  console.log("[desktop-test] conversation service checks passed");
}

main().catch((error: unknown) => {
  console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
