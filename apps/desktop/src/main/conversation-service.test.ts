import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getThread, isJsonObject, ProtocolError, type JsonObject, type Thread } from "../../../../threadpath-protocol/src/protocol.ts";
import { ConversationService, toConversationThreadView } from "./conversation-service.ts";
import type { ThreadClient, ThreadClientProvider } from "./thread-service";

const fixturePath = fileURLToPath(new URL("../../../../threadpath-protocol/fixtures/conversation-thread.jsonl", import.meta.url));

function asObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error("fixture message must be a JSON object");
  return value;
}

async function readFixtureThread(): Promise<Thread> {
  const lines = (await readFile(fixturePath, "utf8")).split(/\r?\n/).filter((line) => line.trim() !== "");
  const message = asObject(JSON.parse(lines[1] ?? "null") as unknown);
  const thread = getThread(message.result);
  if (thread === undefined) throw new Error("conversation fixture did not contain a thread");
  return thread;
}

async function main(): Promise<void> {
  const fixtureThread = await readFixtureThread();
  const client: ThreadClient = {
    listThreads: async () => [],
    readThread: async () => fixtureThread,
  };
  const provider: ThreadClientProvider = { getReadyClient: () => client };
  const service = new ConversationService(provider);
  const view = await service.readThread("thread-conversation");

  assert.equal(view.title, "Fixture conversation");
  assert.equal(view.turns.length, 2);
  assert.deepEqual(view.turns[0], {
    id: "turn-1",
    index: 1,
    status: "completed",
    createdAt: "2026-01-02T03:04:05Z",
    items: [
      { kind: "text", id: "item-user", role: "user", text: "Please inspect this project." },
      { kind: "text", id: "item-assistant", role: "assistant", text: "I will inspect the project." },
      { kind: "tool", id: "item-tool", name: "shell", status: "completed", summary: "Listed project files." },
      { kind: "text", id: "item-system", role: "system", text: "Turn completed." },
      { kind: "status", id: "item-unknown", text: "Unsupported item type: futureitem" },
      { kind: "text", id: "turn-1:item-6", role: "assistant", text: "(No text provided)" },
    ],
  });
  assert.deepEqual(view.turns[1]?.items, [
    { kind: "text", id: "item-user-2", role: "user", text: "What did you find?" },
    { kind: "text", id: "item-assistant-2", role: "assistant", text: "The project contains a protocol package." },
  ]);
  assert.deepEqual(toConversationThreadView({ id: "empty", turns: [] }), { id: "empty", title: "Untitled thread", status: "unknown", turns: [] });

  await assert.rejects(service.readThread(" invalid-id"), (error: unknown) => error instanceof Error && error.name === "ConfigurationError");
  const failingProvider: ThreadClientProvider = { getReadyClient: () => ({ ...client, readThread: async () => { throw new ProtocolError("fixture read failed"); } }) };
  await assert.rejects(new ConversationService(failingProvider).readThread("thread-conversation"), ProtocolError);
  console.log("[desktop-test] conversation service checks passed");
}

main().catch((error: unknown) => {
  console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
