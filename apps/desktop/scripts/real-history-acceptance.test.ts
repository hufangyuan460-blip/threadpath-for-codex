import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getTurnPage, type JsonObject, type Turn, type TurnPage } from "../../../threadpath-protocol/src/protocol.ts";
import { capturePages, identifyThreads, parseHistoryOptions, readEvidenceJson, readOnlyBoundary, replayClient, validateThreadGroup, verifyProjection, verifyReplay, verifySyntheticHistory } from "./real-history-acceptance.ts";
import { verifyApprovedExecutionIdentity } from "./approved-execution-identity.ts";

const workspace = fileURLToPath(new URL("../../../artifacts/m6c-fork-workspace", import.meta.url));
const start = Date.parse("2026-10-26T02:34:10.474Z"), end = Date.parse("2026-10-26T02:42:32.450Z");
const records: JsonObject[] = [
  { id: "source", cwd: workspace, createdAt: Math.floor(start / 1000), forkedFromId: null },
  { id: "branch", cwd: workspace, createdAt: Math.floor(start / 1000) + 120, forkedFromId: "source" },
  { id: "historical", cwd: workspace, createdAt: Math.floor(start / 1000) + 380, forkedFromId: "branch" },
];
const identities = identifyThreads([], records, workspace, start, end);
assert.deepEqual(identities.map((i) => i.role), ["source", "branch", "historical"]);
const indexProjection = records.map((t) => ({ ...t, forkedFromId: null }));
validateThreadGroup([], indexProjection, workspace, start, end);
assert.throws(() => identifyThreads([], indexProjection, workspace, start, end), /source chain is ambiguous/);
for (const invalid of [records.slice(1), [...records, records[0]], records.map((t, i) => i === 0 ? { ...t, cwd: resolve("private-workspace") } : t), records.map((t) => ({ ...t, createdAt: 1 })), records.map((t, i) => i === 1 ? { ...t, forkedFromId: "private" } : t)]) {
  assert.throws(() => identifyThreads([], invalid, workspace, start, end), /IDENTITY_BLOCKED/);
}
assert.throws(() => identifyThreads([records[0]], records, workspace, start, end), /IDENTITY_BLOCKED/);
let sent = 0;
const request = readOnlyBoundary(async () => { sent++; return {}; }, new Set(["source"]));
for (const rpc of ["thread/start", "turn/start", "thread/resume", "thread/fork", "thread/archive", "thread/unarchive", "thread/compact/start", "turn/interrupt"]) await assert.rejects(request(rpc, { threadId: "source" }), /forbidden RPC/);
await assert.rejects(request("thread/read", { threadId: "private" }), /unconfirmed/);
await assert.rejects(request("thread/list", {}), /unscoped/);
assert.equal(sent, 0);
await request("thread/read", { threadId: "source" });
assert.equal(sent, 1);
const candidatesOnly = readOnlyBoundary(async () => ({}), new Set(), new Set(["candidate"]));
await candidatesOnly("thread/read", { threadId: "candidate", includeTurns: false });
await assert.rejects(candidatesOnly("thread/read", { threadId: "candidate", includeTurns: true }), /unconfirmed/);
await assert.rejects(candidatesOnly("thread/turns/list", { threadId: "candidate" }), /unconfirmed/);
const replay = replayClient(async () => ({ id: "source" }), async () => ({ turns: [] }));
await assert.rejects(replay.resumeThread("source"), /forbidden/);
await assert.rejects(replay.startTurn("source", []), /forbidden/);
const tmp = mkdtempSync(resolve(process.env.PI_SCRATCH_DIR ?? tmpdir(), "m6c2-safety-"));
  writeFileSync(resolve(tmp, "record.json"), '\uFEFF{"exitCode":0}');
  assert.deepEqual(readEvidenceJson(resolve(tmp, "record.json")), { exitCode: 0 });
