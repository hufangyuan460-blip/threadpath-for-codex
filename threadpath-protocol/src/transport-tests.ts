import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./app-server-client.ts";
import { AppServerError, NetworkTimeoutError, ProcessError, ProtocolError, TimeoutError, getThreadId, getThreads, getTurnId, isJsonObject } from "./protocol.ts";

const cwd = process.cwd();
const fakeServerPath = fileURLToPath(new URL("./fake-app-server.ts", import.meta.url));
function createFakeClient(mode: string, hasExistingThread = false): AppServerClient {
  return new AppServerClient({
    cwd,
    executable: process.execPath,
    args: ["--experimental-strip-types", fakeServerPath],
    requestTimeoutMs: 250,
    env: { ...process.env, FAKE_APP_SERVER_MODE: mode, FAKE_APP_SERVER_HAS_THREAD: String(hasExistingThread) },
  });
}
async function withClient<T>(mode: string, hasExistingThread: boolean, run: (client: AppServerClient) => Promise<T>): Promise<T> {
  const client = createFakeClient(mode, hasExistingThread);
  try { return await run(client); } finally { await client.close(); }
}
async function verifyHappyPath(hasExistingThread: boolean, expectedOutcome: "completed" | "failed" | "interrupted"): Promise<void> {
  await withClient(expectedOutcome, hasExistingThread, async (client) => {
    await client.request("initialize", { clientInfo: { name: "protocol-test" }, capabilities: null });
    client.notify("initialized");
    const threads = getThreads(await client.request("thread/list", { archived: false, limit: 10 }));
    assert.equal(threads.length, hasExistingThread ? 1 : 0);
    if (hasExistingThread) {
      const threadId = threads[0]?.id;
      assert.equal(threadId, "existing-thread");
      await client.request("thread/read", { threadId });
      await client.request("thread/turns/list", { threadId, limit: 10 });
    }
    const startedThread = getThreadId(await client.request("thread/start", { cwd, ephemeral: true }));
    assert.equal(startedThread, "new-thread");
    const turnId = getTurnId(await client.request("turn/start", { threadId: startedThread, input: [] }));
    assert.equal(turnId, "turn-1");
    const terminal = await client.waitForTurnTerminal(turnId);
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
  await verifyEarlyExit();
  await verifyNonJsonOutput();
  await verifyLaunchFailure();
  console.log("[test] protocol transport checks passed");
}
main().catch((error: unknown) => { console.error(`[test] FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
