import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { AppServerClient } from "./app-server-client.ts";
import { AppServerError, ConfigurationError, NetworkTimeoutError, ProtocolError } from "./protocol.ts";
import { check, createExclusiveReport, failure, forkStatus, parseOptions, runGuardedFork, runReadOnly, runRequestedFork, withAcceptanceOutput, writeOwnedReport, type AcceptancePaths, type Check } from "./real-acceptance.ts";

const exe = resolve("acceptance-test/codex.exe");
assert.equal(parseOptions([], exe).write, false);
assert.equal(parseOptions(["--write", "--confirm-cost-and-state"], exe).write, true);
for (const args of [["--write"], ["--confirm-cost-and-state"], ["--write", "--write"], ["--unknown"], ["--report"], ["--test-thread", "dedicated"], ["--confirm-test-thread"], ["--write", "--confirm-cost-and-state", "--test-thread", "dedicated", "--confirm-test-thread"]]) {
  assert.throws(() => parseOptions(args, exe), ConfigurationError);
}
assert.throws(() => parseOptions([], "codex"), ConfigurationError);
assert.throws(() => parseOptions([], "C:\\acceptance-test\\codex.cmd"), ConfigurationError);
assert.equal(parseOptions(["--test-thread", "dedicated", "--confirm-test-thread"], exe).threadId, "dedicated");
assert.equal(failure(new NetworkTimeoutError("private/path secret")).status, "BLOCKED");
assert.equal(failure(new ProtocolError("private/path secret")).status, "FAIL");
assert.equal(failure(new AppServerError("unauthorized secret", "server", 401)).status, "BLOCKED");
const redacted: Check[] = [];
await check(redacted, "redaction", async () => { throw new AppServerError("secret prompt/auth/path", "server", 123); });
assert.equal(JSON.stringify(redacted).includes("secret"), false);
assert.equal(redacted[0].rpcCode, 123);

const startedAt = Date.now();
const freshReport = { verifiedAt: new Date(startedAt).toISOString(), passed: true, archivePassed: true };
assert.equal(forkStatus(0, false, freshReport, startedAt), "PASS");
assert.equal(forkStatus(0, false, { ...freshReport, verifiedAt: new Date(startedAt - 1).toISOString() }, startedAt), "BLOCKED");
assert.equal(forkStatus(0, false, undefined, startedAt), "BLOCKED");
assert.equal(forkStatus(null, true, freshReport, startedAt), "BLOCKED");
assert.equal(forkStatus(1, false, { ...freshReport, passed: false, failureCategory: "network-timeout" }, startedAt), "BLOCKED");
assert.equal(forkStatus(1, false, { ...freshReport, passed: false, failureCategory: "assertion" }, startedAt), "FAIL");
assert.equal(forkStatus(0, false, { ...freshReport, archivePassed: false }, startedAt), "FAIL");

for (const scenario of ["empty", "private", "dedicated", "views", "init-error"] as const) {
  const methods: string[] = [];
  const client = new AppServerClient({ cwd: process.cwd(), executable: process.execPath,
    args: ["--experimental-strip-types", fileURLToPath(new URL("./fake-app-server.ts", import.meta.url))],
    env: { ...process.env, FAKE_APP_SERVER_HAS_THREAD: scenario === "empty" ? "false" : "true", FAKE_APP_SERVER_MODE: scenario === "views" ? "e2e-history-views" : scenario === "init-error" ? "server-error" : "completed", FAKE_APP_SERVER_CAPABILITIES: "absent" },
    requestTimeoutMs: 2_000, onDiagnostic: (record) => { if (record.event === "request.completed" || record.event === "request.failed") methods.push(record.method); },
  });
  const checks: Check[] = [];
  try { await runReadOnly(client, checks, scenario === "dedicated" ? "existing-thread" : scenario === "views" ? "e2e-thread" : undefined); }
  finally { await client.close(); }
  assert.ok(methods.every((method) => ["initialize", "model/list", "thread/list", "thread/read", "thread/turns/list"].includes(method)), "read-only mode sent a mutating request");
  if (scenario === "empty" || scenario === "private") {
    assert.equal(methods.includes("thread/read"), false, "private thread selected automatically");
    assert.equal(methods.includes("thread/turns/list"), false);
    assert.equal(checks.find((c) => c.name === "History.thread/read")?.status, "SKIP");
    assert.equal(checks.find((c) => c.name === "History.thread-list cursor")?.status, "SKIP");
  }
  if (scenario === "dedicated") {
    assert.equal(checks.find((c) => c.name === "History.thread/read")?.status, "PASS");
    assert.equal(checks.find((c) => c.name === "History.body integrity")?.status, "SKIP", "empty metadata claimed full body integrity");
  }
  if (scenario === "views") {
    for (const view of ["notLoaded", "summary", "full"]) assert.equal(checks.find((c) => c.name === `History.${view}`)?.status, "PASS");
    assert.equal(JSON.stringify(checks).includes("User turn"), false, "history body leaked");
  }
  if (scenario === "init-error") assert.deepEqual(methods, ["initialize"], "queries continued after failed initialize");
}
console.log("[real-acceptance] PASS option guards, error redaction, read-only allowlist, private/empty history, dedicated history and view observations (offline only)");

