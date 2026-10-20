import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getThread, getTurnPage, isJsonObject, type JsonObject, type Thread, type Turn, type TurnPage } from "../../../../threadpath-protocol/src/protocol.ts";
import { ConversationService, type ConversationClient, type ConversationClientProvider, type TurnCollectionOrder } from "./conversation-service.ts";
import { searchLoadedTurns } from "./search-service.ts";
import { locateBranchPoint } from "../renderer/branch-navigation.ts";

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
    interruptTurn: async () => undefined,
    onNotification: () => () => undefined,
  };
  return { getReadyClient: () => client };
}

async function main(): Promise<void> {
  await verifyPendingNotLoadedPagination();
  await verifyPendingInputBoundaries();
  await verifySnapshotRegressions();
  await verifyHistoryCompleteness();
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
    interruptTurn: async () => undefined,
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
    interruptTurn: async () => undefined,
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

async function verifyPendingNotLoadedPagination(): Promise<void> {
  const text = "pending input survives unloaded history";
  let echo = false;
  const client: ConversationClient = {
    ...providerFor([]).getReadyClient(),
    startTurn: async () => ({ id: "pending-turn" }),
    readThread: async (id) => ({ id, historyMode: "paginated", turns: [{ id: "pending-turn", status: "completed", itemsView: echo ? "full" : "notLoaded", items: echo ? [{ id: "server-user", type: "userMessage", text }] : [] }] }),
    listTurns: async (_id, options) => options?.cursor === undefined ? { turns: [], nextCursor: "older" }
      : { turns: [{ id: "older-turn", status: "completed", itemsView: "full", items: [] }] },
  };
  const service = new ConversationService({ getReadyClient: () => client });
  const users = (thread: NonNullable<ReturnType<ConversationService["getLoadedThread"]>>) => thread.turns.find((turn) => turn.id === "pending-turn")?.items.filter((item) => item.kind === "text" && item.role === "user").map((item) => item.id);
  const sequence: { step: string; pending: number; local: number; server: number; visible: number }[] = [];
  const check = (step: string, thread: NonNullable<ReturnType<ConversationService["getLoadedThread"]>>, confirmed = false) => {
    const ids = users(thread) ?? [];
    const pending = Reflect.get(service, "pendingLocalInputs") as ReadonlyMap<string, ReadonlyMap<string, string>>;
    const row = { step, pending: pending.get("thread-page")?.size ?? 0, local: ids.filter((id) => id === "pending-turn:user").length, server: ids.filter((id) => id === "server-user").length, visible: ids.length };
    assert.deepEqual(row, { step, pending: confirmed ? 0 : 1, local: confirmed ? 0 : 1, server: confirmed ? 1 : 0, visible: 1 });
    sequence.push(row);
  };
  await service.startTurn("thread-page", text);
  assert.deepEqual(users(service.getLoadedThread("thread-page")!), ["pending-turn:user"], "T0: one local input");
  check("T0", service.getLoadedThread("thread-page")!);
  const unloaded = await service.readThread("thread-page");
  assert.deepEqual(users(unloaded), ["pending-turn:user"], "T1: notLoaded preserves input");
  check("T1", unloaded);
  const paged = await service.loadMoreTurns("thread-page");
  assert.deepEqual(users(paged), ["pending-turn:user"], "T2: unrelated pagination preserves input");
  check("T2", paged);
  echo = true;
  await service.readThread("other-thread");
  check("other thread cannot acknowledge this input", service.getLoadedThread("thread-page")!);
  const echoed = await service.readThread("thread-page");
  assert.deepEqual(users(echoed), ["server-user"], "T3: real echo replaces the local input");
  check("T3", echoed, true);
  assert.deepEqual(users(await service.readThread("thread-page")), ["server-user"], "T4: reread cannot resurrect local input");
  const rereadPage = await service.loadMoreTurns("thread-page");
  assert.deepEqual(users(rereadPage), ["server-user"], "T4: pagination preserves confirmed input");
  check("T4", rereadPage, true);
  console.log(`[pending-sequence] ${JSON.stringify(sequence)}`);
  service.close();
}

async function verifyPendingInputBoundaries(): Promise<void> {
  const text = "same synthetic input";
  const base = providerFor([]).getReadyClient();
  const pendingCount = (service: ConversationService) => (Reflect.get(service, "pendingLocalInputs") as ReadonlyMap<string, ReadonlyMap<string, string>>).get("thread-page")?.size ?? 0;
  const userIds = (service: ConversationService) => service.getLoadedThread("thread-page")?.turns.find((turn) => turn.id === "pending-turn")?.items.filter((item) => item.kind === "text" && item.role === "user").map((item) => item.id);
  const full: Turn = { id: "pending-turn", status: "completed", itemsView: "full", items: [{ id: "server-user", type: "userMessage", text }] };
  const unloaded: Turn = { id: "pending-turn", status: "completed", itemsView: "notLoaded", items: [] };
  for (const delayed of ["read", "page"] as const) {
    let hold = false;
    let resolveRead: ((thread: Thread) => void) | undefined;
    let resolvePage: ((page: TurnPage) => void) | undefined;
    const service = new ConversationService({ getReadyClient: () => ({ ...base,
      startTurn: async () => ({ id: full.id }),
      readThread: async (id) => hold && delayed === "read" ? new Promise<Thread>((resolve) => { resolveRead = resolve; }) : ({ id, turns: [hold ? full : unloaded] }),
      listTurns: async (_id, options) => hold && delayed === "page" && options?.cursor !== undefined ? new Promise<TurnPage>((resolve) => { resolvePage = resolve; }) : { turns: hold && delayed === "read" ? [full] : [], nextCursor: "older" },
    }) });
    await service.startTurn("thread-page", text);
    await service.readThread("thread-page");
    hold = true;
    const old = delayed === "read" ? service.readThread("thread-page") : service.loadMoreTurns("thread-page");
    const rejected = assert.rejects(old, /superseded/);
    if (delayed === "read") await service.loadMoreTurns("thread-page");
    else await service.readThread("thread-page");
    assert.deepEqual(userIds(service), ["server-user"]);
    assert.equal(pendingCount(service), 0);
    resolveRead?.({ id: "thread-page", turns: [unloaded] });
    resolvePage?.({ turns: [unloaded] });
    await rejected;
    assert.deepEqual(userIds(service), ["server-user"], "late unloaded data cannot undo a confirmed echo");
    assert.equal(pendingCount(service), 0);
    service.close();
  }

  let resolveMain: ((thread: Thread) => void) | undefined;
  const concurrent = new ConversationService({ getReadyClient: () => ({ ...base,
    startTurn: async () => ({ id: full.id }),
    readThread: async (id) => id === "thread-page" ? new Promise<Thread>((resolve) => { resolveMain = resolve; }) : { id, turns: [full] },
    listTurns: async () => ({ turns: [] }),
  }) });
  await concurrent.startTurn("thread-page", text);
  const mainRead = concurrent.readThread("thread-page");
  await concurrent.readThread("other-thread");
  assert.equal(pendingCount(concurrent), 1, "same turn/text from a different thread is not an echo");
  resolveMain?.({ id: "thread-page", turns: [unloaded] });
  await mainRead;
  assert.deepEqual(userIds(concurrent), ["pending-turn:user"]);
  concurrent.close();

  let snapshot: Turn = { ...full, items: [{ id: "reply", type: "agentMessage", text: "old full body" }] };
  let unrelatedEcho = false;
  const mixed = new ConversationService({ getReadyClient: () => ({ ...base,
    startTurn: async () => ({ id: full.id }),
    readThread: async (id) => ({ id, turns: [snapshot, ...(unrelatedEcho ? [{ ...full, id: "other-turn" }] : [])] }),
    listTurns: async () => ({ turns: [], nextCursor: "older" }),
  }) });
  await mixed.startTurn("thread-page", text);
  await mixed.readThread("thread-page");
  snapshot = { ...snapshot, items: [{ id: "reply", type: "agentMessage", text: "new" }] };
  unrelatedEcho = true;
  let result = await mixed.readThread("thread-page");
  assert.deepEqual(userIds(mixed), ["pending-turn:user"]);
  assert.equal(pendingCount(mixed), 1, "a different turn cannot confirm equal text");
  const reply = result.turns[0]?.items.find((item) => item.id === "reply");
  assert.equal(reply?.kind === "text" ? reply.text : undefined, "new");
  snapshot = { ...snapshot, itemsView: "summary", items: [{ id: "reply", type: "agentMessage", text: "summary" }, { id: "new-item", type: "agentMessage", text: "new summary item" }] };
  result = await mixed.readThread("thread-page");
  assert.deepEqual(userIds(mixed), ["pending-turn:user"]);
  const protectedReply = result.turns[0]?.items.find((item) => item.id === "reply");
  assert.equal(protectedReply?.kind === "text" ? protectedReply.text : undefined, "new");
  assert.ok(result.turns[0]?.items.some((item) => item.id === "new-item"));
  snapshot = { ...full, items: [] };
  result = await mixed.readThread("thread-page");
  assert.deepEqual(userIds(mixed), ["pending-turn:user"], "even an empty replacement full body must preserve accepted input");
  assert.equal(result.turns[0]?.items.some((item) => item.id === "reply" || item.id === "new-item"), false);
  snapshot = { ...full, items: [{ type: "userMessage", text }] };
  await mixed.readThread("thread-page");
  assert.equal(pendingCount(mixed), 1, "a user without a stable server ID cannot acknowledge input");
  assert.equal(userIds(mixed)?.length, 2, "unidentifiable server content must remain visible alongside pending input");
  snapshot = { ...full, items: [{ id: "server-user", type: "userMessage", text }, { id: "second-user", type: "userMessage", text }] };
  await mixed.readThread("thread-page");
  assert.deepEqual(userIds(mixed), ["server-user", "second-user"], "equal text does not merge different server identities");
  assert.equal(pendingCount(mixed), 0);
  mixed.close();
}

async function verifySnapshotRegressions(): Promise<void> {
  const base = providerFor([]).getReadyClient();
  const text = "identical synthetic input";
  let echo = false;
  let body = "old full body that is longer than the updated body";
  let snapshotItems: Turn["items"];
  let view: Turn["itemsView"] = "full";
  const client: ConversationClient = { ...base,
    startTurn: async () => ({ id: "accepted-turn" }),
    readThread: async (id) => ({ id, historyMode: "paginated", turns: [{ id: "accepted-turn", status: "completed", itemsView: view, items: snapshotItems ?? [...(echo ? [{ id: "server-user", type: "userMessage", text }, { id: "second-server-user", type: "userMessage", text }] : []), { id: "reply", type: "agentMessage", text: body }] }] }),
    listTurns: async () => ({ turns: [] }),
  };
  const service = new ConversationService({ getReadyClient: () => client });
  await service.startTurn("thread-page", text);
  const userIds = (thread: Awaited<ReturnType<ConversationService["readThread"]>>) => thread.turns[0]!.items.filter((item) => item.kind === "text" && item.role === "user").map((item) => item.id);
  const textOf = (thread: Awaited<ReturnType<ConversationService["readThread"]>>, id: string) => { const item = thread.turns[0]?.items.find((candidate) => candidate.id === id); return item?.kind === "text" ? item.text : undefined; };
  assert.deepEqual(userIds(await service.readThread("thread-page")), ["accepted-turn:user"]);
  await service.readThread("other-thread");
  assert.deepEqual(userIds(await service.readThread("thread-page")), ["accepted-turn:user"]);
  echo = true;
  assert.deepEqual(userIds(await service.readThread("thread-page")), ["server-user", "second-server-user"], "only raw server data confirms echo; equal text does not merge different IDs");
  body = "new";
  let result = await service.readThread("thread-page");
  assert.equal(textOf(result, "reply"), "new");
  body = "";
  result = await service.readThread("thread-page");
  assert.equal(textOf(result, "reply"), "");
  snapshotItems = [];
  assert.deepEqual((await service.readThread("thread-page")).turns[0]?.items, []);
  snapshotItems = [{ id: "a", type: "agentMessage", text: "full A" }];
  await service.readThread("thread-page");
  view = "summary";
  snapshotItems = [{ id: "a", type: "agentMessage", text: "summary A" }, { id: "b", type: "agentMessage", text: "summary B" }];
  result = await service.readThread("thread-page");
  assert.deepEqual(result.turns[0]?.items.filter((item) => item.kind === "text").map((item) => item.text), ["full A", "summary B"]);
  snapshotItems = [{ id: "a", type: "agentMessage", text: "another summary" }, { id: "b", type: "agentMessage", text: "new summary B" }];
  result = await service.readThread("thread-page");
  assert.equal(textOf(result, "a"), "full A", "mixed completeness must retain per-item full evidence");

  let resolveOld: ((thread: Thread) => void) | undefined;
  let calls = 0;
  const ordered = new ConversationService({ getReadyClient: () => ({ ...base,
    readThread: async (id) => ++calls === 1 ? new Promise<Thread>((resolve) => { resolveOld = resolve; }) : ({ id, turns: [{ id: "ordered", status: "completed", itemsView: "full", items: [{ id: "body", type: "agentMessage", text: "new response" }] }] }),
    listTurns: async () => ({ turns: [] }),
  }) });
  const old = ordered.readThread("thread-page");
  const rejectedOld = assert.rejects(old, /superseded/);
  const newest = await ordered.readThread("thread-page");
  resolveOld?.({ id: "thread-page", turns: [{ id: "ordered", status: "completed", itemsView: "full", items: [{ id: "body", type: "agentMessage", text: "stale response" }] }] });
  await rejectedOld;
  assert.deepEqual(ordered.getLoadedThread("thread-page"), newest);

  let resolvePage: ((page: TurnPage) => void) | undefined;
  let pageBody = "initial";
  const paged = new ConversationService({ getReadyClient: () => ({ ...base,
    readThread: async (id) => ({ id, historyMode: "paginated", turns: [{ id: "page-turn", status: "completed", itemsView: "full", items: [{ id: "page-body", type: "agentMessage", text: pageBody }] }] }),
    listTurns: async (_id, options) => options?.cursor === undefined ? { turns: [], nextCursor: "older" } : new Promise<TurnPage>((resolve) => { resolvePage = resolve; }),
  }) });
  await paged.readThread("thread-page");
  const page = paged.loadMoreTurns("thread-page");
  const rejectedPage = assert.rejects(page, /superseded/);
  pageBody = "fresh";
  const freshPage = await paged.readThread("thread-page");
  resolvePage?.({ turns: [{ id: "page-turn", status: "completed", itemsView: "full", items: [{ id: "page-body", type: "agentMessage", text: "old page" }] }] });
  await rejectedPage;
  assert.deepEqual(paged.getLoadedThread("thread-page"), freshPage, "a stale page cannot restore old content, cursor, loading or error state");

  let echoPage = 0;
  const pagedEcho = new ConversationService({ getReadyClient: () => ({ ...base,
    startTurn: async () => ({ id: "pending-page" }),
    readThread: async (id) => ({ id, turns: [] }),
    listTurns: async () => ({ turns: [{ id: "pending-page", status: "completed", itemsView: "full", items: ++echoPage < 3 ? [] : [{ id: "real-page-user", type: "userMessage", text }] }], nextCursor: `page-${echoPage}` }),
  }) });
  await pagedEcho.startTurn("thread-page", text);
  assert.deepEqual(userIds(await pagedEcho.readThread("thread-page")), ["pending-page:user"]);
  assert.deepEqual(userIds(await pagedEcho.loadMoreTurns("thread-page")), ["pending-page:user"]);
  assert.deepEqual(userIds(await pagedEcho.loadMoreTurns("thread-page")), ["real-page-user"]);

  let repeatedInputTurn = 0;
  let repeatedEcho = false;
  let terminal: ((event: { method: string; params: JsonObject }) => void) | undefined;
  const repeated = new ConversationService({ getReadyClient: () => ({ ...base,
    startTurn: async () => ({ id: `repeat-${++repeatedInputTurn}` }),
    readThread: async (id) => ({ id, turns: [1, ...(repeatedEcho ? [2] : [])].map((index) => ({ id: `repeat-${index}`, status: "completed", itemsView: "full", items: [{ id: `server-${index}`, type: "userMessage", text }] })) }),
    listTurns: async () => ({ turns: [] }),
    onNotification: (listener) => { terminal = listener; return () => undefined; },
  }) });
  await repeated.startTurn("thread-page", text);
  await repeated.readThread("thread-page");
  terminal?.({ method: "turn/completed", params: { threadId: "thread-page", turn: { id: "repeat-1", status: "completed" } } });
  await repeated.startTurn("thread-page", text);
  let repeatedResult = await repeated.readThread("thread-page");
  assert.ok(repeatedResult.turns.find((turn) => turn.id === "repeat-2")?.items.some((item) => item.id === "repeat-2:user"), "an equal-text message in a different turn cannot confirm this input");
  repeatedEcho = true;
  repeatedResult = await repeated.readThread("thread-page");
  assert.deepEqual(repeatedResult.turns.flatMap((turn) => turn.items.filter((item) => item.kind === "text" && item.role === "user").map((item) => item.id)), ["server-1", "server-2"]);
}

async function verifyHistoryCompleteness(): Promise<void> {
  const full: Turn = { id: "body-turn", status: "completed", itemsView: "full", items: [{ id: "body", type: "agentMessage", text: "Full" }] };
  const summary: Turn = { ...full, itemsView: "summary", items: [{ id: "body", type: "agentMessage", text: "A much longer synthetic summary must not replace the full body" }, { id: "summary-only", type: "agentMessage", text: "Summary only" }] };
  const unloaded: Turn = { id: "unloaded-turn", status: "completed", itemsView: "notLoaded", items: [] };
  const empty: Turn = { id: "empty-turn", status: "completed", itemsView: "full", items: [] };
  const legacy: Turn = getThread({ thread: { id: "legacy", turns: [{ id: "legacy-turn", items: [] }] } })!.turns![0]!;
  const base = providerFor([]).getReadyClient();
  let reads = 0;
  let pageCalls = 0;
  let resumes = 0;
  let returnedBody = summary;
  const client: ConversationClient = {
    ...base,
    readThread: async (id) => {
      reads++;
      return id === "other-thread" ? { id, turns: [] } : reads === 1
        ? { id, historyMode: "paginated", turns: [summary, unloaded, empty, legacy] }
        : { id, historyMode: "paginated", turns: [] };
    },
    listTurns: async (id, options) => {
      pageCalls++;
      if (id === "other-thread") return { turns: [] };
      if (options?.cursor !== undefined) return { turns: [summary, { ...full, id: "older-full" }], nextCursor: "next-older" };
      return reads === 1 ? { turns: [full], nextCursor: "older" }
        : { turns: [returnedBody, unloaded, empty, legacy], nextCursor: "older" };
    },
    resumeThread: async (id) => { resumes++; return { id }; },
  };
  const service = new ConversationService({ getReadyClient: () => client });
  const initial = await service.readThread("thread-page");
  const body = initial.turns.find((turn) => turn.id === full.id)!;
  assert.equal(body.itemsView, "full", "summary -> full upgrades completeness");
  assert.deepEqual(body.items.map((item) => item.id), ["body"], "summary-only items must not survive a full snapshot");
  assert.equal(body.items[0]?.kind === "text" ? body.items[0].text : undefined, "Full", "a longer summary is not a richer body");
  assert.equal(initial.turns.find((turn) => turn.id === unloaded.id)?.itemsView, "notLoaded");
  assert.equal(initial.turns.find((turn) => turn.id === empty.id)?.itemsView, "full");
  assert.deepEqual(initial.turns.find((turn) => turn.id === empty.id)?.items, []);
  assert.equal(initial.turns.find((turn) => turn.id === legacy.id)?.itemsView, undefined);
  const overlap = await service.loadMoreTurns("thread-page");
  assert.equal(overlap.turns.filter((turn) => turn.id === full.id).length, 1);
  assert.deepEqual(overlap.turns.find((turn) => turn.id === full.id)?.items.find((item) => item.id === "body"), body.items[0], "full -> summary overlap preserves the same item's complete text");
  assert.ok(overlap.turns.find((turn) => turn.id === full.id)?.items.some((item) => item.id === "summary-only"), "new summary item IDs remain visible");
  assert.equal(overlap.paging.firstItemIndex, initial.paging.firstItemIndex - 1, "only a new stable turn changes the virtual list offset");
  await service.readThread("other-thread");
  const returned = await service.readThread("thread-page");
  assert.equal(returned.turns.find((turn) => turn.id === full.id)?.itemsView, "summary", "a new summarized item makes the turn mixed, while full items stay protected");
  assert.deepEqual(returned.turns.find((turn) => turn.id === full.id)?.items.find((item) => item.id === "body"), body.items[0], "switching history must not replace cached full content with a summary");
  assert.ok(returned.turns.some((turn) => turn.id === "older-full"), "metadata-only paginated reads retain loaded older turns");
  const located = await locateBranchPoint(returned, full.id, async () => { throw new Error("already loaded"); }, () => true);
  assert.equal(located.outcome, "found");
  assert.deepEqual(located.thread.turns.find((turn) => turn.id === full.id)?.items.find((item) => item.id === "body"), body.items[0]);
  returnedBody = { ...full, itemsView: "notLoaded", items: [] };
  const unloadedRefresh = await service.readThread("thread-page");
  assert.equal(unloadedRefresh.turns.find((turn) => turn.id === full.id)?.itemsView, "summary");
  assert.deepEqual(unloadedRefresh.turns.find((turn) => turn.id === full.id)?.items.find((item) => item.id === "body"), body.items[0]);
  assert.equal(resumes, 0);
  assert.equal(pageCalls, 5, "reads and overlap use only the existing page requests");

  const emptyUpgrade = new ConversationService({ getReadyClient: () => ({ ...base,
    readThread: async () => ({ id: "thread-page", turns: [summary] }),
    listTurns: async () => ({ turns: [{ ...full, items: [] }] }),
  }) });
  assert.deepEqual((await emptyUpgrade.readThread("thread-page")).turns[0]?.items, [], "a genuinely empty full snapshot is distinct from notLoaded");
  const legacyUpgrade = new ConversationService({ getReadyClient: () => ({ ...base,
    readThread: async () => ({ id: "thread-page", turns: [{ ...summary, itemsView: undefined }] }),
    listTurns: async () => ({ turns: [full] }),
  }) });
  const upgradedLegacy = (await legacyUpgrade.readThread("thread-page")).turns[0];
  assert.deepEqual(upgradedLegacy?.items.map((item) => item.id), ["body"]);
  assert.equal(upgradedLegacy?.items[0]?.kind === "text" ? upgradedLegacy.items[0].text : undefined, "Full");

  const acceptedInput = new ConversationService({ getReadyClient: () => ({ ...base,
    startTurn: async () => ({ id: full.id }),
    readThread: async () => ({ id: "thread-page", turns: [{ ...full, status: "inProgress" }] }),
    listTurns: async () => ({ turns: [{ ...full, status: "inProgress" }] }),
  }) });
  await acceptedInput.startTurn("thread-page", "accepted input awaiting history echo");
  const pendingFull = (await acceptedInput.readThread("thread-page")).turns[0];
  assert.equal(pendingFull?.itemsView, "full");
  assert.ok(pendingFull?.items.some((item) => item.kind === "text" && item.role === "user" && item.text === "accepted input awaiting history echo"));
}

main().catch((error: unknown) => {
  console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
