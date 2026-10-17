import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservatoryService } from "./observatory-service.ts";
import { ConversationService, type ConversationClient } from "./conversation-service.ts";
import { ProtocolError, type JsonObject, type Turn } from "../../../../threadpath-protocol/src/protocol.ts";
import { UserPreferencesService } from "./user-preferences.ts";

const breakdown = (total: number): JsonObject => ({ totalTokens: total, inputTokens: 500, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 20 });
const event = (threadId = "thread-a", turnId = "turn-a", total = 600): JsonObject => ({ threadId, turnId, tokenUsage: { total: breakdown(total), last: breakdown(60), modelContextWindow: 475000 } });
const store = new ObservatoryService();
assert.equal(store.get("thread-a").usage, null);
store.observeNotification("thread/tokenUsage/updated", event());
const first = store.get("thread-a");
assert.equal(first.usage?.total.totalTokens, 600);
store.observeNotification("thread/tokenUsage/updated", event());
assert.equal(store.get("thread-a"), first, "duplicate is idempotent including receivedAt");
store.observeNotification("thread/tokenUsage/updated", event("thread-a", "turn-b", 900));
assert.equal(store.get("thread-a").usage?.total.totalTokens, 900, "absolute replacement, never 1500");
store.beginResume("thread-a");
store.completeResume("thread-a");
store.observeNotification("thread/tokenUsage/updated", event("thread-a", "turn-b", 900));
assert.equal(store.get("thread-a").usage?.source, "resumed");
assert.equal(store.get("thread-a").usage?.total.totalTokens, 900);
store.observeNotification("thread/tokenUsage/updated", event("thread-b", "turn-b", 1200));
assert.equal(store.get("thread-b").usage?.total.totalTokens, 1200);
assert.equal(store.get("thread-a").usage?.total.totalTokens, 900);
store.disconnected();
assert.equal(store.get("thread-a").usage?.stale, true);
assert.equal(store.get("thread-b").usage?.stale, true);
store.beginResume("thread-a");
store.completeResume("thread-a");
store.observeNotification("thread/tokenUsage/updated", event("thread-a", "turn-b", 900));
assert.equal(store.get("thread-a").usage?.stale, false);
assert.equal(store.get("thread-b").usage?.stale, true);
store.observeNotification("turn/started", { threadId: "thread-a", turn: { id: "new-turn" } });
store.observeNotification("thread/tokenUsage/updated", event("thread-a", "new-turn", 1000));
assert.equal(store.get("thread-a").usage?.source, "live");
store.beginResume("thread-a");
store.completeResume("thread-a");
store.observeNotification("thread/tokenUsage/updated", event("thread-a", "new-turn", 1000));
assert.equal(store.get("thread-a").usage?.source, "resumed", "a previously live turn can be replayed on a later resume");
assert.equal(store.get("thread-a").usage?.total.totalTokens, 1000);
store.observeNotification("thread/tokenUsage/updated", { threadId: "thread-a", tokenUsage: {} });
assert.equal(store.get("thread-a").usage, null);
assert.equal(store.get("thread-a").usageError, "invalid-payload");
assert.equal(store.get("thread-b").usage?.total.totalTokens, 1200);
store.observeNotification("thread/tokenUsage/updated", event());
assert.equal(store.get("thread-a").usageError, undefined);

const params: JsonObject = { threadId: "thread-a", turnId: "turn-a", item: { id: "compact-1", type: "contextCompaction" } };
store.observeNotification("item/started", params);
store.observeNotification("item/started", params);
assert.equal(store.get("thread-a").compactions.length, 1);
assert.equal(store.get("thread-a").compactions[0]?.status, "started");
store.observeNotification("item/completed", params);
store.observeNotification("item/started", params);
store.observeNotification("item/completed", params);
assert.equal(store.get("thread-a").compactions[0]?.status, "completed");
const history: Turn[] = [{ id: "turn-a", status: "completed", items: [{ id: "compact-1", type: "contextCompaction" }, { id: "compact-2", type: "contextCompaction" }] }];
store.observeHistory("thread-a", history);
store.observeHistory("thread-a", history);
assert.equal(store.get("thread-a").compactions.length, 2);
assert.equal(store.get("thread-a").compactions[0]?.status, "completed", "history cannot downgrade observed status");
assert.equal(store.get("thread-a").compactions[1]?.status, "unknown", "ended turn does not prove compaction succeeded");
store.observeNotification("item/started", { ...params, item: { id: "compact-3", type: "contextCompaction" } });
store.disconnected();
assert.equal(store.get("thread-a").compactions[2]?.status, "unknown");
assert.equal(store.get("thread-b").compactions.length, 0);
store.observeNotification("item/started", { ...params, item: { id: "compact-terminal", type: "contextCompaction" } });
store.observeNotification("turn/failed", { threadId: "thread-a", turnId: "turn-a" });
assert.equal(store.get("thread-a").compactions.at(-1)?.status, "unknown", "failed turn does not prove a compaction failure");

