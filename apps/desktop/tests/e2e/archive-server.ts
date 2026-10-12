import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { isJsonObject, type JsonObject } from "../../../../threadpath-protocol/src/protocol.ts";

const statePath = process.env.ARCHIVE_STATE_PATH;
const logPath = process.env.ARCHIVE_REQUEST_LOG;
const mode = process.env.ARCHIVE_FIXTURE_MODE;
const restored: unknown = statePath !== undefined && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
const threads: JsonObject[] = Array.isArray(restored) ? restored.filter(isJsonObject) : [
  { id: "archive-target", title: "Archive test conversation", cwd: process.cwd(), status: "idle", archived: false },
  { id: "archive-existing", title: "Previously archived conversation", cwd: process.cwd(), status: "idle", archived: true },
  { id: "archive-active", title: "Externally running conversation", cwd: process.cwd(), status: "active", archived: false },
];
// Keep one process's list index stale after the mutation, but persisted restart state correct.
const indexed = threads.map((thread) => ({ ...thread }));
function save(): void { if (statePath !== undefined) writeFileSync(statePath, JSON.stringify(threads)); }
function send(message: JsonObject): void { process.stdout.write(`${JSON.stringify(message)}\n`); }
createInterface({ input: process.stdin }).on("line", (line: string) => {
  const request: unknown = JSON.parse(line);
  if (!isJsonObject(request) || typeof request.id !== "number") return;
  const id = request.id;
  const params = isJsonObject(request.params) ? request.params : {};
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify({ method: request.method, threadId: params.threadId ?? null })}\n`);
  const reply = (result: JsonObject): void => send({ id, result });
  if (request.method === "initialize") { reply({ serverInfo: { version: "archive-fixture" } }); return; }
  if (request.method === "model/list") { reply({ data: [] }); return; }
  if (request.method === "thread/list") {
    // Real Thread metadata need not carry an archived flag. The filter proves it.
    reply({ data: indexed.filter((thread) => thread.archived === (params.archived === true)).map(({ archived, ...thread }) => thread) }); return;
  }
  const thread = threads.find((item) => item.id === params.threadId);
  if (thread === undefined) { send({ id, error: { code: "thread_not_found", message: "Synthetic thread not found" } }); return; }
  const turns = [{ id: `${thread.id}-turn`, status: thread.status === "active" ? "inProgress" : "completed", items: [{ id: "synthetic-user", type: "userMessage", text: "Synthetic archive question" }, { id: "synthetic-assistant", type: "agentMessage", text: "Synthetic archive response" }] }];
  switch (request.method) {
    case "thread/read": reply({ thread: { ...thread, turns } }); break;
    case "thread/turns/list": reply({ data: turns }); break;
    case "thread/archive":
    case "thread/unarchive":
      if (mode === "failure") { send({ id, error: { code: "archive_failed", message: "Synthetic archive failure" } }); break; }
      thread.archived = request.method === "thread/archive"; save();
      reply(request.method === "thread/archive" ? {} : { thread }); break;
    default: send({ id, error: { code: -32601, message: "Unsupported fixture operation" } });
  }
});
