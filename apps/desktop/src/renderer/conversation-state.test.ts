import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isJsonObject, type JsonObject } from "../../../../threadpath-protocol/src/protocol.ts";
import type { ConversationThreadView } from "../shared/api.ts";
import { applyConversationUpdate, conversationUpdateKey } from "./conversation-state.ts";
import { toConversationUpdate } from "../main/conversation-service.ts";

const fixturePath = fileURLToPath(new URL("../../../../threadpath-protocol/fixtures/conversation-updates.jsonl", import.meta.url));

function asObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error("fixture message must be an object");
  return value;
}

async function main(): Promise<void> {
  const messages = (await readFile(fixturePath, "utf8")).split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => asObject(JSON.parse(line) as unknown));
  const updates = messages.map((message) => toConversationUpdate(String(message.method), asObject(message.params))).filter((update) => update !== undefined);
  assert.equal(updates.length, messages.length);
  let thread: ConversationThreadView = { id: "thread-1", title: "Live thread", status: "active", turns: [], outline: [], paging: { orderedTurnIds: [], firstItemIndex: 1000000, hasMore: false, isLoadingMore: false } };
  const seen = new Set<string>();
  for (const update of updates) {
    const key = conversationUpdateKey(update);
    if (seen.has(key)) continue;
    seen.add(key);
    thread = applyConversationUpdate(thread, update);
  }
  const turn = thread.turns[0];
  assert.equal(turn?.status, "completed");
  assert.deepEqual(thread.outline[0], { turnId: "turn-live", index: 1, label: "Hello world", status: "completed" });
  const liveItem = turn?.items.find((item) => item.id === "item-live");
  assert.equal(liveItem?.kind, "text");
  assert.equal(liveItem?.kind === "text" ? liveItem.text : undefined, "Hello world");
  assert.equal(liveItem?.kind === "text" ? liveItem.phase : undefined, "final");
  assert.equal(turn?.items.filter((item) => item.id === "item-live").length, 1);
  assert.deepEqual(thread.paging.orderedTurnIds, ["turn-live"]);
  assert.equal(thread.turns.some((item) => item.id === "old-turn"), false);

  const started = updates.find((update) => update.type === "turn/started");
  assert.equal(started?.type, "turn/started");
  const activeThread = applyConversationUpdate({ ...thread, turns: [], outline: [], paging: { ...thread.paging, orderedTurnIds: [] }, remoteActive: undefined, remoteActiveTurnId: undefined }, started!);
  assert.equal(activeThread.remoteActive, true);
  const completed = updates.find((update) => update.type === "turn/completed");
  assert.equal(applyConversationUpdate(activeThread, completed!).remoteActive, undefined);

  const failed = updates.find((update) => update.type === "turn/failed");
  assert.equal(failed?.threadId, "thread-failed");
  const interrupted = updates.find((update) => update.type === "turn/interrupted");
  assert.equal(interrupted?.turnId, "turn-interrupted");

  let failedThread: ConversationThreadView = { id: "thread-failed", title: "Failed thread", status: "active", turns: [], outline: [], paging: { orderedTurnIds: [], firstItemIndex: 1000000, hasMore: false, isLoadingMore: false } };
  failedThread = applyConversationUpdate(failedThread, { type: "turn/started", threadId: "thread-failed", turnId: "turn-failed" });
  failedThread = applyConversationUpdate(failedThread, { type: "item/agentMessage/delta", threadId: "thread-failed", turnId: "turn-failed", itemId: "failed-item", delta: "partial **reply" });
  failedThread = applyConversationUpdate(failedThread, { type: "turn/failed", threadId: "thread-failed", turnId: "turn-failed", message: "Turn failed" });
  const failedText = failedThread.turns[0]?.items.find((item) => item.id === "failed-item");
  assert.equal(failedText?.kind === "text" ? failedText.phase : undefined, "streaming");
  assert.equal(failedThread.turns[0]?.items.some((item) => item.kind === "status" && item.text === "Turn failed"), true);

  let interruptedThread: ConversationThreadView = { id: "thread-interrupted", title: "Interrupted thread", status: "active", turns: [], outline: [], paging: { orderedTurnIds: [], firstItemIndex: 1000000, hasMore: false, isLoadingMore: false } };
  interruptedThread = applyConversationUpdate(interruptedThread, { type: "turn/started", threadId: "thread-interrupted", turnId: "turn-interrupted" });
  interruptedThread = applyConversationUpdate(interruptedThread, { type: "item/agentMessage/delta", threadId: "thread-interrupted", turnId: "turn-interrupted", itemId: "interrupted-item", delta: "partial reply" });
  interruptedThread = applyConversationUpdate(interruptedThread, { type: "turn/interrupted", threadId: "thread-interrupted", turnId: "turn-interrupted", message: "Turn interrupted" });
  const interruptedText = interruptedThread.turns[0]?.items.find((item) => item.id === "interrupted-item");
  assert.equal(interruptedText?.kind === "text" ? interruptedText.phase : undefined, "streaming");
  assert.equal(interruptedThread.turns[0]?.items.some((item) => item.kind === "status" && item.text === "Turn interrupted"), true);
  console.log("[desktop-test] conversation update checks passed");
}

main().catch((error: unknown) => {
  console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