// Integration: the existing resume path and notification subscription feed the store.
let notify: (event: { method: string; params: JsonObject }) => void = () => undefined;
const client: ConversationClient = {
  listThreads: async () => [], readThread: async (id) => ({ id, turns: history }), listTurns: async () => ({ turns: history }),
  startThread: async () => ({ id: "new-thread" }), interruptTurn: async () => undefined,
  resumeThread: async (id) => { notify({ method: "thread/tokenUsage/updated", params: event(id) }); return { id, turns: [] }; },
  startTurn: async () => ({ id: "live-turn" }),
  onNotification: (listener) => { notify = listener; return () => { notify = () => undefined; }; },
};
const service = new ConversationService({ getReadyClient: () => client });
service.connectionChanged("ready");
await service.readThread("thread-a");
assert.equal(service.observatory.get("thread-a").usage, null, "reading history does not resume for usage");
assert.equal(service.observatory.get("thread-a").compactions.length, 2);
await service.startTurn("thread-a", "synthetic input");
assert.equal(service.observatory.get("thread-a").usage?.source, "resumed");
notify({ method: "thread/tokenUsage/updated", params: event("thread-a", "live-turn", 700) });
assert.equal(service.observatory.get("thread-a").usage?.source, "live");
service.connectionChanged("stopped");
notify({ method: "thread/tokenUsage/updated", params: event("thread-a", "late", 999) });
assert.equal(service.observatory.get("thread-a").usage?.total.totalTokens, 700, "old connection is unsubscribed");
service.connectionChanged("ready");
assert.equal(service.observatory.get("thread-a").usage?.stale, true, "reconnect alone cannot refresh a snapshot");
notify({ method: "thread/tokenUsage/updated", params: event("thread-b", "other", 50) });
assert.equal(service.observatory.get("thread-a").usage?.stale, true);
service.close();
console.log("[observatory] passed replacement, duplicate, resume, stale, isolation, compaction and conversation integration");

function fixture(overrides: Partial<ConversationClient> = {}): {
  service: ConversationService;
  notify: (method: string, params: JsonObject) => void;
} {
  let listener: (event: { method: string; params: JsonObject }) => void = () => undefined;
  const client: ConversationClient = {
    listThreads: async () => [], readThread: async (id) => ({ id, turns: history }), listTurns: async () => ({ turns: history }),
    startThread: async () => ({ id: "new-thread" }), interruptTurn: async () => undefined,
    resumeThread: async (id) => ({ id, turns: [] }), startTurn: async () => ({ id: "live-turn" }),
    forkThread: async (id) => ({ id: "fork", forkedFromId: id, turns: history }),
    ...overrides,
    onNotification: (next) => { listener = next; return () => { listener = () => undefined; }; },
  };
  const service = new ConversationService({ getReadyClient: () => client });
  service.connectionChanged("ready");
  return { service, notify: (method, params) => listener({ method, params }) };
}

