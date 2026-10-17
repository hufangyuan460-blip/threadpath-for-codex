import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.ts";

// Stateful fixture only. Its optional file contains synthetic test history, never user sessions.
interface FakeThread extends JsonObject { id: string; sessionId: string; forkedFromId: string | null; turns: JsonObject[]; }
interface FakeState { nextThread: number; nextTurn: number; threads: Record<string, FakeThread>; }
const statePath = process.env.FAKE_FORK_STATE_PATH;
const mode = process.env.FAKE_FORK_MODE ?? "normal";
const observatory = process.env.FAKE_OBSERVATORY === "1";
const capabilityMode = process.env.FAKE_FORK_CAPABILITIES ?? "absent";
// This file is written only by this fixture; the cast is confined to the fixture boundary.
const state: FakeState = statePath !== undefined && existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8")) as FakeState
  : { nextThread: 1, nextTurn: 1, threads: {} };
if (process.env.FAKE_FORK_E2E === "1" && Object.keys(state.threads).length === 0) {
  state.threads["fixture-source"] = { id: "fixture-source", sessionId: "fixture-source", forkedFromId: null, title: "Choose a project architecture", cwd: process.cwd(), status: "idle", canAcceptDirectInput: true, turns: [
    { id: "source-base", status: "completed", items: [{ id: "base-user", type: "userMessage", text: "Compare two ways to organize conversation history." }, { id: "base-answer", type: "agentMessage", text: "Keep each conversation independent. A branch can inherit the context up to a chosen turn, so you can explore another approach without losing the first one." }] },
    { id: "source-later", status: "completed", items: [{ id: "later-user", type: "userMessage", text: "Continue with the linear history approach." }, { id: "later-answer", type: "agentMessage", text: "Source-only continuation: keep a single ordered list of conversations." }] },
  ] };
}
let lastForkParams: JsonObject = {};
if (observatory && state.threads["fixture-unknown"] === undefined) {
  state.threads["fixture-unknown"] = { id: "fixture-unknown", sessionId: "fixture-unknown", forkedFromId: null, title: "Unknown usage conversation", cwd: process.cwd(), status: "idle", canAcceptDirectInput: true, turns: [
    { id: "unknown-turn", status: "completed", items: [{ id: "unknown-user", type: "userMessage", text: "Unknown usage conversation" }, { id: "history-compaction", type: "contextCompaction" }] },
  ] };
}
function usage(threadId: string, turnId: string, totalTokens: number, window: number | null = 475000): void {
  const total = { totalTokens, inputTokens: 50000, cachedInputTokens: 20000, cacheWriteInputTokens: 1000, outputTokens: 10321, reasoningOutputTokens: 4000 };
  const last = { totalTokens: 18234, inputTokens: 15000, cachedInputTokens: 5000, cacheWriteInputTokens: 200, outputTokens: 3234, reasoningOutputTokens: 1000 };
  send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total, last, modelContextWindow: window } } });
}
function persist(): void { if (statePath !== undefined) writeFileSync(statePath, JSON.stringify(state)); }
function send(message: JsonObject): void { process.stdout.write(`${JSON.stringify(message)}\n`); }
function reply(id: number, result: JsonObject): void { send({ id, result }); }
function reject(id: number, code: number | string, message: string): void { send({ id, error: { code, message } }); }
function threadResult(thread: FakeThread): JsonObject { return { thread, sandbox: { type: thread.readOnly === true ? "readOnly" : "workspaceWrite", networkAccess: false } }; }