// Reservation tests only use scratch paths and fake runners. No CLI or RPC.
const sandbox = mkdtempSync(resolve(process.env.PI_SCRATCH_DIR ?? tmpdir(), "m6-fork-reservation-"));
const pathsFor = (name: string): AcceptancePaths => ({ workspace: resolve(sandbox, name, "workspace"), forkReport: resolve(sandbox, name, "fork.json"), reservation: resolve(sandbox, name, "execution.json") });
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
try {
  let calls = 0;
  const paths = pathsFor("first");
  const batchId = "offline-first-batch";
  const firstExecution = runGuardedFork(paths, batchId, (fd) => {
    calls++;
    const journal = JSON.parse(readFileSync(paths.reservation, "utf8")) as { executionBatchId: string; state: string };
    assert.equal(journal.executionBatchId, batchId);
    assert.equal(journal.state, "consumed-before-runner", "runner started before durable reservation");
    assert.equal(existsSync(paths.workspace), true);
    assert.equal(JSON.parse(readFileSync(paths.forkReport, "utf8")).executionBatchId, batchId);
    // Mimic the actual inherited fd hand-off with a Node-only writer child.
    const writer = `import { writeOwnedReport } from ${JSON.stringify(new URL("./real-acceptance.ts", import.meta.url).href)}; writeOwnedReport(3, { executionBatchId: ${JSON.stringify(batchId)}, verifiedAt: new Date().toISOString(), passed: true, archivePassed: true });`;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", writer], { stdio: ["ignore", "pipe", "pipe", fd] });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr?.toString());
    return { status: child.status, processError: false };
  });
  assert.equal(calls, 1);
  assert.equal(firstExecution.batchId, batchId);
  assert.equal(forkStatus(firstExecution.status, firstExecution.processError, firstExecution.childReport, firstExecution.startedAt), "PASS");
  const firstHashes = [hash(paths.reservation), hash(paths.forkReport)];
  assert.throws(() => runGuardedFork(paths, "unauthorized-repeat", () => { calls++; return { status: 0, processError: false }; }), /prior fork execution/);
  assert.equal(calls, 1);
  assert.deepEqual([hash(paths.reservation), hash(paths.forkReport)], firstHashes);

  // Conflicting legacy reports/workspaces/reservations preserve bytes and never call runner.
  for (const conflict of ["forkReport", "reservation", "workspace"] as const) {
    const p = pathsFor(`legacy-${conflict}`);
    const owned = createExclusiveReport(p[conflict], "existing-batch"); owned.write({ preserved: conflict, sensitiveSyntheticMarker: "old evidence" }); owned.close();
    const digest = hash(p[conflict]); let invoked = 0;
    assert.throws(() => runGuardedFork(p, "new", () => { invoked++; return { status: 0, processError: false }; }), /prior fork execution/);
    assert.equal(invoked, 0); assert.equal(hash(p[conflict]), digest);
  }

  const totalPaths = pathsFor("total-conflict");
  const totalPath = resolve(sandbox, "total.json");
  const existingTotal = createExclusiveReport(totalPath, "old-total"); existingTotal.write({ existing: true }); existingTotal.close();
  const totalHash = hash(totalPath); let wholeRunCalls = 0;
  await assert.rejects(withAcceptanceOutput({ write: true, report: totalPath }, totalPaths, "new", async () => {
    wholeRunCalls++;
    return runGuardedFork(totalPaths, "new", () => { throw new Error("must not run"); });
  }));
  assert.equal(wholeRunCalls, 0, "existing total report must block before CLI/fork callback");
  assert.equal(hash(totalPath), totalHash); assert.equal(existsSync(totalPaths.reservation), false);
  for (const reportPath of [totalPaths.forkReport, totalPaths.reservation, resolve(totalPaths.workspace, "nested.json")]) {
    await assert.rejects(withAcceptanceOutput({ write: true, report: reportPath }, totalPaths, "overlap", async () => { wholeRunCalls++; }), /overlap/);
  }
  if (process.platform === "win32") await assert.rejects(withAcceptanceOutput({ write: true, report: resolve(totalPaths.workspace.toUpperCase(), "case-variant.json") }, totalPaths, "overlap", async () => { wholeRunCalls++; }), /overlap/);
  const overlapPaths = pathsFor("readonly-overlap");
  for (const protectedPath of Object.values(overlapPaths)) for (const write of [false, true]) {
    for (const reportPath of [resolve(protectedPath, "nested.json"), resolve(protectedPath, "..")]) {
      await assert.rejects(withAcceptanceOutput({ write, report: reportPath }, overlapPaths, "overlap", async () => { wholeRunCalls++; }), /overlap/);
      assert.equal(existsSync(protectedPath), false, "report collision polluted protected path");
    }
  }
  assert.equal(wholeRunCalls, 0);

  // Directory aliases exercise both canonicalization directions and missing tails.
  const aliasRoot = resolve(sandbox, "alias-target"); mkdirSync(aliasRoot);
  const alias = resolve(sandbox, "alias-link"), alias2 = resolve(sandbox, "alias-link-2");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  let linksAvailable = true;
  try { symlinkSync(aliasRoot, alias, linkType); symlinkSync(aliasRoot, alias2, linkType); }
  catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(code ?? "")) throw error;
    linksAvailable = false;
    console.log(`[real-acceptance] SKIP symlink/junction alias tests: link creation unavailable (${code})`);
  }
  if (linksAvailable) {
    const protectedPaths: AcceptancePaths = { workspace: resolve(aliasRoot, "workspace"), forkReport: resolve(aliasRoot, "fork.json"), reservation: resolve(aliasRoot, "execution.json") };
    mkdirSync(protectedPaths.workspace);
    writeFileSync(protectedPaths.forkReport, "fork evidence");
    writeFileSync(protectedPaths.reservation, "reservation evidence");
    const protectedHashes = [hash(protectedPaths.forkReport), hash(protectedPaths.reservation)];
    let callbackCalls = 0, runnerCalls = 0;
    const rejectOverlap = async (report: string, protectedSet: AcceptancePaths) => {
      for (const write of [false, true]) {
        await assert.rejects(withAcceptanceOutput({ write, report }, protectedSet, "alias", async () => {
          callbackCalls++;
          return runRequestedFork(write, protectedSet, "alias", () => { runnerCalls++; return { status: 0, processError: false }; });
        }), /overlap/);
      }
    };
    for (const key of ["workspace", "forkReport", "reservation"] as const) {
      const leaf = key === "workspace" ? "workspace" : key === "forkReport" ? "fork.json" : "execution.json";
      // Existing same name; an alias of the parent is also an ancestor conflict.
      await rejectOverlap(resolve(alias, leaf), protectedPaths);
      await rejectOverlap(alias, protectedPaths);
      if (key === "workspace") await rejectOverlap(resolve(alias, leaf, "missing", "total.json"), protectedPaths);
      const reversed = { ...protectedPaths, [key]: resolve(alias, leaf) };
      await rejectOverlap(protectedPaths[key], reversed);
      await rejectOverlap(resolve(alias2, leaf), reversed);
    }
    // Both sides have missing suffixes under differently named links.
    const missingPaths: AcceptancePaths = { workspace: resolve(alias, "future", "workspace"), forkReport: resolve(alias, "future", "fork.json"), reservation: resolve(alias, "future", "execution.json") };
    for (const leaf of ["workspace", "fork.json", "execution.json"]) await rejectOverlap(resolve(alias2, "future", leaf), missingPaths);
    await rejectOverlap(resolve(alias2, "future", "workspace", "nested.json"), missingPaths);
    await rejectOverlap(resolve(alias2, "future"), missingPaths);
    if (process.platform === "win32") await rejectOverlap(resolve(alias2.toUpperCase(), "FUTURE", "WORKSPACE", "nested.json"), missingPaths);
    assert.equal(callbackCalls, 0); assert.equal(runnerCalls, 0);
    assert.deepEqual([hash(protectedPaths.forkReport), hash(protectedPaths.reservation)], protectedHashes);
    assert.equal(existsSync(resolve(aliasRoot, "future")), false);

    // An existing dangling link is not an ordinary missing path, on either side.
    const dangling = resolve(sandbox, "dangling-link");
    symlinkSync(resolve(sandbox, "missing-link-target"), dangling, linkType);
    for (const write of [false, true]) {
      await assert.rejects(withAcceptanceOutput({ write, report: resolve(dangling, "total.json") }, protectedPaths, "dangling", async () => { callbackCalls++; }));
      const danglingPaths = { ...protectedPaths, workspace: resolve(dangling, "workspace") };
      const safeReport = resolve(sandbox, `dangling-safe-${write}.json`);
      await assert.rejects(withAcceptanceOutput({ write, report: safeReport }, danglingPaths, "dangling", async () => { callbackCalls++; }));
      assert.equal(existsSync(safeReport), false);
    }
    assert.equal(callbackCalls, 0); assert.equal(runnerCalls, 0);
    console.log("[real-acceptance] PASS symlink/junction alias overlap and dangling-link preflight (offline only)");
  }

  const readPaths = pathsFor("readonly"); let readRunnerCalls = 0;
  await withAcceptanceOutput({ write: false, report: resolve(sandbox, "readonly-total.json") }, readPaths, "readonly", async (output) => {
    assert.equal(runRequestedFork(false, readPaths, "readonly", () => { readRunnerCalls++; return { status: 0, processError: false }; }), undefined);
    output?.write({ executionBatchId: "readonly", finalResult: "read-only" });
  });
  assert.equal(readRunnerCalls, 0);
  assert.equal(existsSync(readPaths.reservation), false); assert.equal(existsSync(readPaths.forkReport), false); assert.equal(existsSync(readPaths.workspace), false);
  assert.equal(JSON.parse(readFileSync(resolve(sandbox, "readonly-total.json"), "utf8")).finalResult, "read-only");

  const normalPaths = pathsFor("normal-write"); let normalRunnerCalls = 0;
  const normalTotal = resolve(sandbox, "normal-write-total.json");
  await withAcceptanceOutput({ write: true, report: normalTotal }, normalPaths, "normal", async (output) => {
    const execution = runRequestedFork(true, normalPaths, "normal", (fd) => {
      normalRunnerCalls++; writeOwnedReport(fd, { executionBatchId: "normal" });
      return { status: 0, processError: false };
    });
    assert.equal(execution?.status, 0);
    output?.write({ ok: true });
  });
  assert.equal(normalRunnerCalls, 1);
  assert.equal(JSON.parse(readFileSync(normalTotal, "utf8")).ok, true);

  for (const mode of ["throws", "exit-failure", "uncertain-result"] as const) {
    const p = pathsFor(mode); let invoked = 0;
    const run = () => runGuardedFork(p, mode, () => { invoked++; if (mode === "throws") throw new Error("fake runner failed"); return { status: mode === "exit-failure" ? 1 : null, processError: mode === "uncertain-result" }; });
    if (mode === "throws") assert.throws(run, /fake runner failed/); else assert.notEqual(run().status, 0);
    assert.equal(existsSync(p.reservation), true);
    assert.throws(() => runGuardedFork(p, "repeat", () => { invoked++; return { status: 0, processError: false }; }), /prior fork execution/);
    assert.equal(invoked, 1);
  }
  // A failed setup after reservation must also keep the authorization consumed.
  const setup = pathsFor("setup-error"); const blocker = createExclusiveReport(resolve(sandbox, "not-a-directory"), "old"); blocker.close();
  setup.forkReport = resolve(sandbox, "not-a-directory", "fork.json"); let setupRunner = 0;
  assert.throws(() => runGuardedFork(setup, "setup", () => { setupRunner++; return { status: 0, processError: false }; }));
  assert.equal(setupRunner, 0); assert.equal(existsSync(setup.reservation), true);
  assert.throws(() => runGuardedFork(setup, "repeat", () => { setupRunner++; return { status: 0, processError: false }; })); assert.equal(setupRunner, 0);

  // Start actual independent Node processes; synchronize before contention so the
  // result proves cross-process exclusivity, not an in-memory flag or sequential test.
  const workerPath = resolve(sandbox, "reservation-worker.mjs");
  const worker = `import { runGuardedFork, writeOwnedReport } from ${JSON.stringify(new URL("./real-acceptance.ts", import.meta.url).href)};
import { appendFileSync, readFileSync } from 'node:fs';
const paths=JSON.parse(process.argv[2]), counter=process.argv[3], mode=process.argv[4];
process.stdout.write('READY\\n');
process.stdin.once('data',()=>{try {runGuardedFork(paths, 'worker-'+process.pid, (fd)=>{const j=JSON.parse(readFileSync(paths.reservation,'utf8')); if(j.state!=='consumed-before-runner') process.exit(99); appendFileSync(counter,'runner\\n'); if(mode==='crash') process.exit(17); writeOwnedReport(fd,{executionBatchId:j.executionBatchId,verifiedAt:new Date().toISOString(),passed:true,archivePassed:true}); return {status:0,processError:false};}); process.exit(0);}catch{process.exit(2);}});`;
  writeFileSync(workerPath, worker, { flag: "wx" });
  function startWorker(p: AcceptancePaths, counter: string, mode: string) {
    const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, JSON.stringify(p), counter, mode], { stdio: ["pipe", "pipe", "pipe"] });
    const done = new Promise<number | null>((resolveDone, reject) => { child.once("error", reject); child.once("exit", resolveDone); });
    const ready = new Promise<void>((resolveReady, reject) => { child.stdout.once("data", (buffer: Buffer) => buffer.toString().includes("READY") ? resolveReady() : reject(new Error("bad worker handshake"))); child.once("error", reject); child.once("exit", () => reject(new Error("worker exited before handshake"))); });
    return { child, done, ready };
  }
  const concurrent = pathsFor("concurrent"), counter = resolve(sandbox, "concurrent-counter.txt");
  const a = startWorker(concurrent, counter, "normal"), b = startWorker(concurrent, counter, "normal");
  await Promise.all([a.ready, b.ready]); a.child.stdin.end("go"); b.child.stdin.end("go");
  assert.deepEqual((await Promise.all([a.done, b.done])).sort(), [0, 2]);
  assert.deepEqual(readFileSync(counter, "utf8").trim().split(/\r?\n/), ["runner"], "two processes invoked the write runner");
  const crashed = pathsFor("crashed"), crashCounter = resolve(sandbox, "crash-counter.txt");
  const crash = startWorker(crashed, crashCounter, "crash"); await crash.ready; crash.child.stdin.end("go"); assert.equal(await crash.done, 17);
  assert.equal(existsSync(crashed.reservation), true, "abrupt exit removed durable reservation");
  const retry = startWorker(crashed, crashCounter, "normal"); await retry.ready; retry.child.stdin.end("go"); assert.equal(await retry.done, 2);
  assert.equal(readFileSync(crashCounter, "utf8").trim(), "runner");
  console.log("[real-acceptance] PASS atomic first/duplicate/concurrent/crash/failure reservations, pre-owned inherited reports, legacy evidence preservation, total-report conflicts and default read-only (offline Node/fake runner only)");
} finally { rmSync(sandbox, { recursive: true, force: true }); }