const regressions: readonly [string, () => void | Promise<void>][] = [
  ["listener failure isolation", () => {
    const store = new ObservatoryService();
    const received: number[] = [];
    store.subscribe(() => { throw new Error("synthetic delivery failure"); });
    store.subscribe((state) => received.push(state.revision));
    assert.doesNotThrow(() => store.observeNotification("thread/tokenUsage/updated", event()));
    assert.deepEqual(received, [store.get("thread-a").revision]);
    assert.equal(store.get("thread-a").usageError, undefined, "delivery failure is not malformed payload");
    assert.equal(store.get("thread-a").usage?.total.totalTokens, 600);
    assert.doesNotThrow(() => store.observeNotification("thread/tokenUsage/updated", { threadId: "thread-a", tokenUsage: {} }));
    assert.equal(store.get("thread-a").usage, null);
    assert.equal(store.get("thread-a").usageError, "invalid-payload");
    assert.equal(received.length, 2, "later listeners also receive invalid-payload state");
  }],
  ["failed resume duplicate is unchanged", async () => {
    const { service, notify } = fixture({ resumeThread: async () => { throw new Error("resume rejected"); } });
    notify("thread/tokenUsage/updated", event());
    const before = service.observatory.get("thread-a");
    await assert.rejects(service.startTurn("thread-a", "synthetic input"), /resume rejected/);
    notify("thread/tokenUsage/updated", event());
    const after = service.observatory.get("thread-a");
    assert.equal(after.usage?.source, "live");
    assert.equal(after.revision, before.revision);
    assert.equal(after.usage?.receivedAt, before.usage?.receivedAt);
    assert.equal(after, before);
    service.close();
  }],
  ["observed compaction survives reread and route switch", async () => {
    const { service, notify } = fixture();
    await service.readThread("thread-a");
    notify("item/completed", params);
    assert.equal(service.getLoadedThread("thread-a")?.turns[0]?.items[0]?.kind, "compaction");
    const reread = await service.readThread("thread-a");
    assert.deepEqual(reread.turns[0]?.items[0], { kind: "compaction", id: "compact-1", status: "completed" });
    assert.equal(service.observatory.get("thread-a").compactions.find((item) => item.itemId === "compact-1")?.status, "completed");
    await service.readThread("thread-b");
    const returned = await service.readThread("thread-a");
    assert.deepEqual(returned.turns[0]?.items[0], { kind: "compaction", id: "compact-1", status: "completed" });
    assert.deepEqual(returned.turns[0]?.items[1], { kind: "compaction", id: "compact-2", status: "unknown" });
    service.close();
  }],
  ["fork delivery failure still reaches real branch metadata persistence", async () => {
    let forkRpcSucceeded = false;
    const { service } = fixture({ forkThread: async (id) => {
      forkRpcSucceeded = true;
      return { id: "fork", forkedFromId: id, turns: history };
    } });
    await service.readThread("thread-a");
    service.observatory.subscribe(() => { throw new Error("synthetic IPC delivery failure"); });
    const path = join(await mkdtemp(join(tmpdir(), "threadpath-observatory-")), "preferences.json");
    const preferences = new UserPreferencesService(path, "en-US");
    await preferences.load();
    // The same service -> recordBranch sequence as index.ts, using real
    // persistence without loading Electron or refactoring the IPC handler.
    const fork = await service.forkConversation("thread-a", "turn-a", process.cwd());
    await preferences.recordBranch({ threadId: fork.id, sourceThreadId: "thread-a", forkTurnId: "turn-a", forkLabel: "Synthetic cutoff", createdAt: "2026-10-17T00:00:00Z", readOnly: true }, { id: fork.id, forkedFromId: "thread-a" }, "Synthetic branch");
    await preferences.flush();
    const reloaded = new UserPreferencesService(path, "en-US");
    await reloaded.load();
    assert.equal(forkRpcSucceeded, true);
    assert.equal(fork.id, "fork");
    assert.equal(reloaded.getBranch("fork")?.forkTurnId, "turn-a", "metadata registration must not be skipped after successful RPC");
    service.close();
  }],
  ["read, reconcile, start and conversation reducer survive delivery failure", async () => {
    const { service, notify } = fixture({ resumeThread: async (id) => ({ id, turns: history }) });
    service.observatory.subscribe(() => { throw new Error("synthetic delivery failure"); });
    assert.equal((await service.readThread("thread-a")).id, "thread-a");
    assert.equal((await service.reconcileThread("thread-b")).activity, "idle", "archive's reconcile prerequisite still succeeds");
    const updates: string[] = [];
    service.onConversationUpdate((update) => updates.push(update.type));
    assert.doesNotThrow(() => notify("item/completed", params));
    assert.deepEqual(updates, ["item/completed"]);
    assert.deepEqual(service.getLoadedThread("thread-a")?.turns[0]?.items[0], { kind: "compaction", id: "compact-1", status: "completed" });
    assert.deepEqual(await service.startTurn("thread-c", "synthetic input"), { threadId: "thread-c", turnId: "live-turn" });
    assert.doesNotThrow(() => service.close(), "cleanup must also survive stale-state delivery errors");
  }],
  ["delivery diagnostics contain no payload and cannot throw", () => {
    const store = new ObservatoryService();
    store.subscribe(() => { throw new Error("synthetic private subscriber details"); });
    const warning = console.warn;
    const diagnostics: unknown[][] = [];
    try {
      console.warn = (...args: unknown[]) => { diagnostics.push(args); };
      store.observeNotification("thread/tokenUsage/updated", event());
      assert.deepEqual(diagnostics, [["[observatory] listener delivery failed"]]);
      console.warn = () => { throw new Error("diagnostic unavailable"); };
      assert.doesNotThrow(() => store.observeNotification("thread/tokenUsage/updated", event("thread-a", "turn-a", 700)));
    } finally { console.warn = warning; }
  }],
  ["core protocol errors remain visible", async () => {
    const error = new ProtocolError("synthetic core protocol failure");
    const read = fixture({ readThread: async () => { throw error; } }).service;
    await assert.rejects(read.readThread("thread-a"), (actual: unknown) => actual === error);
    read.close();
    const resume = fixture({ resumeThread: async () => { throw error; } }).service;
    await assert.rejects(resume.startTurn("thread-a", "synthetic input"), (actual: unknown) => actual === error);
    resume.close();
    const fork = fixture({ forkThread: async () => { throw error; } }).service;
    await fork.readThread("thread-a");
    await assert.rejects(fork.forkConversation("thread-a", "turn-a", process.cwd()), (actual: unknown) => actual === error);
    fork.close();
  }],
  ["resume buffers pre-response usage and consumes only confirmed replay", () => {
    const store = new ObservatoryService();
    store.observeNotification("thread/tokenUsage/updated", event());
    const before = store.get("thread-a");
    store.beginResume("thread-a");
    store.observeNotification("thread/tokenUsage/updated", event());
    assert.equal(store.get("thread-a"), before, "an unconfirmed attempt is not a usage event");
    store.completeResume("thread-a");
    assert.equal(store.get("thread-a").usage?.source, "resumed");
    const replay = store.get("thread-a");
    store.observeNotification("thread/tokenUsage/updated", event());
    assert.equal(store.get("thread-a"), replay, "a consumed marker must not relabel duplicate replay as live");
    store.observeNotification("thread/tokenUsage/updated", event("thread-a", "turn-a", 700));
    assert.equal(store.get("thread-a").usage?.source, "live", "the resume marker is one-shot, not a permanent thread tag");
    store.beginResume("thread-a");
    store.completeResume("thread-a");
    store.observeNotification("thread/tokenUsage/updated", event("thread-a", "turn-a", 800));
    assert.equal(store.get("thread-a").usage?.source, "resumed", "the first snapshot after a successful RPC can be replay");
    store.observeLiveTurn("thread-a", "new-turn");
    store.observeNotification("thread/tokenUsage/updated", event("thread-a", "new-turn", 900));
    assert.equal(store.get("thread-a").usage?.source, "live");
  }],
  ["rejected resume also rolls back snapshots delivered before rejection", async () => {
    let send: (method: string, params: JsonObject) => void = () => undefined;
    const { service, notify } = fixture({ resumeThread: async () => {
      send("thread/tokenUsage/updated", event());
      throw new Error("resume rejected after notification");
    } });
    send = notify;
    notify("thread/tokenUsage/updated", event());
    const before = service.observatory.get("thread-a");
    await assert.rejects(service.startTurn("thread-a", "synthetic input"), /resume rejected after notification/);
    assert.equal(service.observatory.get("thread-a"), before);
    notify("thread/tokenUsage/updated", event());
    assert.equal(service.observatory.get("thread-a"), before);
    service.close();
  }],
  ["resume A failure cannot affect successful resume B", async () => {
    let send: (method: string, params: JsonObject) => void = () => undefined;
    const { service, notify } = fixture({ resumeThread: async (id) => {
      if (id === "thread-a") throw new Error("resume A rejected");
      send("thread/tokenUsage/updated", event(id));
      return { id, turns: [] };
    } });
    send = notify;
    notify("thread/tokenUsage/updated", event());
    const beforeA = service.observatory.get("thread-a");
    await assert.rejects(service.startTurn("thread-a", "synthetic input"), /resume A rejected/);
    await service.startTurn("thread-b", "synthetic input");
    assert.equal(service.observatory.get("thread-b").usage?.source, "resumed");
    notify("thread/tokenUsage/updated", event());
    assert.equal(service.observatory.get("thread-a"), beforeA);
    service.close();
  }],
  ["disconnect, close and new live turn clear resume markers", () => {
    for (const confirmed of [false, true]) {
      const { service } = fixture();
      const store = service.observatory;
      store.beginResume("thread-a");
      if (confirmed) store.completeResume("thread-a");
      service.connectionChanged("stopped");
      service.connectionChanged("ready");
      store.completeResume("thread-a");
      store.observeNotification("thread/tokenUsage/updated", event());
      assert.equal(store.get("thread-a").usage?.source, "live", "reconnect cannot retain a resume attempt");
      store.beginResume("thread-a");
      store.completeResume("thread-a");
      store.observeLiveTurn("thread-a", "new-turn");
      store.observeNotification("thread/tokenUsage/updated", event("thread-a", "new-turn", 700));
      assert.equal(store.get("thread-a").usage?.source, "live");
      store.beginResume("thread-a");
      service.close();
      store.completeResume("thread-a");
      store.observeNotification("thread/tokenUsage/updated", event("thread-a", "later-turn", 800));
      assert.equal(store.get("thread-a").usage?.source, "live", "thread/service cleanup clears pending provenance");
    }
  }],
  ["disconnect retains valid buffered usage as stale without replay provenance", () => {
    const store = new ObservatoryService();
    store.beginResume("thread-a");
    store.observeNotification("thread/tokenUsage/updated", event());
    store.disconnected();
    assert.equal(store.get("thread-a").usage?.total.totalTokens, 600);
    assert.equal(store.get("thread-a").usage?.source, "live");
    assert.equal(store.get("thread-a").usage?.stale, true);
    store.completeResume("thread-a");
    store.observeNotification("thread/tokenUsage/updated", event("thread-a", "later-turn", 700));
    assert.equal(store.get("thread-a").usage?.source, "live");
  }],
  ["turn/start rejection clears a confirmed resume waiting for usage", async () => {
    const { service, notify } = fixture({ startTurn: async () => { throw new Error("turn start rejected"); } });
    notify("thread/tokenUsage/updated", event());
    const before = service.observatory.get("thread-a");
    await assert.rejects(service.startTurn("thread-a", "synthetic input"), /turn start rejected/);
    notify("thread/tokenUsage/updated", event());
    assert.equal(service.observatory.get("thread-a"), before);
    service.close();
  }],
  ["usage arriving before turn/start response is conservatively live", async () => {
    let send: (method: string, params: JsonObject) => void = () => undefined;
    const { service, notify } = fixture({ startTurn: async (id) => {
      send("thread/tokenUsage/updated", event(id, "live-turn", 700));
      return { id: "live-turn" };
    } });
    send = notify;
    await service.startTurn("thread-a", "synthetic input");
    assert.equal(service.observatory.get("thread-a").usage?.source, "live", "once turn/start is issued, an uncorrelated report cannot safely be called resume replay");
    service.close();
  }],
  ["malformed pending snapshot cannot restore an older buffered report", () => {
    const store = new ObservatoryService();
    store.beginResume("thread-a");
    store.observeNotification("thread/tokenUsage/updated", event());
    store.observeNotification("thread/tokenUsage/updated", { threadId: "thread-a", tokenUsage: {} });
    store.completeResume("thread-a");
    assert.equal(store.get("thread-a").usageError, "invalid-payload");
    assert.equal(store.get("thread-a").usage, null);
    store.cancelResume("thread-a");
  }],
  ["compaction preservation uses full thread, turn and item identity", async () => {
    const turns: Turn[] = [...history, { id: "other-turn", status: "completed", items: [{ id: "compact-1", type: "contextCompaction" }] }];
    const { service, notify } = fixture({ readThread: async (id) => ({ id, turns }), listTurns: async () => ({ turns }) });
    await service.readThread("thread-a");
    notify("item/completed", params);
    const otherThread = await service.readThread("thread-b");
    assert.deepEqual(otherThread.turns[0]?.items[0], { kind: "compaction", id: "compact-1", status: "unknown" });
    const reread = await service.readThread("thread-a");
    assert.deepEqual(reread.turns[0]?.items[0], { kind: "compaction", id: "compact-1", status: "completed" });
    assert.deepEqual(reread.turns[0]?.items[1], { kind: "compaction", id: "compact-2", status: "unknown" });
    assert.deepEqual(reread.turns[1]?.items[0], { kind: "compaction", id: "compact-1", status: "unknown" });
    const second = { ...params, item: { id: "compact-2", type: "contextCompaction" } };
    notify("item/started", second);
    assert.deepEqual((await service.readThread("thread-a")).turns[0]?.items[1], { kind: "compaction", id: "compact-2", status: "started" });
    notify("item/completed", second);
    assert.deepEqual((await service.readThread("thread-a")).turns[0]?.items[1], { kind: "compaction", id: "compact-2", status: "completed" }, "stronger live server information still updates the item");
    service.close();
  }],
];
const failures: string[] = [];
for (const [name, run] of regressions) {
  try { await run(); console.log(`[observatory-regression] PASS ${name}`); }
  catch (error: unknown) { failures.push(name); console.error(`[observatory-regression] FAIL ${name}`, error); }
}
assert.deepEqual(failures, [], "all three original reproductions must pass");
