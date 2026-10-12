import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppServerClient } from "./app-server-client.ts";
import { AppServerError, ConfigurationError, ProtocolError, TimeoutError, isJsonObject, type JsonObject, type Thread, type Turn } from "./protocol.ts";

const workspace = process.env.CODEX_FORK_SMOKE_CWD ?? resolve("../artifacts/fork-smoke-workspace");
const reportPath = process.env.CODEX_FORK_SMOKE_REPORT ?? resolve("../artifacts/protocol-fork-report.json");
const timeoutMs = Number(process.env.CODEX_SMOKE_TIMEOUT_MS ?? 300_000);
const executable = process.env.CODEX_EXECUTABLE?.trim() || undefined;
const model = process.env.CODEX_FORK_SMOKE_MODEL?.trim() || undefined;
const compactEnabled = process.env.CODEX_FORK_SMOKE_COMPACT !== "0";
const suffix = randomUUID().replaceAll("-", "");
const markers = { base: `BASE_${suffix}`, source: `SOURCE_${suffix}`, branch: `BRANCH_${suffix}` };
const format = 'Return only a JSON object with exactly the keys "base", "source", "branch", each a string or null. Use only the state established in this conversation. Do not call tools, inspect files, or change the workspace.';
const checks: Array<{ name: string; passed: boolean; durationMs: number }> = [];
const ownedThreads: string[] = [];
let currentClient: AppServerClient | undefined;
let effort: string | undefined;
let serverVersion: string | undefined;
let stderrBytes = 0;
let stage = "setup";
let archivePassed = true;
let failure: unknown;

