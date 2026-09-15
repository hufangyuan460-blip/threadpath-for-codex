import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getTurnPage, isJsonObject, type JsonObject, type Thread, type TurnPage } from "../../../../threadpath-protocol/src/protocol.ts";
import { ConversationService, type ConversationClient, type ConversationClientProvider, type TurnCollectionOrder } from "./conversation-service.ts";
import { searchLoadedTurns } from "./search-service.ts";

const fixturePath = fileURLToPath(new URL("../../../../threadpath-protocol/fixtures/turns-list-pages.jsonl", import.meta.url));
const oldestFirstFixturePath = fileURLToPath(new URL("../../../../threadpath-protocol/fixtures/turns-list-oldest-first.jsonl", import.meta.url));

function asObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error("fixture message must be an object");
  return value;
}

async function fixturePages(): Promise<TurnPage[]> {
  return readFixturePages(fixturePath, [1, 3, 5, 7]);
}

async function readFixturePages(path: string, indexes: readonly number[]): Promise<TurnPage[]> {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter((line) => line.trim() !== "");
  return indexes.map((index) => getTurnPage(asObject(JSON.parse(lines[index] ?? "null") as unknown).result));
}

function providerFor(pages: TurnPage[], failOnce = false, turnPageOrder: TurnCollectionOrder = "newest-first"): ConversationClientProvider {
  let pageIndex = 0;
  let failed = false;
  const client: ConversationClient = {
    turnPageOrder,
    listThreads: async () => [],
    readThread: async (): Promise<Thread> => ({ id: "thread-page", title: "Paged fixture", status: "active" }),
    startThread: async (): Promise<Thread> => ({ id: "thread-new" }),
    resumeThread: async (): Promise<Thread> => ({ id: "thread-page" }),
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

  const unorientedPages: TurnPage[] = [
    { turns: [{ id: "turn-newest" }, { id: "turn-middle" }], nextCursor: "cursor-no-time-older" },
    { turns: [{ id: "turn-middle" }, { id: "turn-oldest" }] },
  ];
  const unorientedService = new ConversationService(providerFor(unorientedPages));
  const noTimestampInitial = await unorientedService.readThread("thread-page");
  assert.deepEqual(noTimestampInitial.paging.orderedTurnIds, ["turn-middle", "turn-newest"]);
  const noTimestampOlder = await unorientedService.loadMoreTurns("thread-page");
  assert.deepEqual(noTimestampOlder.paging.orderedTurnIds, ["turn-oldest", "turn-middle", "turn-newest"]);
  assert.equal(noTimestampOlder.paging.firstItemIndex, 999999);

  const sameTimestampService = new ConversationService(providerFor([{ turns: [{ id: "turn-invalid-new", createdAt: "not-a-date" }, { id: "turn-invalid-old", createdAt: "not-a-date" }] }]));
  const sameTimestamp = await sameTimestampService.readThread("thread-page");
  assert.deepEqual(sameTimestamp.paging.orderedTurnIds, ["turn-invalid-old", "turn-invalid-new"]);

  const oldestFirstPages = await readFixturePages(oldestFirstFixturePath, [1]);
  const oldestFirstService = new ConversationService(providerFor(oldestFirstPages, false, "oldest-first"));
  const oldestFirst = await oldestFirstService.readThread("thread-page");
  assert.deepEqual(oldestFirst.paging.orderedTurnIds, ["turn-oldest", "turn-latest"]);

  const overlapClient: ConversationClient = {
    listThreads: async () => [],
    readThread: async () => ({ id: "thread-overlap", turns: [{ id: "turn-middle", items: [{ id: "middle-item", role: "user", text: "From thread/read" }] }] }),
    startThread: async () => ({ id: "thread-overlap" }),
    resumeThread: async () => ({ id: "thread-overlap" }),
    listTurns: async () => ({ turns: [{ id: "turn-new", items: [{ id: "new-item", role: "assistant", text: "Newest page" }] }, { id: "turn-middle", items: [{ id: "middle-item", role: "user", text: "From thread/turns/list with newer context" }] }] }),
    startTurn: async () => ({ id: "turn-live" }),
    onNotification: () => () => undefined,
  };
  const overlap = await new ConversationService({ getReadyClient: () => overlapClient }).readThread("thread-overlap");
  assert.deepEqual(overlap.paging.orderedTurnIds, ["turn-middle", "turn-new"]);
  assert.equal(overlap.turns[0]?.items[0]?.kind === "text" ? overlap.turns[0].items[0].text : undefined, "From thread/turns/list with newer context");

  let refreshPage = 0;
  const refreshClient: ConversationClient = {
    listThreads: async () => [],
    readThread: async () => ({ id: "thread-refresh", title: "Refresh fixture" }),
    startThread: async () => ({ id: "thread-refresh" }),
    resumeThread: async () => ({ id: "thread-refresh" }),
    listTurns: async (_threadId, options) => {
      if (options?.cursor !== undefined) return refreshPage++ === 0
        ? { turns: [{ id: "turn-old", items: [{ id: "old-item", role: "user", text: "Old" }] }, { id: "turn-middle", items: [{ id: "middle-item", role: "user", text: "Middle with history" }] }] }
        : { turns: [] };
      return { turns: [{ id: "turn-new", items: [{ id: "new-item", role: "assistant", text: "Newest refreshed" }] }, { id: "turn-middle", items: [{ id: "middle-item", role: "user", text: "Middle refreshed" }] }], nextCursor: "cursor-refresh-older" };
    },
    startTurn: async () => ({ id: "turn-live" }),
    onNotification: () => () => undefined,
  };
  const refreshConversation = new ConversationService({ getReadyClient: () => refreshClient });
  await refreshConversation.readThread("thread-refresh");
  const cachedRefresh = await refreshConversation.loadMoreTurns("thread-refresh");
  assert.deepEqual(cachedRefresh.paging.orderedTurnIds, ["turn-old", "turn-middle", "turn-new"]);
  const refreshed = await refreshConversation.readThread("thread-refresh");
  assert.deepEqual(refreshed.paging.orderedTurnIds, ["turn-old", "turn-middle", "turn-new"]);
  assert.equal(refreshed.turns[1]?.items[0]?.kind === "text" ? refreshed.turns[1].items[0].text : undefined, "Middle refreshed");

  await assert.rejects(service.loadMoreTurns(" invalid-id"), (error: unknown) => error instanceof Error && error.name === "ConfigurationError");
  console.log("[desktop-test] pagination checks passed");
}

main().catch((error: unknown) => {
  console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
