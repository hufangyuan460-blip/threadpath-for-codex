import assert from "node:assert/strict";
import type { ConversationTurnView } from "./api.ts";
import { buildTurnOutline } from "./outline.ts";

function turn(id: string, index: number, items: ConversationTurnView["items"]): ConversationTurnView {
  return { id, index, status: "completed", items };
}

function main(): void {
  const longText = `${"sensitive conversation ".repeat(10)}<b>hidden markup</b>`;
  const entries = buildTurnOutline([
    turn("turn-user", 1, [{ kind: "text", id: "user", role: "user", text: "  User question  " }]),
    turn("turn-assistant", 2, [{ kind: "text", id: "assistant", role: "assistant", text: "Assistant fallback" }]),
    turn("turn-status", 3, [{ kind: "status", id: "status", text: "Tool is running" }]),
    turn("turn-empty", 4, []),
    turn("turn-long", 5, [{ kind: "text", id: "long", role: "user", text: longText }]),
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
  console.log("[desktop-test] outline checks passed");
}

main();
