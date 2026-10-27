import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type JsonObject } from "../../../threadpath-protocol/src/protocol.ts";
import { parseThreadTokenUsageUpdatedNotification } from "../../../threadpath-protocol/src/token-usage.ts";
import { observatoryReadBoundary, parseObservatoryOptions, realCapabilities, replayHistory, ScopedObservations, type HistoryCapture } from "./real-observatory-acceptance.ts";

const tmp = mkdtempSync(resolve(process.env.PI_SCRATCH_DIR ?? tmpdir(), "m6c4-safety-"));
try {
  const args = ["--executable", resolve(tmp, "codex.exe"), "--report", resolve(tmp, "new.json"), "--history-report", resolve(tmp, "c2.json"), "--archive-report", resolve(tmp, "c3.json"), "--execution-record", resolve(tmp, "record.json")];
  assert.equal(parseObservatoryOptions(args).report, resolve(tmp, "new.json"));
  for (const suffix of [["--write"], ["--confirm-cost-and-state"], ["--resume"], ["--model", "override"], ["--thread-id", "private"]]) assert.throws(() => parseObservatoryOptions([...args, ...suffix]), /invalid/);
  writeFileSync(resolve(tmp, "new.json"), "preserve"); assert.throws(() => parseObservatoryOptions(args), /overwrite forbidden/);
} finally { rmSync(tmp, { recursive: true, force: true }); }
let sent = 0;
const boundary = observatoryReadBoundary(async () => { sent++; return {}; }, new Set(["branch"]), new Set(["candidate"]));
for (const method of ["thread/start", "turn/start", "thread/resume", "thread/fork", "thread/archive", "thread/unarchive", "thread/compact/start", "turn/interrupt"]) await assert.rejects(boundary(method, { threadId: "branch" }), /forbidden/);
await assert.rejects(boundary("thread/read", { threadId: "private", includeTurns: true }), /unconfirmed/);
await assert.rejects(boundary("thread/read", { threadId: "candidate", includeTurns: true }), /unconfirmed/);
const invalidEstimatedQueries: JsonObject[] = [{}, { threadId: "private" }, { threadId: "candidate" }, { threadId: "branch", scope: "account" }];
for (const params of invalidEstimatedQueries) await assert.rejects(boundary("account/usage/read", params), /thread-scoped/);
assert.equal(sent, 0);
await boundary("thread/read", { threadId: "candidate", includeTurns: false }); assert.equal(sent, 1);
const histories: HistoryCapture[] = [
  { identity: { id: "source", role: "source", createdAt: 0 }, turns: [{ id: "shared", status: "completed", itemsView: "full", items: [] }] },
  { identity: { id: "branch", role: "branch", createdAt: 0 }, turns: [{ id: "shared", status: "completed", itemsView: "full", items: [] }, { id: "compact-turn", status: "completed", itemsView: "full", items: [{ id: "compact-item", type: "contextCompaction" }] }] },
  { identity: { id: "historical", role: "historical", createdAt: 0 }, turns: [{ id: "shared", status: "completed", itemsView: "full", items: [] }] },
];
const confirmed = new Set(histories.map((h) => h.identity.id));
const absent = new ScopedObservations(confirmed);
const noEvents = absent.finish(histories);
assert.equal(noEvents.summary.acceptedUsageNotifications, 0);
assert.equal(realCapabilities(noEvents.summary, true).find((r) => r.capability === "Token Usage notification")?.status, "BLOCKED");
assert.equal(realCapabilities(noEvents.summary, true).find((r) => r.capability === "Compaction live lifecycle")?.status, "BLOCKED");
const historyReplay = replayHistory(histories, []);
assert.equal(historyReplay.filter((r) => r.status === "PASS").length, 4);
assert.equal(historyReplay.filter((r) => r.status === "SKIP").length, 3);
assert.ok(historyReplay.every((r) => r.source === "LOCAL_REPLAY"));
assert.equal(absent.finish(histories).summary.acceptedCompactionNotifications, 0, "derived local envelopes contaminated real event counts");
const breakdown: JsonObject = { totalTokens: 60, inputTokens: 50, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 };
const payload: JsonObject = { threadId: "branch", turnId: "compact-turn", tokenUsage: { total: breakdown, last: { ...breakdown }, modelContextWindow: null }, unknown: "DO_NOT_REPORT" };
const collector = new ScopedObservations(confirmed);
collector.observe("thread/tokenUsage/updated", { ...payload, threadId: "PRIVATE_THREAD" });
collector.observe("account/updated", { secret: "DO_NOT_REPORT" });
collector.observe("thread/tokenUsage/updated", payload); collector.observe("thread/tokenUsage/updated", payload);
const compact: JsonObject = { threadId: "branch", turnId: "compact-turn", item: { id: "compact-item", type: "contextCompaction", secret: "DO_NOT_REPORT" }, startedAtMs: 10, completedAtMs: 11 };
collector.observe("item/started", compact); collector.observe("item/completed", compact);
const captured = collector.finish(histories);
assert.equal(captured.summary.acceptedUsageNotifications, 2);
assert.equal(captured.summary.consecutiveDuplicateUsageSnapshots, 1);
assert.equal(captured.summary.nullContextWindowNotifications, 2);
assert.equal(captured.summary.matchedCompactionLifecycles, 1);
assert.equal(JSON.stringify(captured.summary).includes("DO_NOT_REPORT"), false);
assert.equal(JSON.stringify(captured.summary).includes("PRIVATE_THREAD"), false);
assert.equal(captured.usages[0].threadId, "branch");
assert.deepEqual(captured.usages[0], parseThreadTokenUsageUpdatedNotification(payload));
assert.ok(replayHistory(histories, captured.usages).every((r) => r.status === "PASS"));
const invalid = new ScopedObservations(confirmed);
invalid.observe("thread/tokenUsage/updated", { threadId: "branch", turnId: "compact-turn", tokenUsage: { total: { ...breakdown, outputTokens: "DO_NOT_REPORT" }, last: breakdown, modelContextWindow: 100 } });
const invalidSummary = invalid.finish(histories).summary;
assert.equal(invalidSummary.invalidUsageNotifications, 1);
assert.equal(invalidSummary.invalidUsageDegradedToUnknown, true);
assert.equal(JSON.stringify(invalidSummary).includes("DO_NOT_REPORT"), false);
assert.equal(realCapabilities(invalidSummary, true)[0].status, "FAIL", "actual invalid notifications must not become PASS");
const bounded = new ScopedObservations(confirmed, 1); bounded.observe("thread/tokenUsage/updated", payload); bounded.observe("thread/tokenUsage/updated", payload); assert.equal(bounded.finish(histories).summary.overflow, 1);
const wrongTurn = new ScopedObservations(confirmed); wrongTurn.observe("thread/tokenUsage/updated", { ...payload, turnId: "not-in-confirmed-history" }); assert.equal(wrongTurn.finish(histories).summary.outsideCapturedHistory, 1);
console.log("[observatory-acceptance] PASS offline write/identity/report guards, absent-evidence classification, scoped/redacted/bounded notifications, parser and local replay isolation; all usage/lifecycle inputs in this test are synthetic, no real CLI launched");
