import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { isJsonObject, type JsonObject } from "../../../../threadpath-protocol/src/protocol.ts";

const mode = process.env.BRANCH_POINT_MODE;
const requestLog = process.env.BRANCH_POINT_REQUEST_LOG;
let failedOnce = false;
const sourceTurns: JsonObject[] = Array.from({ length: 60 }, (_, index) => ({ id: `source-${index + 1}`, status: "completed", items: [{ id: `user-${index}`, type: "userMessage", text: `Source question ${index + 1}` }, { id: `answer-${index}`, type: "agentMessage", text: `Source answer ${index + 1}. This is synthetic history for navigation validation.` }] }));
const branchTurns: JsonObject[] = [...sourceTurns.slice(0, 12), ...Array.from({ length: 35 }, (_, index) => ({ id: `branch-new-${index + 1}`, status: "completed", items: [{ id: `branch-user-${index}`, type: "userMessage", text: `Independent question ${index + 1}` }, { id: `branch-answer-${index}`, type: "agentMessage", text: `Independent answer ${index + 1}. Continue exploring this alternative.` }] }))];
const threads = new Map<string, JsonObject>([
  ["branch-source", { id: "branch-source", title: "Source conversation", cwd: process.cwd(), status: "idle" }],
  ["branch-child", { id: "branch-child", title: "Alternative plan", forkedFromId: "branch-source", cwd: process.cwd(), status: "idle" }],
  ["branch-other", { id: "branch-other", title: "Other route", forkedFromId: "branch-source", cwd: process.cwd(), status: "idle" }],
]);
function send(value: JsonObject): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
createInterface({ input: process.stdin }).on("line", (line: string) => {
  const request: unknown = JSON.parse(line);
  if (!isJsonObject(request) || typeof request.id !== "number") return;
  const params = isJsonObject(request.params) ? request.params : {};
  const threadId = typeof params.threadId === "string" ? params.threadId : "";
  if (requestLog !== undefined) appendFileSync(requestLog, `${JSON.stringify({ method: request.method, threadId, cursor: params.cursor ?? null })}\n`);
  const reply = (result: JsonObject): void => send({ id: request.id!, result });
  if (request.method === "initialize") { reply({ serverInfo: { version: "branch-point-fixture" } }); return; }
  if (request.method === "model/list") { reply({ data: [] }); return; }
  if (request.method === "thread/list") { reply({ data: params.archived === true ? [] : [...threads.values()] }); return; }
  const metadata = threads.get(threadId);
  if (metadata === undefined) { send({ id: request.id, error: { code: "thread_not_found", message: "Synthetic thread not found" } }); return; }
  const turns = threadId === "branch-source" ? sourceTurns.filter((turn) => mode !== "missing" || turn.id !== "source-12") : threadId === "branch-child" ? branchTurns : sourceTurns.slice(0, 12);
  if (request.method === "thread/read") {
    const run = (): void => reply({ thread: { ...metadata, ...(mode === "wrong-source" && threadId === "branch-source" ? { id: "wrong-source" } : {}), turns: turns.slice(-20), canAcceptDirectInput: true } });
    if (mode === "delayed" && threadId === "branch-source") setTimeout(run, 250);
    else run();
    return;
  }
  if (request.method === "thread/turns/list") {
    if (mode === "fail-once" && threadId === "branch-source" && params.cursor !== undefined && !failedOnce) {
      failedOnce = true;
      send({ id: request.id, error: { code: "fixture_offline", message: "Synthetic page unavailable" } });
      return;
    }
    const end = typeof params.cursor === "string" ? Number(params.cursor) : turns.length;
    const start = Math.max(0, end - 20);
    reply({ data: turns.slice(start, end).reverse(), nextCursor: start === 0 ? null : String(start) });
    return;
  }
  send({ id: request.id, error: { code: -32601, message: "This navigation fixture only supports reads" } });
});
