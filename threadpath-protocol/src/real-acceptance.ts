import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { release, userInfo } from "node:os";
import { AppServerClient } from "./app-server-client.ts";
import { AppServerError, ConfigurationError, ProtocolError, isJsonObject, type Turn } from "./protocol.ts";

export type Status = "PASS" | "FAIL" | "SKIP" | "BLOCKED";
export interface Check { name: string; status: Status; evidence: string; category?: string; rpcCode?: number; }
interface Options { write: boolean; executable: string; report?: string; threadId?: string; }
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface AcceptancePaths { workspace: string; forkReport: string; reservation: string; }
export interface OwnedReport { readonly fd: number; write(value: unknown): void; close(): void; }
export interface ForkRunResult { status: number | null; processError: boolean; }
export interface ForkExecution extends ForkRunResult { batchId: string; startedAt: number; childReport: unknown; }
const defaultPaths: AcceptancePaths = {
  workspace: resolve(root, "artifacts/m6c-fork-workspace"),
  forkReport: resolve(root, "artifacts/m6c-fork-report.json"),
  reservation: resolve(root, "artifacts/m6c-fork-execution.json"),
};

export function writeOwnedReport(fd: number, value: unknown): void {
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset, offset);
    if (written === 0) throw new ConfigurationError("report write made no progress");
    offset += written;
  }
  ftruncateSync(fd, data.length);
  fsyncSync(fd);
}

/** Existing files are never opened for writing. Only this owned descriptor is updated. */
export function createExclusiveReport(path: string, batchId: string): OwnedReport {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx");
  let closed = false;
  const owned: OwnedReport = {
    fd,
    write(value) {
      if (closed) throw new ConfigurationError("report descriptor is closed");
      writeOwnedReport(fd, value);
    },
    close() { if (!closed) { closed = true; closeSync(fd); } },
  };
  try { owned.write({ executionBatchId: batchId, state: "reserved", createdAt: new Date().toISOString() }); }
  catch (error) { owned.close(); throw error; }
  return owned;
}

/** No cleanup on success, failure or uncertain exit: the same authorization cannot be replayed. */
export function runGuardedFork(paths: AcceptancePaths, batchId: string, runner: (ownedForkReportFd: number) => ForkRunResult): ForkExecution {
  // These checks preserve legacy artifacts too. The atomic wx below, not this
  // preflight, is the cross-process arbiter. All checks/reservations precede runner.
  if ([paths.reservation, paths.workspace, paths.forkReport].some((path) => existsSync(path))) {
    throw new ConfigurationError("prior fork execution state exists; new review and authorization required");
  }
  let journal: OwnedReport | undefined;
  let report: OwnedReport | undefined;
  const startedAt = Date.now();
  try {
    journal = createExclusiveReport(paths.reservation, batchId);
    journal.write({ executionBatchId: batchId, state: "consumed-before-runner", startedAt: new Date(startedAt).toISOString() });
    report = createExclusiveReport(paths.forkReport, batchId);
    // Non-recursive leaf creation rejects a concurrently created/legacy workspace.
    mkdirSync(dirname(paths.workspace), { recursive: true });
    mkdirSync(paths.workspace);
    const result = runner(report.fd);
    let childReport: unknown;
    try { childReport = JSON.parse(readFileSync(paths.forkReport, "utf8")); } catch { /* Never pass missing/malformed output. */ }
    journal.write({ executionBatchId: batchId, state: "finished-no-retry", startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(), exitCode: result.status, processError: result.processError });
    return { ...result, batchId, startedAt, childReport };
  } finally { report?.close(); journal?.close(); }
}

/** Read-only never acquires a write reservation and cannot call the fork runner. */
export function runRequestedFork(write: boolean, paths: AcceptancePaths, batchId: string, runner: (ownedForkReportFd: number) => ForkRunResult): ForkExecution | undefined {
  return write ? runGuardedFork(paths, batchId, runner) : undefined;
}

