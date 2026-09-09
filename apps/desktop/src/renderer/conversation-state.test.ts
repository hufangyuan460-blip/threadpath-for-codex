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
  assert.equal(turn?.items.filter((item) => item.id === "item-live").length, 1);
  assert.deepEqual(thread.paging.orderedTurnIds, ["turn-live"]);
  assert.equal(thread.turns.some((item) => item.id === "old-turn"), false);

  const failed = updates.find((update) => update.type === "turn/failed");
  assert.equal(failed?.threadId, "thread-failed");
  const interrupted = updates.find((update) => update.type === "turn/interrupted");
  assert.equal(interrupted?.turnId, "turn-interrupted");
  console.log("[desktop-test] conversation update checks passed");
}

main().catch((error: unknown) => {
  console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
