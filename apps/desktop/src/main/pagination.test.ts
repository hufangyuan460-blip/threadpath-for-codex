import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getTurnPage, isJsonObject, type JsonObject, type Thread, type TurnPage } from "../../../../threadpath-protocol/src/protocol.ts";
import { ConversationService, type ConversationClient, type ConversationClientProvider } from "./conversation-service.ts";
import { searchLoadedTurns } from "./search-service.ts";

const fixturePath = fileURLToPath(new URL("../../../../threadpath-protocol/fixtures/turns-list-pages.jsonl", import.meta.url));

function asObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error("fixture message must be an object");
  return value;
}

async function fixturePages(): Promise<TurnPage[]> {
  const lines = (await readFile(fixturePath, "utf8")).split(/\r?\n/).filter((line) => line.trim() !== "");
  return [1, 3, 5, 7].map((index) => getTurnPage(asObject(JSON.parse(lines[index] ?? "null") as unknown).result));
}

function providerFor(pages: TurnPage[], failOnce = false): ConversationClientProvider {
  let pageIndex = 0;
  let failed = false;
  const client: ConversationClient = {
    listThreads: async () => [],
    readThread: async (): Promise<Thread> => ({ id: "thread-page", title: "Paged fixture", status: "active" }),
    listTurns: async () => {
      if (failOnce && pageIndex === 1 && !failed) {
        failed = true;
        throw new Error("fixture page failed");
      }
      return pages[Math.min(pageIndex++, pages.length - 1)] ?? { turns: [] };
    },
    startTurn: async () => ({ id: "turn-live" }),
    onNotification: () => () => undefined,
  };
  return { getReadyClient: () => client };
}

async function main(): Promise<void> {
  const pages = await fixturePages();
  const service = new ConversationService(providerFor(pages));
  const initial = await service.readThread("thread-page");
  assert.deepEqual(initial.paging.orderedTurnIds, ["turn-2", "turn-3"]);
  assert.equal(initial.paging.nextCursor, "cursor-older");
  assert.equal(initial.paging.hasMore, true);
  assert.equal(initial.outline[0]?.label, "Middle turn");

  const withOlder = await service.loadMoreTurns("thread-page");
  assert.deepEqual(withOlder.paging.orderedTurnIds, ["turn-1", "turn-2", "turn-3"]);
  assert.equal(withOlder.turns[1]?.items.length, 2);
  assert.equal(withOlder.outline[0]?.label, "Old turn");
  assert.equal(searchLoadedTurns(withOlder, "Old turn")[0]?.turnId, "turn-1");

  const afterEmpty = await service.loadMoreTurns("thread-page");
  assert.equal(afterEmpty.turns.length, 3);
  assert.equal(afterEmpty.paging.hasMore, true);
  const exhausted = await service.loadMoreTurns("thread-page");
  assert.equal(exhausted.paging.hasMore, false);
  assert.deepEqual(exhausted.paging.orderedTurnIds, ["turn-1", "turn-2", "turn-3"]);

  const duplicateService = new ConversationService(providerFor([pages[0]!, pages[1]!, pages[1]!], false));
  await duplicateService.readThread("thread-page");
  await duplicateService.loadMoreTurns("thread-page");
  const duplicatePage = await duplicateService.loadMoreTurns("thread-page");
  assert.equal(duplicatePage.turns.length, 3);
  assert.equal(duplicatePage.paging.hasMore, false);

  const retryService = new ConversationService(providerFor(pages, true));
  await retryService.readThread("thread-page");
  await assert.rejects(retryService.loadMoreTurns("thread-page"), /fixture page failed/);
  const retryState = await retryService.loadMoreTurns("thread-page");
  assert.equal(retryState.paging.loadMoreError, undefined);
  assert.equal(retryState.turns.length, 3);

  await assert.rejects(service.loadMoreTurns(" invalid-id"), (error: unknown) => error instanceof Error && error.name === "ConfigurationError");
  console.log("[desktop-test] pagination checks passed");
}

main().catch((error: unknown) => {
  console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
