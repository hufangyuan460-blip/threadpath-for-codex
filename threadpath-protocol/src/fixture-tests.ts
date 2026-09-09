import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { errorFromServer, isJsonObject, terminalTurnEvent } from "./protocol.ts";

const fixtureDirectory = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function readJsonLines(name: string): Promise<unknown[]> {
  const content = await readFile(`${fixtureDirectory}/${name}`, "utf8");
  return content.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
}

async function main(): Promise<void> {
  const initialize = await readJsonLines("initialize-success.jsonl");
  assert.equal(initialize.length, 1);
  assert.ok(isJsonObject(initialize[0]));
  assert.ok(isJsonObject(initialize[0].result));

  const initializeError = await readJsonLines("initialize-error.jsonl");
  assert.ok(isJsonObject(initializeError[0]));
  assert.equal(errorFromServer(initializeError[0].error).category, "server");

  assert.equal((await readJsonLines("thread-list-empty.jsonl")).length, 1);
  assert.equal((await readJsonLines("thread-list-existing.jsonl")).length, 1);
  assert.equal((await readJsonLines("thread-read.jsonl")).length, 1);
  assert.equal((await readJsonLines("turns-list.jsonl")).length, 1);

  for (const [name, outcome] of [["turn-completed.jsonl", "completed"], ["turn-failed.jsonl", "failed"], ["turn-interrupted.jsonl", "interrupted"]] as const) {
    const messages = await readJsonLines(name);
    assert.equal(messages.length, 1);
    assert.ok(isJsonObject(messages[0]));
    assert.ok(isJsonObject(messages[0].params));
    assert.equal(terminalTurnEvent(String(messages[0].method), messages[0].params)?.outcome, outcome);
  }

  const serverError = await readJsonLines("server-error.jsonl");
  assert.ok(isJsonObject(serverError[0]));
  assert.equal(errorFromServer(serverError[0].error).category, "server");

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
