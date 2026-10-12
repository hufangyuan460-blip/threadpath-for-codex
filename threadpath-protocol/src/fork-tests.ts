import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./app-server-client.ts";
import { AppServerError, CompatibilityError, ConfigurationError, ProcessError, ProtocolError, TimeoutError, type DiagnosticRecord, type Thread, type Turn } from "./protocol.ts";

const cwd = process.cwd();
const fakePath = fileURLToPath(new URL("./fake-fork-app-server.ts", import.meta.url));
function client(options: { mode?: string; capabilities?: string; statePath?: string; diagnostics?: DiagnosticRecord[] } = {}): AppServerClient {
  return new AppServerClient({ cwd, executable: process.execPath, args: ["--experimental-strip-types", fakePath], requestTimeoutMs: 1_000,
    env: { ...process.env, FAKE_FORK_MODE: options.mode ?? "normal", FAKE_FORK_CAPABILITIES: options.capabilities ?? "absent", FAKE_FORK_STATE_PATH: options.statePath },
    onDiagnostic: (record) => options.diagnostics?.push(record),
  });
}
async function turn(api: AppServerClient, threadId: string, text: string): Promise<Turn> {
  const started = await api.startTurn(threadId, [{ type: "text", text }]);
  assert.equal((await api.waitForTurnTerminal(started.id)).outcome, "completed");
  return started;
}
function ids(thread: Thread): string[] { return thread.turns?.map((item) => item.id) ?? []; }

async function verifyLifecycle(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "threadpath-fork-test-"));
  const diagnostics: DiagnosticRecord[] = [];
  let api = client({ statePath: join(directory, "state.json"), diagnostics });
  try {
    await api.initialize();
    // Unknown capabilities must not be advertised as verified fork support.
    assert.equal(api.supports("thread/fork"), false);
    const root = await api.startThread({ cwd });
    const first = await turn(api, root.id, "synthetic-base");
    const second = await turn(api, root.id, "synthetic-source-only");
    const before = await api.readThread(root.id);
    const branch = await api.forkThread(root.id, { lastTurnId: first.id, cwd, ephemeral: false, approvalPolicy: "never", sandbox: "read-only", model: "fixture-model" });
    assert.notEqual(branch.id, root.id);
    assert.equal(branch.forkedFromId, root.id);
    assert.equal(branch.sessionId, branch.id);
    assert.deepEqual(ids(branch), [first.id]);
    assert.deepEqual(await api.readThread(root.id), before);
    assert.deepEqual(await api.request("test/forkParams"), { threadId: root.id, lastTurnId: first.id, cwd, ephemeral: false, approvalPolicy: "never", sandbox: "read-only", model: "fixture-model" });
    await assert.rejects(api.forkThread(root.id, { lastTurnId: "unknown-turn" }), AppServerError);
    await assert.rejects(api.forkThread("unknown-thread"), AppServerError);
    const branchTurn = await turn(api, branch.id, "synthetic-branch-only");
    const rootTurn = await turn(api, root.id, "synthetic-source-continuation");
    assert.deepEqual(ids(await api.readThread(root.id)), [first.id, second.id, rootTurn.id]);
    assert.deepEqual(ids(await api.readThread(branch.id)), [first.id, branchTurn.id]);
    const wholeFork = await api.forkThread(root.id);
    assert.deepEqual(ids(wholeFork), [first.id, second.id, rootTurn.id]);
    const nestedFork = await api.forkThread(branch.id, { lastTurnId: branchTurn.id });
    assert.equal(nestedFork.forkedFromId, branch.id);
    assert.equal(nestedFork.sessionId, nestedFork.id);
    const listed = (await api.listThreads()).find((item) => item.id === branch.id);
    assert.equal(listed?.forkedFromId, root.id);
    assert.equal(listed?.sessionId, branch.sessionId);
    await api.close();
    api = client({ statePath: join(directory, "state.json"), diagnostics });
    await api.initialize();
    const resumed = await api.resumeThread(branch.id, { sandbox: "read-only" });
    assert.equal(resumed.forkedFromId, root.id);
    assert.equal(resumed.sessionId, branch.sessionId);
    assert.deepEqual(ids(resumed), [first.id, branchTurn.id]);
    const next = await turn(api, branch.id, "synthetic-after-restart");
    assert.deepEqual(ids(await api.readThread(branch.id)), [first.id, branchTurn.id, next.id]);
    assert.deepEqual(ids(await api.readThread(root.id)), [first.id, second.id, rootTurn.id]);
    assert.ok(diagnostics.some((record) => record.method === "thread/fork" && record.event === "request.completed"));
    assert.ok(!JSON.stringify(diagnostics).includes("synthetic-"));
  } finally {
    await api.close();
    // Verify the exact owned directory before recursive cleanup on Windows.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("threadpath-fork-test-"));
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyErrors(): Promise<void> {
  const unsafe = client({ mode: "unsafe-sandbox" });
  try {
    await unsafe.initialize();
    const root = await unsafe.startThread({ cwd });
    await assert.rejects(unsafe.resumeThread(root.id, { sandbox: "read-only" }), CompatibilityError);
  } finally { await unsafe.close(); }
  for (const [mode, expected] of [["unsupported", AppServerError], ["malformed", ProtocolError], ["same-id", ProtocolError], ["timeout", TimeoutError], ["exit", ProcessError]] as const) {
    const api = client({ mode });
    try {
      await api.initialize();
      await assert.rejects(api.forkThread("source-thread"), expected);
    } finally { await api.close(); }
  }
  const unsupported = client({ capabilities: "missing" });
  try {
    await unsupported.initialize();
    await assert.rejects(unsupported.forkThread("source-thread"), CompatibilityError);
  } finally { await unsupported.close(); }
  const held = client({ mode: "hold", capabilities: "complete" });
  try {
    await held.initialize();
    assert.equal(held.supports("thread/fork"), true);
    const root = await held.startThread({ cwd });
    const active = await held.startTurn(root.id, []);
    await assert.rejects(held.forkThread(root.id, { lastTurnId: active.id }), (error: unknown) => error instanceof AppServerError && error.code === -32602);
    await assert.rejects(held.forkThread(" "), ConfigurationError);
    await assert.rejects(held.forkThread(root.id, { lastTurnId: " " }), ConfigurationError);
    assert.deepEqual(ids(await held.readThread(root.id)), [active.id]);
  } finally { await held.close(); }
}

async function main(): Promise<void> {
  await verifyLifecycle();
  await verifyErrors();
  console.log("[fork-test] cutoff, independent history, restart, metadata, capability and failure checks passed");
}
main().catch((error: unknown) => { console.error(`[fork-test] FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
