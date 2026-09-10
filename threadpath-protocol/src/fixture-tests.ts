import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { errorFromServer, getThread, getThreads, getTurnPage, isJsonObject, parseInitializeResult, readString, terminalTurnEvent, type JsonObject } from "./protocol.ts";

const fixtureDirectory = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJsonLines(name: string): Promise<unknown[]> {
  const content = await readFile(`${fixtureDirectory}/${name}`, "utf8");
  return content.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
}

function asObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error("fixture message must be a JSON object");
  return value;
}

async function main(): Promise<void> {
  const initialize = await readJsonLines("initialize-success.jsonl");
  assert.equal(initialize.length, 2);
  assert.equal(asObject(initialize[0]).method, "initialize");
  assert.ok(isJsonObject(asObject(initialize[1]).result));

  const initializeError = await readJsonLines("initialize-error.jsonl");
  assert.equal(initializeError.length, 2);
  assert.equal(asObject(initializeError[0]).method, "initialize");
  assert.equal(errorFromServer(asObject(initializeError[1]).error).category, "server");

  const completeCapabilities = parseInitializeResult(asObject((await readJsonLines("initialize-capabilities-complete.jsonl"))[1]).result);
  assert.equal(completeCapabilities.serverVersion, "1.2.3");
  assert.equal(completeCapabilities.protocolVersion, "2026-01");
  assert.equal(completeCapabilities.capabilities.known, true);
  assert.deepEqual(completeCapabilities.capabilities.methods, ["thread/list", "thread/read", "thread/turns/list", "thread/start", "turn/start"]);
  assert.deepEqual(completeCapabilities.capabilities.events, ["turn/completed", "turn/failed", "turn/interrupted"]);
  assert.equal(completeCapabilities.compatibility?.status, "compatible");

  const optionalCapabilities = parseInitializeResult(asObject((await readJsonLines("initialize-capabilities-optional-missing.jsonl"))[1]).result);
  assert.equal(optionalCapabilities.capabilities.known, true);
  assert.equal(optionalCapabilities.capabilities.methods.includes("thread/read"), false);
  assert.equal(optionalCapabilities.capabilities.methods.includes("thread/turns/list"), false);

  const requiredCapabilities = parseInitializeResult(asObject((await readJsonLines("initialize-capabilities-required-missing.jsonl"))[1]).result);
  assert.equal(requiredCapabilities.capabilities.methods.includes("turn/start"), false);

  const legacyInitialize = parseInitializeResult(asObject((await readJsonLines("initialize-no-capabilities.jsonl"))[1]).result);
  assert.equal(legacyInitialize.capabilities.known, false);
  assert.equal(legacyInitialize.serverVersion, "0.9.0");

  const emptyThreads = await readJsonLines("thread-list-empty.jsonl");
  assert.equal(emptyThreads.length, 2);
  assert.deepEqual(getThreads(asObject(emptyThreads[1]).result), []);
  const existingThreads = await readJsonLines("thread-list-existing.jsonl");
  assert.equal(existingThreads.length, 2);
  assert.deepEqual(getThreads(asObject(existingThreads[1]).result), [{ id: "thread-1", title: "Fixture thread", status: "completed" }]);
  const threadRead = await readJsonLines("thread-read.jsonl");
  assert.equal(threadRead.length, 2);
  assert.equal(getThread(asObject(threadRead[1]).result)?.turns?.[0]?.id, "turn-1");
  const threadResume = await readJsonLines("thread-resume.jsonl");
  assert.equal(asObject(threadResume[0]).method, "thread/resume");
  assert.equal(getThread(asObject(threadResume[1]).result)?.canAcceptDirectInput, true);
  const readOnlyResume = await readJsonLines("thread-resume-read-only.jsonl");
  assert.equal(getThread(asObject(readOnlyResume[1]).result)?.canAcceptDirectInput, false);
  const turnsList = await readJsonLines("turns-list.jsonl");
  assert.equal(turnsList.length, 2);
  assert.deepEqual(getTurnPage(asObject(turnsList[1]).result), { turns: [{ id: "turn-1", status: "completed" }] });
  const pagedTurns = await readJsonLines("turns-list-pages.jsonl");
  const firstPage = getTurnPage(asObject(pagedTurns[1]).result);
  assert.equal(firstPage.turns.length, 2);
  assert.equal(firstPage.nextCursor, "cursor-older");
  const secondRequestParams = asObject(pagedTurns[2]).params;
  assert.equal(isJsonObject(secondRequestParams) ? readString(secondRequestParams, "cursor") : undefined, "cursor-older");

  for (const [name, method] of [["thread-start.jsonl", "thread/start"], ["turn-start.jsonl", "turn/start"]] as const) {
    const messages = await readJsonLines(name);
    assert.equal(messages.length, 2);
    assert.equal(asObject(messages[0]).method, method);
  }

  const delta = await readJsonLines("turn-delta.jsonl");
  assert.equal(delta.length, 1);
  assert.equal(asObject(delta[0]).method, "item/agentMessage/delta");

  for (const [name, outcome] of [["turn-completed.jsonl", "completed"], ["turn-failed.jsonl", "failed"], ["turn-interrupted.jsonl", "interrupted"]] as const) {
    const messages = await readJsonLines(name);
    assert.equal(messages.length, 1);
    const message = asObject(messages[0]);
    assert.equal(terminalTurnEvent(String(message.method), asObject(message.params))?.outcome, outcome);
  }

  const serverError = await readJsonLines("server-error.jsonl");
  assert.equal(serverError.length, 2);
  assert.equal(asObject(serverError[0]).method, "thread/list");
  assert.equal(errorFromServer(asObject(serverError[1]).error).category, "server");

  const unknownRequest = await readJsonLines("unknown-request-id.jsonl");
  assert.ok(isJsonObject(unknownRequest[0]));
  assert.equal(unknownRequest[0].id, 999);

  const processExit = await readJsonLines("process-exit.jsonl");
  assert.ok(isJsonObject(processExit[0]));
  assert.equal(processExit[0].expectedExitCode, 7);
  const timeout = await readJsonLines("timeout.jsonl");
  assert.ok(isJsonObject(timeout[0]));
  assert.equal(timeout[0].expected, "no-response");

  const malformed = await readFile(`${fixtureDirectory}/malformed-stdout.txt`, "utf8");
  assert.throws(() => JSON.parse(malformed), SyntaxError);
  console.log("[fixture-test] protocol fixtures passed");
}

main().catch((error: unknown) => {
  console.error(`[fixture-test] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
