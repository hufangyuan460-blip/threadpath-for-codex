import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isJsonObject, type JsonObject } from "../../../../threadpath-protocol/src/protocol.ts";

// Test-only synthetic state. The history index deliberately never returns the created thread.
const statePath = process.env.NEW_CONVERSATION_STATE_PATH;
const restored: unknown = statePath !== undefined && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
let created: JsonObject | undefined = isJsonObject(restored) ? restored : undefined;
const historyDelayMs = Number(process.env.NEW_CONVERSATION_HISTORY_DELAY_MS ?? 0);
let historyVisibleAt = 0;
function historyTurns(): JsonObject[] {
  if (created === undefined || !Array.isArray(created.turns)) return [];
  return created.turns.filter(isJsonObject).map((turn) => Date.now() < historyVisibleAt ? { ...turn, items: [] } : turn);
}
function save(): void { if (statePath !== undefined && created !== undefined) writeFileSync(statePath, JSON.stringify(created)); }
function send(message: JsonObject): void { process.stdout.write(`${JSON.stringify(message)}\n`); }
createInterface({ input: process.stdin }).on("line", (line: string) => {
  const request: unknown = JSON.parse(line);
  if (!isJsonObject(request) || typeof request.id !== "number") return;
  const id = request.id;
  const params = isJsonObject(request.params) ? request.params : {};
  const reply = (result: JsonObject): void => send({ id, result });
  switch (request.method) {
    case "initialize": reply({ serverInfo: { version: "new-conversation-fixture" } }); break;
    case "model/list": reply({ data: [] }); break;
    case "thread/list": reply({ data: [] }); break;
    case "thread/start":
      created = { id: "created-not-indexed", cwd: params.cwd ?? process.cwd(), title: "Synthetic new conversation", status: "idle", turns: [], canAcceptDirectInput: true };
      save(); reply({ thread: created }); break;
    case "thread/read":
      if (created === undefined || params.threadId !== created.id) send({ id, error: { code: "thread_not_found", message: "Synthetic thread not found" } });
      else reply({ thread: { ...created, turns: historyTurns() } });
      break;
    case "thread/turns/list": reply({ data: historyTurns().reverse() }); break;
    case "turn/start": {
      if (created === undefined) { send({ id, error: { code: "thread_not_found", message: "Synthetic thread not found" } }); break; }
      const text = Array.isArray(params.input) ? params.input.filter(isJsonObject).map((item) => typeof item.text === "string" ? item.text : "").join("\n") : "";
      const turn: JsonObject = { id: "new-turn", status: "inProgress", items: [{ id: "new-user", type: "userMessage", text }] };
      created.turns = [turn]; save(); reply({ turn });
      historyVisibleAt = Date.now() + historyDelayMs;
      setTimeout(() => {
        turn.status = "completed";
        const response = "Reply in the newly created conversation.";
        if (Array.isArray(turn.items)) turn.items.push({ id: "new-assistant", type: "agentMessage", text: response });
        save();
        send({ method: "item/agentMessage/delta", params: { threadId: "created-not-indexed", turnId: "new-turn", itemId: "new-assistant", delta: response } });
        send({ method: "turn/completed", params: { threadId: "created-not-indexed", turn } });
      }, 1000);
      break;
    }
    default: send({ id, error: { code: -32601, message: "Unsupported fixture operation" } });
  }
});
