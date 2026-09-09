import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./app-server-client.ts";
import { type DiagnosticRecord, type ErrorCategory, AppServerError, NetworkTimeoutError, ProcessError, ProtocolError, TimeoutError, isJsonObject } from "./protocol.ts";

const cwd = process.cwd();
const fakeServerPath = fileURLToPath(new URL("./fake-app-server.ts", import.meta.url));
function createFakeClient(mode: string, hasExistingThread = false, diagnostics?: DiagnosticRecord[]): AppServerClient {
  return new AppServerClient({
    cwd,
    executable: process.execPath,
    args: ["--experimental-strip-types", fakeServerPath],
    requestTimeoutMs: 250,
    env: { ...process.env, FAKE_APP_SERVER_MODE: mode, FAKE_APP_SERVER_HAS_THREAD: String(hasExistingThread) },
    onDiagnostic: diagnostics === undefined ? undefined : (record) => diagnostics.push(record),
  });
}
async function withClient<T>(mode: string, hasExistingThread: boolean, run: (client: AppServerClient) => Promise<T>): Promise<T> {
  const client = createFakeClient(mode, hasExistingThread);
  try { return await run(client); } finally { await client.close(); }
}
async function verifyHappyPath(hasExistingThread: boolean, expectedOutcome: "completed" | "failed" | "interrupted"): Promise<void> {
  await withClient(expectedOutcome, hasExistingThread, async (client) => {
    await client.initialize();
    const threads = await client.listThreads({ archived: false, limit: 10 });
    assert.equal(threads.length, hasExistingThread ? 1 : 0);
    if (hasExistingThread) {
      const threadId = threads[0]?.id;
      assert.equal(threadId, "existing-thread");
      await client.readThread(threadId);
      await client.listTurns(threadId, 10);
    }
    const startedThread = await client.startThread({ cwd, ephemeral: true });
    assert.equal(startedThread.id, "new-thread");
    const turn = await client.startTurn(startedThread.id, []);
    assert.equal(turn.id, "turn-1");
    const terminal = await client.waitForTurnTerminal(turn.id);
    assert.equal(terminal.outcome, expectedOutcome);
    if (expectedOutcome === "failed") assert.ok(terminal.error instanceof NetworkTimeoutError);
  });
}
async function verifyUnsupportedServerRequest(mode: string): Promise<void> {
  await withClient(mode, false, async (client) => {
    const result = await client.request("probe/server-request");
    assert.ok(isJsonObject(result));
    assert.ok(isJsonObject(result.serverRequestError));
    assert.equal(result.serverRequestError.code, -32601);
  });
}
async function verifyTimeout(): Promise<void> { await withClient("completed", false, async (client) => { await assert.rejects(client.request("test/timeout"), TimeoutError); }); }
async function verifyServerError(): Promise<void> {
  await withClient("completed", false, async (client) => {
    await assert.rejects(client.request("unknown/method"), (error: unknown) => {
      assert.ok(error instanceof AppServerError);
      assert.equal(error.category, "server");
      return true;
    });
  });
}
async function verifyHighLevelErrors(): Promise<void> {
  const checks: Array<(client: AppServerClient) => Promise<unknown>> = [
    (client) => client.initialize(),
    (client) => client.listThreads(),
    (client) => client.readThread("existing-thread"),
    (client) => client.listTurns("existing-thread"),
    (client) => client.startThread({ cwd, ephemeral: true }),
    (client) => client.startTurn("existing-thread", []),
  ];
  for (const check of checks) {
    const client = createFakeClient("server-error");
    try {
      await assert.rejects(check(client), (error: unknown) => {
        assert.ok(error instanceof AppServerError);
        assert.equal(error.category, "server");
        return true;
      });
    } finally {
      await client.close();
    }
  }

  await withClient("timeout", false, async (client) => {
    const thread = await client.startThread({ cwd, ephemeral: true });
    const turn = await client.startTurn(thread.id, []);
    await assert.rejects(client.waitForTurnTerminal(turn.id, 25), TimeoutError);
  });
}
async function verifyDiagnostics(): Promise<void> {
  const diagnostics: DiagnosticRecord[] = [];
  const client = createFakeClient("completed", false, diagnostics);
  try {
    await client.initialize();
    const thread = await client.startThread({ cwd, ephemeral: true });
    const turn = await client.startTurn(thread.id, []);
    await client.waitForTurnTerminal(turn.id);
    const initialize = diagnostics.find((record) => record.event === "request.completed" && record.method === "initialize");
    assert.equal(initialize?.requestId, 1);
    assert.equal(initialize?.status, "completed");
    assert.equal(typeof initialize?.startedAt, "string");
    assert.equal(typeof initialize?.durationMs, "number");
    assert.ok(diagnostics.some((record) => record.event === "notification" && record.method === "turn/completed" && record.status === "received"));
    assert.ok(diagnostics.some((record) => record.event === "turn.terminal" && record.method === "turn/completed" && record.status === "terminal" && record.outcome === "completed"));
    const sensitiveClient = createFakeClient("completed", false, diagnostics);
    try {
      await assert.rejects(sensitiveClient.request("sensitive/test", { text: "conversation-secret", token: "auth-token" }));
    } finally {
      await sensitiveClient.close();
    }
    const serialized = JSON.stringify(diagnostics);
    assert.ok(!serialized.includes("conversation-secret"));
    assert.ok(!serialized.includes("auth-token"));
  } finally {
    await client.close();
  }
}
async function verifyDiagnosticErrorCategories(): Promise<void> {
  const configurationDiagnostics: DiagnosticRecord[] = [];
  assert.throws(() => new AppServerClient({ cwd: " ", onDiagnostic: (record) => configurationDiagnostics.push(record) }), (error: unknown) => {
    assert.ok(error instanceof AppServerError);
    assert.equal(error.category, "configuration");
    return true;
  });
  assert.deepEqual(configurationDiagnostics, [{ event: "client.failed", method: "client", status: "failed", errorCategory: "configuration" }]);

  const cases: Array<{ mode: string; method: string; category: ErrorCategory }> = [
    { mode: "completed", method: "unknown/method", category: "server" },
    { mode: "non-json", method: "initialize", category: "protocol" },
    { mode: "completed", method: "test/exit", category: "process" },
    { mode: "completed", method: "test/timeout", category: "timeout" },
  ];
  for (const testCase of cases) {
    const diagnostics: DiagnosticRecord[] = [];
    const client = createFakeClient(testCase.mode, false, diagnostics);
    try {
      if (testCase.mode === "non-json") await new Promise((resolve) => setTimeout(resolve, 30));
      await assert.rejects(client.request(testCase.method));
      const failure = diagnostics.find((record) => record.event === "request.failed");
      assert.equal(failure?.status, "failed");
      assert.equal(failure?.errorCategory, testCase.category);
      assert.equal(typeof failure?.startedAt, "string");
      assert.equal(typeof failure?.durationMs, "number");
    } finally {
      await client.close();
    }
  }
}
async function verifyEarlyExit(): Promise<void> { await withClient("completed", false, async (client) => { await assert.rejects(client.request("test/exit"), ProcessError); }); }
async function verifyNonJsonOutput(): Promise<void> {
  await withClient("non-json", false, async (client) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await assert.rejects(client.request("initialize"), ProtocolError);
  });
}
async function verifyLaunchFailure(): Promise<void> {
  const client = new AppServerClient({ cwd, executable: "codex-does-not-exist-for-protocol-test", requestTimeoutMs: 250 });
  try { await assert.rejects(client.request("initialize"), ProcessError); } finally { await client.close(); }
}
async function main(): Promise<void> {
  await verifyHappyPath(true, "completed");
  await verifyHappyPath(false, "completed");
  await verifyHappyPath(false, "failed");
  await verifyHappyPath(false, "interrupted");
  await verifyUnsupportedServerRequest("completed");
  await verifyUnsupportedServerRequest("server-request-string");
  await verifyTimeout();
  await verifyServerError();
  await verifyHighLevelErrors();
  await verifyDiagnostics();
  await verifyDiagnosticErrorCategories();
  await verifyEarlyExit();
  await verifyNonJsonOutput();
  await verifyLaunchFailure();
  console.log("[test] protocol transport checks passed");
}
main().catch((error: unknown) => { console.error(`[test] FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
