import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { AppServerError, TimeoutError, type JsonValue } from "../../../threadpath-protocol/src/protocol.ts";
import { digest } from "./real-history-acceptance.ts";
import { failure, parseArchiveOptions, RecoveryBoundary, runRecovery, type Snapshot } from "./real-archive-acceptance.ts";

const tmp = mkdtempSync(resolve(process.env.PI_SCRATCH_DIR ?? tmpdir(), "m6c3-safety-"));
try {
  const args = ["--executable", resolve(tmp, "codex.exe"), "--report", resolve(tmp, "new.json"), "--history-report", resolve(tmp, "history.json"), "--execution-record", resolve(tmp, "record.json")];
  assert.equal(parseArchiveOptions(args, false).execute, false);
  assert.equal(parseArchiveOptions([...args, "--write", "--confirm-archive-recovery"], false).execute, true);
  for (const suffix of [["--write"], ["--confirm-archive-recovery"], ["--write", "--write"], ["--thread-id", "private"], ["--model", "unapproved"]]) assert.throws(() => parseArchiveOptions([...args, ...suffix], false));
  assert.throws(() => parseArchiveOptions([...args, "--write", "--confirm-archive-recovery"], true), /journal exists/);
  writeFileSync(resolve(tmp, "new.json"), "preserve");
  assert.throws(() => parseArchiveOptions(args, false), /overwrite forbidden/);
} finally { rmSync(tmp, { recursive: true, force: true }); }
assert.equal(JSON.stringify(failure(new AppServerError("private prompt/auth/path", "server", 123))).includes("private"), false);
assert.equal(failure(new TimeoutError("secret")).result, "BLOCKED");
let sent = 0;
const defaultBoundary = new RecoveryBoundary(async () => { sent++; return {}; }, false, digest("target"));
defaultBoundary.candidates.add("target"); defaultBoundary.select("target"); defaultBoundary.arm();
for (const method of ["thread/unarchive", "thread/resume", "thread/archive", "thread/start", "turn/start", "thread/fork", "thread/compact/start", "turn/interrupt"]) await assert.rejects(defaultBoundary.request(method, { threadId: "target" }));
assert.equal(sent, 0);
const scoped = new RecoveryBoundary(async () => { sent++; return {}; }, true, digest("target"));
scoped.candidates.add("target"); scoped.candidates.add("private");
assert.throws(() => scoped.select("private"), /not approved/);
scoped.select("target"); scoped.arm();
await assert.rejects(scoped.request("thread/unarchive", { threadId: "private" }), /not authorized/);
await assert.rejects(scoped.request("thread/resume", { threadId: "target", excludeTurns: true, sandbox: "read-only" }), /not confirmed/);
await assert.rejects(scoped.request("thread/read", { threadId: "private", includeTurns: true }), /unconfirmed/);
await scoped.request("thread/read", { threadId: "private", includeTurns: false });
const uncertain = new RecoveryBoundary(async () => { throw new TimeoutError("uncertain"); }, true, digest("target"));
uncertain.candidates.add("target"); uncertain.select("target"); uncertain.arm();
await assert.rejects(uncertain.request("thread/unarchive", { threadId: "target" }), TimeoutError);
await assert.rejects(uncertain.request("thread/unarchive", { threadId: "target" }), /budget exhausted/);
assert.equal(uncertain.counts["thread/unarchive"], 1);
uncertain.confirmActiveIdentity();
await assert.rejects(uncertain.request("thread/resume", { threadId: "target", excludeTurns: false, sandbox: "read-only" }), /metadata-only/);
await assert.rejects(uncertain.request("thread/resume", { threadId: "target", excludeTurns: true, sandbox: "read-only", model: "unapproved" }), /metadata-only/);
const journalFailure = new RecoveryBoundary(async () => { throw new Error("transport must not run"); }, true, digest("target"), () => { throw new Error("journal unavailable"); });
journalFailure.candidates.add("target"); journalFailure.select("target"); journalFailure.arm();
await assert.rejects(journalFailure.request("thread/unarchive", { threadId: "target" }), /journal unavailable/);
assert.equal(journalFailure.rpcCounts["thread/unarchive"], undefined);
await assert.rejects(journalFailure.request("thread/unarchive", { threadId: "target" }), /budget exhausted/);