createInterface({ input: process.stdin }).on("line", (line: string) => {
  const request: JsonValue = JSON.parse(line) as JsonValue;
  if (!isJsonObject(request) || typeof request.id !== "number") return;
  const id = request.id;
  const params = isJsonObject(request.params) ? request.params : {};
  const threadId = typeof params.threadId === "string" ? params.threadId : "";
  const source = state.threads[threadId];
  if (request.method === "initialize") {
    const result: JsonObject = { serverInfo: { name: "fake-fork-app-server", version: "fixture-fork-1" } };
    if (capabilityMode !== "absent") result.capabilities = {
      methods: ["thread/list", "thread/read", "thread/start", "thread/resume", "thread/turns/list", "turn/start", ...(capabilityMode === "complete" ? ["thread/fork"] : [])],
      events: ["turn/completed"],
    };
    reply(id, result);
    return;
  }
  if (request.method === "thread/start") {
    const newId = `fixture-thread-${state.nextThread++}`;
    const thread: FakeThread = { id: newId, sessionId: newId, forkedFromId: null, turns: [], cwd: typeof params.cwd === "string" ? params.cwd : process.cwd() };
    state.threads[newId] = thread;
    persist();
    reply(id, threadResult(thread));
    return;
  }
  if (request.method === "thread/list") { reply(id, { data: Object.values(state.threads).filter((thread) => (thread.archived === true) === (params.archived === true)).map(({ turns, ...metadata }) => metadata) }); return; }
  if (request.method === "model/list") { reply(id, { data: [], nextCursor: null }); return; }
  if (request.method === "test/forkParams") { reply(id, lastForkParams); return; }
  if (request.method === "thread/fork") {
    lastForkParams = params;
    if (mode === "unsupported") { reject(id, -32601, "Method not found"); return; }
    if (mode === "timeout") return;
    if (mode === "exit") { process.exit(7); }
    if (mode === "malformed") { reply(id, { thread: {} }); return; }
    if (mode === "same-id") { reply(id, { thread: { id: threadId } }); return; }
    if (source === undefined) { reject(id, "thread_not_found", "fixture thread not found"); return; }
    const lastTurnId = params.lastTurnId;
    const endIndex = lastTurnId === undefined ? source.turns.length - 1 : source.turns.findIndex((turn) => turn.id === lastTurnId);
    if (lastTurnId !== undefined && endIndex < 0) { reject(id, -32602, "unknown lastTurnId"); return; }
    if (source.turns[endIndex]?.status === "inProgress") { reject(id, -32602, "lastTurnId is in progress"); return; }
    const newId = `fixture-thread-${state.nextThread++}`;
    const thread: FakeThread = {
      ...source, id: newId, sessionId: newId, forkedFromId: source.id,
      turns: JSON.parse(JSON.stringify(source.turns.slice(0, endIndex + 1))) as JsonObject[],
      cwd: typeof params.cwd === "string" ? params.cwd : source.cwd,
      readOnly: params.sandbox === "read-only",
    };
    state.threads[newId] = thread;
    persist();
    reply(id, threadResult(thread));
    send({ method: "thread/started", params: { thread } });
    if (observatory) usage(newId, String(thread.turns.at(-1)?.id), 60321);
    return;
  }
  if (source === undefined) { reject(id, "thread_not_found", "fixture thread not found"); return; }
  switch (request.method) {
    case "thread/read": reply(id, threadResult(source)); break;
    case "thread/resume": {
      if (observatory) {
        usage(threadId, String(source.turns.at(-1)?.id), 60321);
        usage(threadId, String(source.turns.at(-1)?.id), 60321);
      }
      if (params.sandbox === "read-only") source.readOnly = mode !== "unsafe-sandbox";
      source.lastResumeSandbox = params.sandbox ?? null;
      persist();
      reply(id, threadResult(source));
      break;
    }
    case "thread/turns/list": reply(id, { data: [...source.turns].reverse() }); break;
    case "turn/start": {
      const text = Array.isArray(params.input) ? params.input.filter(isJsonObject).map((item) => typeof item.text === "string" ? item.text : "").join("\n") : "";
      const newTurnId = `fixture-turn-${state.nextTurn++}`;
      const turn: JsonObject = { id: newTurnId, status: "inProgress", items: [{ id: `${newTurnId}-user`, type: "userMessage", text }] };
      source.turns.push(turn);
      persist();
      reply(id, { turn });
      if (observatory) {
        const compact = { id: `${newTurnId}-compaction`, type: "contextCompaction" };
        if (Array.isArray(turn.items)) turn.items.push(compact);
        send({ method: "item/started", params: { threadId, turnId: newTurnId, item: compact } });
        send({ method: "item/started", params: { threadId, turnId: newTurnId, item: compact } });
      }
      if (mode !== "hold") setTimeout(() => {
        turn.status = "completed";
        if (Array.isArray(turn.items)) turn.items.push({ id: `${newTurnId}-answer`, type: "agentMessage", text: `Independent reply: ${text}` });
        persist();
        send({ method: "item/agentMessage/delta", params: { threadId, turnId: newTurnId, itemId: `${newTurnId}-answer`, delta: `Independent reply: ${text}` } });
        if (observatory) {
          const compact = { id: `${newTurnId}-compaction`, type: "contextCompaction" };
          send({ method: "item/completed", params: { threadId, turnId: newTurnId, item: compact } });
          send({ method: "item/completed", params: { threadId, turnId: newTurnId, item: compact } });
          usage(threadId, newTurnId, 70000, null);
          usage(threadId, newTurnId, 70000, null);
        }
        send({ method: "turn/completed", params: { threadId, turn } });
      }, observatory ? 1500 : 10);
      break;
    }
    default: reject(id, -32601, "Method not found");
  }
});
