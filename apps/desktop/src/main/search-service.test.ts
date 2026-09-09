import assert from "node:assert/strict";
import type { ConversationThreadView, ConversationTurnView } from "../shared/api.ts";
import { applyConversationUpdate } from "../shared/conversation-state.ts";
import { buildTurnOutline } from "../shared/outline.ts";
import { searchLoadedTurns } from "./search-service.ts";

function makeThread(id: string, turns: ConversationTurnView[]): ConversationThreadView {
  return { id, title: "Search fixture", status: "active", turns, outline: buildTurnOutline(turns), paging: { orderedTurnIds: turns.map((turn) => turn.id), hasMore: false, isLoadingMore: false } };
}

function main(): void {
  const longStatus = `<b>${"sensitive status ".repeat(20)}</b>`;
  const turns: ConversationTurnView[] = [
    { id: "turn-1", index: 1, status: "completed", items: [{ kind: "text", id: "user-1", role: "user", text: "修复登录超时" }, { kind: "text", id: "assistant-1", role: "assistant", text: "Fix login timeout" }] },
    { id: "turn-2", index: 2, status: "completed", items: [{ kind: "text", id: "user-2", role: "user", text: "Deploy API" }] },
    { id: "turn-3", index: 3, status: "failed", items: [{ kind: "status", id: "status-3", text: longStatus }] },
    { id: "turn-4", index: 4, status: "completed", items: [] },
  ];
  const thread = makeThread("thread-1", turns);

  assert.deepEqual(searchLoadedTurns(thread, ""), []);
  assert.equal(searchLoadedTurns(thread, "登录")[0]?.matchKind, "title");
  assert.equal(searchLoadedTurns(thread, "FIX")[0]?.matchKind, "assistant");
  assert.equal(searchLoadedTurns(thread, "deploy")[0]?.turnId, "turn-2");
  assert.equal(searchLoadedTurns(thread, "deploy").length, 1);
  assert.equal(searchLoadedTurns(thread, "failed")[0]?.turnId, "turn-3");
  const statusResult = searchLoadedTurns(thread, "sensitive")[0];
  assert.equal(statusResult?.snippet.includes("<b>"), false);
  assert.equal(statusResult?.snippet.length && statusResult.snippet.length <= 160, true);
  assert.equal(searchLoadedTurns(makeThread("thread-2", [turns[1]!]), "登录").length, 0);

  let streamingThread = makeThread("thread-stream", []);
  streamingThread = applyConversationUpdate(streamingThread, { type: "turn/started", threadId: "thread-stream", turnId: "turn-live" });
  streamingThread = applyConversationUpdate(streamingThread, { type: "item/agentMessage/delta", threadId: "thread-stream", turnId: "turn-live", itemId: "item-live", delta: "索引刷新" });
  assert.equal(searchLoadedTurns(streamingThread, "索引")[0]?.turnId, "turn-live");
  assert.equal(streamingThread.outline.length, 1);
  assert.equal(streamingThread.outline[0]?.turnId, "turn-live");
  console.log("[desktop-test] search service checks passed");
}

main();