const snapshot: Snapshot = { idSha256: digest("target"), turnCount: 2, itemCount: 4, itemIdentitySha256: "items", historySha256: "body", forkOriginSha256: "origin" };
const { itemIdentitySha256: _items, ...expected } = snapshot;
const scenarios = ["success", "read-only", "initial-body-mismatch", "reserve-failure", "unarchive-before-failure", "unarchive-after-timeout", "active-body-mismatch", "resume-permission", "resume-bad-policy", "identity-lost", "archive-before-failure", "archive-after-timeout", "unexpected-turn"] as const;
for (const scenario of scenarios) {
  let active = false, reserved = 0, reads = 0, turnEvents = 0;
  const mutations: string[] = [];
  const boundary = new RecoveryBoundary(async (method, params): Promise<JsonValue> => {
    assert.equal(params.threadId, "target", "other thread mutated"); mutations.push(method);
    if (method === "thread/unarchive") {
      if (scenario === "unarchive-before-failure") throw new AppServerError("refused", "server", -1);
      active = true;
      if (scenario === "unarchive-after-timeout") throw new TimeoutError("applied but response missing");
      return { thread: { id: "target" } };
    }
    if (method === "thread/resume") {
      assert.equal(params.excludeTurns, true); assert.equal(params.sandbox, "read-only");
      if (scenario === "resume-permission") throw new AppServerError("permission denied", "server", -2);
      if (scenario === "unexpected-turn") turnEvents++;
      return { thread: { id: "target", turns: [] }, sandbox: { type: scenario === "resume-bad-policy" ? "workspaceWrite" : "readOnly" } };
    }
    if (method === "thread/archive") {
      if (scenario === "archive-before-failure") throw new AppServerError("refused", "server", -3);
      active = false;
      if (scenario === "archive-after-timeout") throw new TimeoutError("applied but response missing");
      return {};
    }
    throw new Error("unexpected RPC");
  }, scenario !== "read-only", digest("target"));
  boundary.candidates.add("target"); boundary.select("target");
  const result = await runRecovery(boundary, {
    state: async () => ({ active, archived: !active }),
    snapshot: async () => { reads++; return { ...snapshot, ...(scenario === "initial-body-mismatch" && reads === 1 || scenario === "active-body-mismatch" && reads === 2 ? { historySha256: "changed" } : {}) }; },
    metadataIdentity: async () => { if (scenario === "identity-lost" && active) throw new Error("untrusted identity"); },
    reserve: () => { reserved++; if (scenario === "reserve-failure") throw new Error("reservation failed"); },
    unexpectedTurns: () => turnEvents,
  }, expected, scenario !== "read-only");
  for (const value of Object.values(boundary.counts)) assert.ok(value <= 1, "mutation repeated");
  if (scenario === "success") { assert.equal(result.finalResult, "M6_C3: PASS"); assert.equal(result.restored, true); assert.deepEqual(mutations, ["thread/unarchive", "thread/resume", "thread/archive"]); }
  else assert.notEqual(result.finalResult, "M6_C3: PASS", "partial failure masked as PASS");
  if (["read-only", "initial-body-mismatch", "reserve-failure"].includes(scenario)) assert.equal(mutations.length, 0);
  if (["read-only", "initial-body-mismatch"].includes(scenario)) assert.equal(reserved, 0);
  if (["active-body-mismatch", "unarchive-after-timeout", "identity-lost"].includes(scenario)) assert.equal(boundary.counts["thread/resume"], 0);
  if (scenario === "identity-lost") { assert.equal(boundary.counts["thread/archive"], 0); assert.equal(active, true); }
  else if (scenario !== "archive-before-failure") assert.equal(active, false, "original state not restored in fake lifecycle");
  if (["unarchive-after-timeout", "active-body-mismatch", "resume-permission", "resume-bad-policy", "archive-after-timeout"].includes(scenario)) assert.equal(boundary.counts["thread/archive"], 1);
}
console.log("[archive-acceptance] PASS offline default-readonly, target/scope guards, single-use budgets, report/journal guards, redaction, and 13 success/failure lifecycles; no real CLI launched");
