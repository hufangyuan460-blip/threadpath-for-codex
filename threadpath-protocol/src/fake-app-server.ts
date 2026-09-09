import { createInterface } from "node:readline";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.ts";

const mode = process.env.FAKE_APP_SERVER_MODE ?? "completed";
const hasExistingThread = process.env.FAKE_APP_SERVER_HAS_THREAD === "true";
let probeRequestId: number | undefined;
let serverRequestId: number | string | undefined;
function send(message: JsonObject): void { process.stdout.write(`${JSON.stringify(message)}\n`); }
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
    case "initialize": send({ jsonrpc: "2.0", id, result: { serverInfo: { name: "fake-app-server" } } }); break;
    case "thread/list": send({ jsonrpc: "2.0", id, result: { data: hasExistingThread ? [{ id: "existing-thread", title: "Existing" }] : [] } }); break;
    case "thread/read": send({ jsonrpc: "2.0", id, result: { thread: { id: "existing-thread", turns: [] } } }); break;
    case "thread/turns/list": send({ jsonrpc: "2.0", id, result: { data: [] } }); break;
    case "thread/start": send({ jsonrpc: "2.0", id, result: { thread: { id: "new-thread" } } }); break;
    case "turn/start":
      send({ jsonrpc: "2.0", id, result: { turn: { id: "turn-1" } } });
      if (mode === "timeout") break;
      setTimeout(() => {
        const params: JsonObject = { turn: { id: "turn-1" } };
        if (mode === "failed") params.error = { code: "network_timeout", message: "Responses connection timed out" };
        if (mode === "interrupted") params.error = { code: "interrupted", message: "Turn was interrupted" };
        send({ jsonrpc: "2.0", method: `turn/${mode}`, params });
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