// Resolve existing ancestors on both sides; an existing but unresolvable link is
// an error, not a missing component. This preflight cannot eliminate symlink races.
function canonicalPath(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try { lstatSync(ancestor); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
      continue;
    }
    return resolve(realpathSync.native(ancestor), ...missing);
  }
}

function pathsOverlap(a: string, b: string): boolean {
  const comparable = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  const from = comparable(a), to = comparable(b);
  const within = (parent: string, child: string) => {
    const suffix = relative(parent, child);
    return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
  };
  return within(from, to) || within(to, from);
}

/** Total-report ownership is acquired before any CLI process or fork callback. */
export async function withAcceptanceOutput<T>(options: Pick<Options, "write" | "report">, paths: AcceptancePaths, batchId: string, run: (output?: OwnedReport) => Promise<T>): Promise<T> {
  if (options.report !== undefined) {
    const outputPath = resolve(options.report);
    const candidate = canonicalPath(outputPath);
    if (Object.values(paths).some((path) => {
      const protectedPath = resolve(path);
      return pathsOverlap(outputPath, protectedPath) || pathsOverlap(candidate, canonicalPath(protectedPath));
    })) {
      throw new ConfigurationError("total report must not overlap fork-owned paths");
    }
  }
  const output = options.report === undefined ? undefined : createExclusiveReport(resolve(options.report), batchId);
  try { return await run(output); } finally { output?.close(); }
}

export function parseOptions(args: string[], executable = process.env.CODEX_EXECUTABLE): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--write", "--confirm-cost-and-state", "--confirm-test-thread"].includes(arg)) {
      if (flags.has(arg)) throw new ConfigurationError("duplicate flag");
      flags.add(arg);
    } else if (["--executable", "--report", "--test-thread"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--") || values.has(arg)) throw new ConfigurationError("invalid option value");
      values.set(arg, value);
    } else throw new ConfigurationError("unknown acceptance option");
  }
  const write = flags.has("--write");
  if (write !== flags.has("--confirm-cost-and-state")) throw new ConfigurationError("write tests require both explicit write and cost/state confirmation");
  const threadId = values.get("--test-thread");
  if ((threadId !== undefined) !== flags.has("--confirm-test-thread")) throw new ConfigurationError("reading test history requires an explicit dedicated thread and confirmation");
  if (write && threadId !== undefined) throw new ConfigurationError("write mode cannot target an existing thread");
  const path = values.get("--executable") ?? executable;
  if (!path || !isAbsolute(path) || !path.toLowerCase().endsWith(".exe")) throw new ConfigurationError("provide the absolute native Codex exe path");
  return { write, executable: path, report: values.get("--report"), threadId };
}

export function failure(error: unknown): Pick<Check, "status" | "category" | "rpcCode"> {
  const category = error instanceof AppServerError ? error.category : "unexpected";
  // Environment/transport availability is not a product compatibility failure.
  const environment = ["configuration", "process", "timeout", "network-timeout"].includes(category)
    || (error instanceof Error && /auth|unauthorized|permission|profile|home directory|rate limit|quota/i.test(error.message));
  return { status: environment ? "BLOCKED" : "FAIL", category,
    ...(error instanceof AppServerError && typeof error.code === "number" ? { rpcCode: error.code } : {}) };
}

export function forkStatus(exitCode: number | null, processError: boolean, report: unknown, startedAt: number): Status {
  if (processError) return "BLOCKED";
  if (!isJsonObject(report) || typeof report.verifiedAt !== "string" || !(Date.parse(report.verifiedAt) >= startedAt)) return "BLOCKED";
  if (exitCode === 0 && report.passed === true && report.archivePassed === true) return "PASS";
  if (typeof report.failureCategory === "string" && ["configuration", "process", "timeout", "network-timeout"].includes(report.failureCategory)) return "BLOCKED";
  return "FAIL";
}

export async function check(checks: Check[], name: string, action: () => Promise<string>): Promise<boolean> {
  try { checks.push({ name, status: "PASS", evidence: await action() }); return true; }
  catch (error: unknown) {
    // No raw error messages: they can contain paths, server payloads or user content.
    checks.push({ name, ...failure(error), evidence: "request or assertion did not complete successfully; raw payload suppressed" });
    return false;
  }
}

