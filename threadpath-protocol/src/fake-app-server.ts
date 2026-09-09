import { createInterface } from "node:readline";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.ts";

const mode = process.env.FAKE_APP_SERVER_MODE ?? "completed";
const hasExistingThread = process.env.FAKE_APP_SERVER_HAS_THREAD === "true";
const capabilityMode = process.env.FAKE_APP_SERVER_CAPABILITIES ?? "absent";
const e2eMode = mode.startsWith("e2e-");
const e2eOutcome = mode.slice("e2e-".length) as "completed" | "failed" | "interrupted";
let probeRequestId: number | undefined;
let serverRequestId: number | string | undefined;
function send(message: JsonObject): void { process.stdout.write(`${JSON.stringify(message)}\n`); }
function initializeResult(): JsonObject {
  const result: JsonObject = { serverInfo: { name: "fake-app-server", version: "fixture-1.0" } };
  if (capabilityMode === "complete" || capabilityMode === "optional-missing" || capabilityMode === "required-missing") {
    const methods = capabilityMode === "required-missing"
      ? ["thread/list", "thread/start"]
      : capabilityMode === "optional-missing"
        ? ["thread/list", "thread/start", "turn/start"]
        : ["thread/list", "thread/read", "thread/turns/list", "thread/start", "turn/start"];
    result.capabilities = {
      methods,
      events: ["turn/completed", "turn/failed", "turn/interrupted"],
      futureCapabilityField: true,
    };
    result.compatibility = { status: "compatible", futureField: "ignored" };
  }
  return result;
}
function e2eTurns(): JsonObject[] {
  return Array.from({ length: 24 }, (_, index) => ({
    id: `e2e-turn-${index + 1}`,
    status: "completed",
    createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    items: [
      { id: `e2e-user-${index + 1}`, type: "userMessage", role: "user", text: `User turn ${index + 1}` },
      { id: `e2e-assistant-${index + 1}`, type: "agentMessage", role: "assistant", text: `Assistant reply ${index + 1}` },
    ],
  }));
}
if (mode === "non-json") process.stdout.write("this is not JSON\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line: string) => {
  let message: JsonValue;
  try { message = JSON.parse(line) as JsonValue; } catch { return; }
  if (!isJsonObject(message) || typeof message.method !== "string") {
    if (isJsonObject(message) && message.id === serverRequestId && isJsonObject(message.error) && probeRequestId !== undefined) {
      send({ jsonrpc: "2.0", id: probeRequestId, result: { serverRequestError: message.error } });
      probeRequestId = undefined;
      serverRequestId = undefined;
    }
    return;
  }
  const id = typeof message.id === "number" ? message.id : undefined;
  if (id === undefined) return;
  if (mode === "server-error") {
    send({ jsonrpc: "2.0", id, error: { code: "server_failure", message: `Fake server rejected ${message.method}` } });
    return;
  }
  switch (message.method) {
    case "initialize": send({ jsonrpc: "2.0", id, result: initializeResult() }); break;
    case "thread/list": send({ jsonrpc: "2.0", id, result: { data: e2eMode || hasExistingThread ? [{ id: e2eMode ? "e2e-thread" : "existing-thread", title: e2eMode ? "E2E conversation" : "Existing" }] : [] } }); break;
    case "thread/read": send({ jsonrpc: "2.0", id, result: { thread: { id: e2eMode ? "e2e-thread" : "existing-thread", title: e2eMode ? "E2E conversation" : "Existing", turns: e2eMode ? e2eTurns() : [] } } }); break;
    case "thread/turns/list": send({ jsonrpc: "2.0", id, result: { data: e2eMode ? e2eTurns() : [] } }); break;
    case "thread/start": send({ jsonrpc: "2.0", id, result: { thread: { id: "new-thread" } } }); break;
    case "turn/start":
      send({ jsonrpc: "2.0", id, result: { turn: { id: e2eMode ? "e2e-live-turn" : "turn-1" } } });
      if (mode === "timeout") break;
      setTimeout(() => {
        const turnId = e2eMode ? "e2e-live-turn" : "turn-1";
        const threadId = e2eMode ? "e2e-thread" : undefined;
        if (e2eMode) {
          send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "e2e-thread", turnId, turn: { id: turnId } } });
          send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "e2e-thread", turnId, item: { id: "e2e-live-item", type: "agentMessage", role: "assistant" } } });
          send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "e2e-thread", turnId, itemId: "e2e-live-item", delta: "streamed fake reply" } });
          send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "e2e-thread", turnId, item: { id: "e2e-live-item", type: "agentMessage", role: "assistant", status: "completed" } } });
        }
        const params: JsonObject = { ...(threadId === undefined ? {} : { threadId }), turn: { id: turnId } };
        if (e2eMode && e2eOutcome === "failed") params.error = { code: "fake_failure", message: "Fake turn failed" };
        if (e2eMode && e2eOutcome === "interrupted") params.error = { code: "interrupted", message: "Fake turn interrupted" };
        if (!e2eMode && mode === "failed") params.error = { code: "network_timeout", message: "Responses connection timed out" };
        if (!e2eMode && mode === "interrupted") params.error = { code: "interrupted", message: "Turn was interrupted" };
        send({ jsonrpc: "2.0", method: `turn/${e2eMode ? e2eOutcome : mode}`, params });
      }, 10);
      break;
    case "probe/server-request":
      probeRequestId = id;
      serverRequestId = mode === "server-request-string" ? "approval-99" : 99;
      send({ jsonrpc: "2.0", id: serverRequestId, method: "approval/request", params: { reason: "test" } });
      break;
    case "test/timeout": break;
    case "test/exit": setTimeout(() => process.exit(7), 10); break;
    default: send({ jsonrpc: "2.0", id, error: { code: "unknown_method", message: `Unknown method ${message.method}` } });
  }
});
