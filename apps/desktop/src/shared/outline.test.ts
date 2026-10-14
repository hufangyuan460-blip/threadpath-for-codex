import assert from "node:assert/strict";
import type { ConversationTurnView } from "./api.ts";
import { buildMessageOutline, buildTurnOutline } from "./outline.ts";
import { applyConversationUpdate } from "./conversation-state.ts";
import type { ConversationThreadView } from "./api.ts";

function turn(id: string, index: number, items: ConversationTurnView["items"]): ConversationTurnView {
  return { id, index, status: "completed", items };
}

function main(): void {
  const longText = `${"sensitive conversation ".repeat(10)}<b>hidden markup</b>`;
  const entries = buildTurnOutline([
    turn("turn-user", 1, [{ kind: "text", id: "user", role: "user", text: "  User question  ", phase: "historical" }]),
    turn("turn-assistant", 2, [{ kind: "text", id: "assistant", role: "assistant", text: "Assistant fallback", phase: "final" }]),
    turn("turn-status", 3, [{ kind: "status", id: "status", text: "Tool is running" }]),
    turn("turn-empty", 4, []),
    turn("turn-long", 5, [{ kind: "text", id: "long", role: "user", text: longText, phase: "historical" }]),
  ]);

  assert.deepEqual(entries.map((entry) => entry.turnId), ["turn-user", "turn-assistant", "turn-status", "turn-empty", "turn-long"]);
  assert.equal(entries[0]?.label, "User question");
  assert.equal(entries[1]?.label, "Assistant fallback");
  assert.equal(entries[2]?.label, "Tool is running");
  assert.equal(entries[3]?.label, "Turn 4");
  assert.equal(entries[4]?.label.includes("<b>"), false);
  assert.equal(entries[4]?.label.length <= 80, true);
  assert.equal(entries[4]?.label.endsWith("…"), true);
  assert.equal(entries[4]?.status, "completed");
  const messages = buildMessageOutline([
    turn("pair", 1, [
      { kind: "text", id: "question", role: "user", text: "Question", phase: "historical" },
      { kind: "tool", id: "tool", name: "Tool", status: "completed" },
      { kind: "text", id: "progress", role: "assistant", text: "Progress", phase: "streaming" },
      { kind: "text", id: "empty", role: "assistant", text: "   ", phase: "streaming" },
      { kind: "text", id: "answer", role: "assistant", text: longText, phase: "final" },
    ]),
    turn("empty", 2, []),
  ]);
  assert.deepEqual(messages.map(({ turnId, itemId, role }) => ({ turnId, itemId, role })), [
    { turnId: "pair", itemId: "question", role: "user" },
    { turnId: "pair", itemId: "answer", role: "assistant" },
    { turnId: "empty", itemId: undefined, role: "status" },
  ]);
  assert.ok(messages[1] !== undefined && messages[1].label.length <= 80 && messages[1].label.endsWith("…"));
  assert.equal(messages[1]?.label.includes("<b>"), false);
  let streaming: ConversationThreadView = { id: "stream", title: "Stream", status: "active", turns: [], outline: [], paging: { orderedTurnIds: [], firstItemIndex: 1000000, hasMore: false, isLoadingMore: false } };
  for (const [itemId, delta] of [["progress-1", "Checking files"], ["progress-2", "Running checks"], ["answer", "Final answer"], ["blank", "  "]] as const) {
    streaming = applyConversationUpdate(streaming, { type: "item/agentMessage/delta", threadId: "stream", turnId: "live", itemId, delta });
    assert.equal(buildMessageOutline(streaming.turns).filter((entry) => entry.role === "assistant").length, 1, "Multiple message IDs in one streamed response must keep one directory entry");
  }
  streaming = applyConversationUpdate(streaming, { type: "turn/completed", threadId: "stream", turnId: "live" });
  assert.equal(buildMessageOutline(streaming.turns)[0]?.itemId, "answer");
  assert.equal(buildMessageOutline(streaming.turns)[0]?.label, "Final answer");
  const reloaded = streaming.turns.map((value) => ({ ...value, items: value.items.map((item) => item.kind === "text" ? { ...item, phase: "final" as const } : item) }));
  assert.equal(buildMessageOutline(reloaded)[0]?.itemId, "answer", "History marks all model messages final; select the last non-empty one");
  assert.deepEqual(buildMessageOutline([...reloaded, turn("next", 2, [{ kind: "text", id: "next-answer", role: "assistant", text: "Next response", phase: "final" }])]).map((entry) => entry.itemId), ["answer", "next-answer"], "Never merge responses across turns");
  console.log("[desktop-test] outline checks passed");
}

main();