function log(message: string, detail?: unknown): void {
  console.log(`[fork-smoke] ${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
}
async function check(name: string, run: () => Promise<void>): Promise<void> {
  stage = name;
  const start = Date.now();
  try {
    await run();
    checks.push({ name, passed: true, durationMs: Date.now() - start });
    log(`PASS ${name}`);
  } catch (error: unknown) {
    checks.push({ name, passed: false, durationMs: Date.now() - start });
    throw error;
  }
}
function createClient(): AppServerClient {
  return new AppServerClient({ cwd: workspace, executable, requestTimeoutMs: timeoutMs,
    // stderr can contain environment or plugin paths; keep only a byte count.
    onStderr: (text) => { stderrBytes += Buffer.byteLength(text); },
    onDiagnostic: (record) => {
      if (record.event === "request.failed") log("request failed", { method: record.method, category: record.errorCategory });
    },
  });
}
async function readAllTurns(api: AppServerClient, threadId: string): Promise<Turn[]> {
  const turns = new Map<string, Turn>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await api.listTurns(threadId, { limit: 100, cursor });
    for (const item of page.turns) if (!turns.has(item.id)) turns.set(item.id, item);
    if (page.nextCursor !== undefined && seenCursors.has(page.nextCursor)) throw new ProtocolError("turn pagination cursor repeated");
    cursor = page.nextCursor;
    if (cursor !== undefined) seenCursors.add(cursor);
  } while (cursor !== undefined);
  // The verified adapter returns newest-first; canonical snapshots are oldest-first.
  return [...turns.values()].reverse();
}
async function turnIds(api: AppServerClient, threadId: string): Promise<string[]> {
  return (await readAllTurns(api, threadId)).map((turn) => turn.id);
}
function sameIds(actual: readonly string[], expected: readonly string[]): void {
  assert.deepEqual(actual, expected, "unexpected history membership or order");
}
function assertFork(thread: Thread, source: Thread): void {
  assert.notEqual(thread.id, source.id, "fork did not return a new thread id");
  assert.equal(thread.forkedFromId, source.id, "fork source was not retained");
  assert.equal(typeof thread.sessionId, "string", "fork session metadata was omitted");
}
async function ask(api: AppServerClient, threadId: string, prompt: string, expected: { base: string; source: string | null; branch: string | null }): Promise<Turn> {
  const deltas = new Map<string, string>();
  const completed = new Map<string, string>();
  const unsubscribe = api.onNotification(({ method, params }) => {
    if (params.threadId !== threadId || typeof params.turnId !== "string") return;
    const key = params.turnId;
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") deltas.set(key, (deltas.get(key) ?? "") + params.delta);
    if (method === "item/completed" && isJsonObject(params.item) && params.item.type === "agentMessage" && typeof params.item.text === "string") {
      completed.set(key, (completed.get(key) ?? "") + params.item.text);
    }
  });
  try {
    const started = await api.startTurn(threadId, [{ type: "text", text: `${prompt}\n${format}` }], { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) });
    const terminal = await api.waitForTurnTerminal(started.id);
    if (terminal.outcome !== "completed") {
      if (terminal.error !== undefined) throw terminal.error;
      throw new AppServerError(`synthetic turn ${terminal.outcome}`, "server");
    }
    const text = (completed.get(started.id) ?? deltas.get(started.id) ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let result: unknown;
    try { result = JSON.parse(text); } catch { throw new ProtocolError("synthetic reply was not a JSON state object"); }
    assert.deepEqual(result, expected, "model-visible context differed from the branch state");
    return started;
  } finally { unsubscribe(); }
}
async function compact(api: AppServerClient, threadId: string): Promise<void> {
  let resolveStarted!: (turnId: string) => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<string>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  void started.catch(() => {});
  const timeout = setTimeout(() => rejectStarted(new TimeoutError("compaction turn did not start")), timeoutMs);
  const unsubscribe = api.onNotification(({ method, params }) => {
    if (method !== "turn/started" || params.threadId !== threadId || !isJsonObject(params.turn) || typeof params.turn.id !== "string") return;
    resolveStarted(params.turn.id);
  });
  try {
    await api.request("thread/compact/start", { threadId });
    // Notifications can arrive before or after the RPC acknowledgement.
    const terminal = await api.waitForTurnTerminal(await started);
    if (terminal.outcome !== "completed") throw terminal.error ?? new AppServerError(`compaction ${terminal.outcome}`, "server");
  } finally { clearTimeout(timeout); unsubscribe(); }
}
async function main(): Promise<void> {
  await mkdir(workspace, { recursive: true });
  currentClient = createClient();
  try {
    await check("initialize", async () => {
      const result = await currentClient!.initialize();
      serverVersion = result.serverVersion;
      const models = await currentClient!.listModels();
      const selected = models.find((item) => model === undefined ? item.isDefault : item.id === model);
      if (model !== undefined && selected === undefined) throw new ConfigurationError("requested fork smoke model is not in model/list");
      if (selected?.supportedReasoningEfforts.some((item) => item.reasoningEffort === "low")) effort = "low";
    });
    const api = currentClient;
    const root = await api.startThread({ cwd: workspace, ephemeral: false, approvalPolicy: "never", sandbox: "read-only", ...(model === undefined ? {} : { model }) });
    ownedThreads.push(root.id);
    let baseTurn!: Turn;
    let sourceTurn!: Turn;
    await check("seed-shared-history", async () => {
      baseTurn = await ask(api, root.id, `Start a synthetic state test. Set base to "${markers.base}"; source and branch are null. Remember these values.`, { base: markers.base, source: null, branch: null });
    });
    await check("seed-source-only-history", async () => {
      sourceTurn = await ask(api, root.id, `Set source to "${markers.source}". Leave base and branch unchanged.`, { base: markers.base, source: markers.source, branch: null });
    });
    let fork!: Thread;
    await check("fork-through-ended-turn", async () => {
      const before = await turnIds(api, root.id);
      fork = await api.forkThread(root.id, { lastTurnId: baseTurn.id, ephemeral: false, approvalPolicy: "never", sandbox: "read-only" });
      ownedThreads.push(fork.id);
      assertFork(fork, root);
      sameIds(await turnIds(api, fork.id), [baseTurn.id]);
      sameIds(await turnIds(api, root.id), before);
      sameIds(before, [baseTurn.id, sourceTurn.id]);
    });
    let branchTurn!: Turn;
    await check("branch-context-excludes-source-future", async () => {
      branchTurn = await ask(api, fork.id, `Set branch to "${markers.branch}". Leave base and source unchanged.`, { base: markers.base, source: null, branch: markers.branch });
    });
    let continuedRoot!: Turn;
    await check("source-context-excludes-branch-future", async () => {
      continuedRoot = await ask(api, root.id, "Report the current state without changing it.", { base: markers.base, source: markers.source, branch: null });
      sameIds(await turnIds(api, root.id), [baseTurn.id, sourceTurn.id, continuedRoot.id]);
      sameIds(await turnIds(api, fork.id), [baseTurn.id, branchTurn.id]);
    });
    await api.close();
    currentClient = createClient();
    const restarted = currentClient;
    let restartedBranchTurn!: Turn;
    await check("restart-read-resume-and-continue", async () => {
      await restarted.initialize();
      assertFork(await restarted.readThread(fork.id), root);
      const resumed = await restarted.resumeThread(fork.id, { sandbox: "read-only" });
      assertFork(resumed, root);
      assert.equal(resumed.sessionId, fork.sessionId, "fork session metadata changed after restart");
      sameIds(await turnIds(restarted, root.id), [baseTurn.id, sourceTurn.id, continuedRoot.id]);
      sameIds(await turnIds(restarted, fork.id), [baseTurn.id, branchTurn.id]);
      restartedBranchTurn = await ask(restarted, fork.id, "Report the current state without changing it.", { base: markers.base, source: null, branch: markers.branch });
    });
    if (compactEnabled) {
      await check("manual-context-compaction", async () => { await compact(restarted, fork.id); });
      await check("compacted-context-continuation", async () => {
        await ask(restarted, fork.id, "Report the current state without changing it.", { base: markers.base, source: null, branch: markers.branch });
      });
      await check("historical-fork-after-compaction", async () => {
        const before = await turnIds(restarted, fork.id);
        assert.ok(before.includes(restartedBranchTurn.id), "compaction lost the latest conversation turn");
        const historical = await restarted.forkThread(fork.id, { lastTurnId: baseTurn.id, ephemeral: false, approvalPolicy: "never", sandbox: "read-only" });
        ownedThreads.push(historical.id);
        assertFork(historical, fork);
        sameIds(await turnIds(restarted, historical.id), [baseTurn.id]);
        await ask(restarted, historical.id, "Report the current state without changing it.", { base: markers.base, source: null, branch: null });
        sameIds(await turnIds(restarted, fork.id), before);
      });
    }
  } catch (error: unknown) { failure = error; }
  finally {
    if (currentClient !== undefined) {
      for (const threadId of [...ownedThreads].reverse()) {
        try { await currentClient.request("thread/archive", { threadId }); }
        catch { archivePassed = false; }
      }
      await currentClient.close();
    }
    await mkdir(resolve(reportPath, ".."), { recursive: true });
    const report: JsonObject = {
      verifiedAt: new Date().toISOString(), platform: process.platform, nodeVersion: process.version,
      ...(serverVersion === undefined ? {} : { serverVersion }),
      passed: failure === undefined && archivePassed, compactionRequested: compactEnabled,
      checks: checks.map((item) => ({ ...item })), createdThreadCount: ownedThreads.length,
      archivePassed, stderrBytes,
      ...(failure === undefined ? {} : { failedStage: stage, failureCategory: failure instanceof AppServerError ? failure.category : failure instanceof assert.AssertionError ? "assertion" : "unexpected" }),
    };
    // Deliberately omit thread ids, paths, prompts, replies and marker values.
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    log("report written", { passed: report.passed, archivePassed });
  }
  if (failure !== undefined) {
    log("FAILED", { stage, category: failure instanceof AppServerError ? failure.category : failure instanceof assert.AssertionError ? "assertion" : "unexpected", errorType: failure instanceof Error ? failure.name : "unknown", ...(failure instanceof assert.AssertionError ? { assertion: failure.message.split("\n")[0] } : {}) });
    process.exitCode = 1;
  } else if (!archivePassed) { log("FAILED: test thread archival incomplete"); process.exitCode = 1; }
  else log("all requested fork checks passed");
}
main().catch((error: unknown) => { log("FAILED during setup or report writing", { errorType: error instanceof Error ? error.name : "unknown" }); process.exitCode = 1; });