try {
  const identityPath = resolve(tmp, "synthetic-identity.json");
  const identityBytes = Buffer.from(JSON.stringify({ environment: { executionIdentity: "synthetic-user" } }));
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
  const verify = (bytes: Buffer, username = "synthetic-user") => {
    writeFileSync(identityPath, bytes);
    verifyApprovedExecutionIdentity({ path: identityPath, sha256: sha(bytes), username: () => username });
  };
  const blocked = (run: () => void) => assert.throws(run, { message: "approved execution identity verification failed" });
  verify(identityBytes);
  blocked(() => verify(identityBytes, "different-synthetic-user"));
  blocked(() => verifyApprovedExecutionIdentity({ path: resolve(tmp, "missing.json"), sha256: sha(identityBytes), username: () => "synthetic-user" }));
  let usernameCalled = false;
  blocked(() => verifyApprovedExecutionIdentity({ path: identityPath, sha256: "0".repeat(64), username: () => { usernameCalled = true; return "synthetic-user"; } }));
  assert.equal(usernameCalled, false, "fingerprint must be checked before identity lookup");
  for (const value of ["{", "null", "[]", '{"environment":null}', '{"environment":[]}', '{"environment":{}}', '{"environment":{"executionIdentity":""}}', '{"environment":{"executionIdentity":"   "}}', '{"environment":{"executionIdentity":42}}']) {
    blocked(() => verify(Buffer.from(value)));
  }
  blocked(() => verify(Buffer.from([0xff])));
  writeFileSync(identityPath, identityBytes);
  blocked(() => verifyApprovedExecutionIdentity({ path: identityPath, sha256: sha(identityBytes), username: () => { throw new Error("private identity"); } }));
  const args = ["--executable", resolve(tmp, "codex.exe"), "--report", resolve(tmp, "report.json"), "--execution-record", resolve(tmp, "record.json")];
  assert.equal(parseHistoryOptions(args).report, resolve(tmp, "report.json"));
  assert.throws(() => parseHistoryOptions([...args, "--write"]), /invalid/);
  assert.throws(() => parseHistoryOptions([...args, "--test-thread", "private"]), /invalid/);
  writeFileSync(resolve(tmp, "report.json"), "preserve");
  assert.throws(() => parseHistoryOptions(args), /overwrite forbidden/);
} finally { rmSync(tmp, { recursive: true, force: true }); }
const raw: JsonObject = { id: "a", status: "completed", itemsView: "full", items: [{ id: "message", type: "agentMessage", text: "body" }] };
verifyProjection([raw], getTurnPage({ data: [raw] }).turns, "full");
assert.throws(() => verifyProjection([raw], [{ id: "a", itemsView: "full", items: [] }]), /dropped an item/);
assert.throws(() => verifyProjection([raw], getTurnPage({ data: [raw] }).turns, "summary"), /different itemsView/);
await assert.rejects(capturePages(async () => ({ data: [{ ...raw, itemsView: "summary" }], nextCursor: "repeat" }), "source", "summary"), /duplicate turn|repeated cursor/);
let calls = 0;
const pages = await capturePages(async () => ++calls === 1 ? { data: [raw], nextCursor: "next" } : { data: [{ ...raw, id: "b" }], nextCursor: null }, "source", "full");
assert.equal(pages.length, 2);
assert.equal(pages[1].nextCursor, undefined);

const suffix = "a".repeat(32);
const format = 'Return only a JSON object with exactly the keys "base", "source", "branch", each a string or null. Use only the state established in this conversation. Do not call tools, inspect files, or change the workspace.';
const base = `BASE_${suffix}`, source = `SOURCE_${suffix}`, branch = `BRANCH_${suffix}`;
const seed = `Start a synthetic state test. Set base to "${base}"; source and branch are null. Remember these values.\n${format}`;
const report = `Report the current state without changing it.\n${format}`;
function turn(id: string, prompt: string, state: { base: string; source: string | null; branch: string | null }): Turn {
  return { id, status: "completed", itemsView: "full", items: [{ id: `${id}-u`, type: "userMessage", content: [{ type: "text", text: prompt }] }, { id: `${id}-a`, type: "agentMessage", text: JSON.stringify(state) }] };
}
const shared = turn("shared", seed, { base, source: null, branch: null });
const sourceTurns = [shared, turn("source2", `Set source to "${source}". Leave base and branch unchanged.\n${format}`, { base, source, branch: null }), turn("source3", report, { base, source, branch: null })];
const branchTurns: Turn[] = [shared, turn("branch2", `Set branch to "${branch}". Leave base and source unchanged.\n${format}`, { base, source: null, branch }), turn("branch3", report, { base, source: null, branch }), { id: "compact", status: "completed", itemsView: "full", items: [{ id: "compact-item", type: "contextCompaction" }] }, turn("branch4", report, { base, source: null, branch })];
const historicalTurns = [shared, turn("historical2", report, { base, source: null, branch: null })];
assert.deepEqual(verifySyntheticHistory(sourceTurns, branchTurns, historicalTurns).conversationTurns, [3, 4, 2]);
const damaged = structuredClone(sourceTurns); damaged[1].items![0].content = [{ type: "text", text: "truncated" }];
assert.throws(() => verifySyntheticHistory(damaged, branchTurns, historicalTurns), /prompt missing/);
function snapshots(turns: Turn[], view: "notLoaded" | "summary" | "full"): TurnPage[] {
  return [...turns].reverse().map((t, i) => ({ turns: [{ ...structuredClone(t), itemsView: view, items: view === "notLoaded" ? [] : structuredClone(t.items) }], ...(i < turns.length - 1 ? { nextCursor: `cursor-${i + 1}` } : {}) }));
}
const captures = [sourceTurns, branchTurns, historicalTurns].map((turns, i) => ({ identity: identities[i], metadata: { id: identities[i].id, historyMode: "paginated" as const, turns: [] }, read: { id: identities[i].id, turns }, pages: { notLoaded: snapshots(turns, "notLoaded"), summary: snapshots(turns, "summary"), full: snapshots(turns, "full") } }));
assert.equal((await verifyReplay(captures)).length, 6);
console.log("[history-acceptance] PASS offline identity gate, no-write allowlist, report preservation, pagination validation, body loss detection and six merge/reorder replays; no live CLI launched");