export async function runReadOnly(client: AppServerClient, checks: Check[], threadId?: string): Promise<void> {
  if (!await check(checks, "Connection.initialize + initialized", async () => {
    await client.initialize(); return "initialize response parsed; initialized notification sent by shared client";
  })) {
    for (const name of ["Connection.model/list", "History.thread/list", "History.thread-list cursor"]) checks.push({ name, status: "BLOCKED", evidence: "initialize prerequisite unavailable" });
    return;
  }
  await check(checks, "Connection.model/list", async () => `models=${(await client.listModels()).length}; response after initialized`);
  await check(checks, "History.thread/list", async () => {
    for (const archived of [false, true]) await client.listThreadPage({ archived, limit: 1 });
    return "active and archived metadata queries parsed; no titles/previews/bodies recorded";
  });
  let cursorObserved = false;
  const cursorOK = await check(checks, "History.thread-list cursor", async () => {
    const first = await client.listThreadPage({ archived: false, limit: 1 });
    if (first.nextCursor === undefined) return "no next cursor; empty/single-page lists are valid";
    cursorObserved = true;
    const second = await client.listThreadPage({ archived: false, limit: 1, cursor: first.nextCursor });
    if (second.nextCursor === first.nextCursor || second.threads.some((t) => first.threads.some((s) => s.id === t.id))) throw new ProtocolError("thread pagination repeated");
    return `cursor consumed; page1=${first.threads.length}; page2=${second.threads.length}; non-overlapping metadata`;
  });
  if (cursorOK && !cursorObserved) checks[checks.length - 1].status = "SKIP";
  if (threadId === undefined) {
    for (const name of ["History.thread/read", "History.thread/turns/list", "History.turn cursor", "History.body integrity", "History.notLoaded", "History.summary", "History.full"]) {
      checks.push({ name, status: "SKIP", evidence: "no explicitly confirmed dedicated test thread; private history not selected" });
    }
    return;
  }
  let turns: Turn[] | undefined;
  const views = new Set<string>();
  const observe = (items: Turn[]) => { for (const t of items) if (t.itemsView) views.add(t.itemsView); };
  await check(checks, "History.thread/read", async () => {
    const thread = await client.readThread(threadId);
    if (thread.id !== threadId || thread.turns === undefined) throw new ProtocolError("unexpected thread history response");
    turns = thread.turns; observe(turns); return `turns=${turns.length}; bodies held in memory only`;
  });
  let pageTurns: Turn[] | undefined;
  let hasCursor = false;
  await check(checks, "History.thread/turns/list", async () => {
    const all: Turn[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 0; ; pages++) {
      if (pages >= 100) throw new ConfigurationError("bounded history scan exhausted");
      const page = await client.listTurns(threadId, { limit: 1, cursor });
      for (const turn of page.turns) {
        if (ids.has(turn.id)) throw new ProtocolError("repeated turn across pages");
        ids.add(turn.id); all.push(turn);
      }
      observe(page.turns);
      cursor = page.nextCursor;
      if (cursor === undefined) break;
      if (cursors.has(cursor)) throw new ProtocolError("repeated turn cursor");
      cursors.add(cursor); hasCursor = true;
    }
    pageTurns = all;
    return `turns=${all.length}; pages fully consumed; bodies not logged`;
  });
  checks.push({ name: "History.turn cursor", status: pageTurns === undefined ? "BLOCKED" : hasCursor ? "PASS" : "SKIP", evidence: hasCursor ? "cursor consumed without repeated turns/cursors" : "no completed multi-page observation" });
  // Equal metadata is insufficient evidence of complete historical message bodies.
  checks.push({ name: "History.body integrity", status: "SKIP", evidence: `requires known synthetic expected input/reply; readTurns=${turns?.length ?? 0}; pagedTurns=${pageTurns?.length ?? 0}` });
  for (const view of ["notLoaded", "summary", "full"]) checks.push({ name: `History.${view}`, status: views.has(view) ? "PASS" : "SKIP", evidence: views.has(view) ? "actual response carried this itemsView and shared parser accepted it; merge behavior remains offline evidence" : "not observed in actual responses" });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const batchId = randomUUID();
  await withAcceptanceOutput(options, defaultPaths, batchId, async (output) => {
  const version = execFileSync(options.executable, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!/^codex-cli [\w.+-]+$/.test(version)) throw new ConfigurationError("unexpected CLI version format");
  const environment = { cliVersion: version, cliSha256: createHash("sha256").update(readFileSync(options.executable)).digest("hex"),
    appCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    executionIdentity: userInfo().username, platform: process.platform, osRelease: release(), nodeVersion: process.version };
  const checks: Check[] = [];
  let stderrBytes = 0;
  let protocolWarnings = 0;
  const client = new AppServerClient({ cwd: root, executable: options.executable, requestTimeoutMs: 30_000,
    onStderr: (text) => { stderrBytes += Buffer.byteLength(text); },
    onProtocolWarning: () => { protocolWarnings++; },
  });
  try { await runReadOnly(client, checks, options.threadId); }
  finally { await client.close(); }
  if (protocolWarnings > 0) checks.push({ name: "Connection.protocol warnings", status: "FAIL", evidence: `warnings=${protocolWarnings}; raw output suppressed` });
  if (options.write && !checks.some((c) => c.status === "FAIL" || c.status === "BLOCKED")) {
    await check(checks, "Conversation/Branch.fork reservation", async () => {
      const execution = runRequestedFork(options.write, defaultPaths, batchId, (ownedFd) => {
        const result = spawnSync(process.execPath, ["--experimental-strip-types", resolve(root, "threadpath-protocol/src/fork-smoke.ts")], {
          cwd: resolve(root, "threadpath-protocol"), timeout: 3_600_000, stdio: ["ignore", "pipe", "pipe", ownedFd],
          env: { ...process.env, CODEX_EXECUTABLE: options.executable, CODEX_FORK_SMOKE_CWD: defaultPaths.workspace,
            CODEX_FORK_SMOKE_REPORT: defaultPaths.forkReport, CODEX_FORK_SMOKE_REPORT_FD: "3", CODEX_FORK_SMOKE_BATCH_ID: batchId, CODEX_FORK_SMOKE_COMPACT: "1" },
        });
        return { status: result.status, processError: result.error !== undefined };
      });
      if (execution === undefined) throw new ConfigurationError("write request was not authorized");
      const sameBatch = isJsonObject(execution.childReport) && execution.childReport.executionBatchId === batchId;
      checks.push({ name: "Conversation/Branch.fork smoke", status: sameBatch ? forkStatus(execution.status, execution.processError, execution.childReport, execution.startedAt) : "BLOCKED",
        evidence: "one-shot owned execution; fresh matching-batch report required; this is not the full M6-C matrix" });
      return "exclusive reservation consumed; no rerun permitted regardless of runner result";
    });
  } else checks.push({ name: "Conversation/Branch.fork smoke", status: options.write ? "BLOCKED" : "SKIP", evidence: options.write ? "read-only prerequisite failed" : "write and cost/state approval not supplied" });
  for (const name of ["Conversation.unknown terminal", "Archive.unarchive + archived read + restore", "Observatory.usage + compaction lifecycle + duplicates + fork inheritance"]) checks.push({ name, status: "SKIP", evidence: "not covered by this minimal runner; requires separate evidence; fork smoke does not prove it" });
  const result = { executionBatchId: batchId, verifiedAt: new Date().toISOString(), environment, mode: options.write ? "approved-fork-subset" : "read-only", checks,
    stderrBytes, protocolWarnings, finalResult: "M6_C: NEED_USER_VALIDATION" };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  output?.write(result);
  process.stdout.write(text);
  if (checks.some((c) => c.status === "FAIL" || c.status === "BLOCKED")) process.exitCode = 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(JSON.stringify({ acceptance: failure(error), evidence: "setup/report failure; details suppressed" })); process.exitCode = 1; });
}
