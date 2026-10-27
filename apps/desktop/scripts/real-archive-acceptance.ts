import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { release } from "node:os";
import { AppServerClient } from "../../../threadpath-protocol/src/app-server-client.ts";
import { AppServerError, getThread, isJsonObject, type JsonObject, type JsonValue } from "../../../threadpath-protocol/src/protocol.ts";
import { capturePages, digest, identifyThreads, readEvidenceJson, validateThreadGroup, verifyProjection } from "./real-history-acceptance.ts";
import { verifyApprovedExecutionIdentity } from "./approved-execution-identity.ts";

type Request = (method: string, params: JsonObject) => Promise<JsonValue>;
type Mutation = "thread/unarchive" | "thread/resume" | "thread/archive";
type Status = "PASS" | "FAIL" | "BLOCKED" | "SKIP";
export interface Step { step: string; operation: string; result: Status; reason?: string; category?: string; rpcCode?: number; }
export interface Snapshot { idSha256: string; turnCount: number; itemCount: number; itemIdentitySha256: string; historySha256: string; forkOriginSha256: string; }
interface State { active: boolean; archived: boolean; }
interface Hooks { state: () => Promise<State>; snapshot: () => Promise<Snapshot>; metadataIdentity: () => Promise<void>; reserve: () => void; unexpectedTurns: () => number; }
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workspace = resolve(root, "artifacts/m6c-fork-workspace");
const journalPath = resolve(root, "artifacts/m6c3-archive-recovery.mutations.jsonl");
const cliSha = "00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c";
const c2Sha = "96d5579e7287c24f8e70d27f09736fc3a5cbebdefd7c903d0d6591bd2665adad";
class GateError extends Error { readonly blocked: boolean; constructor(reason: string, blocked = false) { super(reason); this.blocked = blocked; } }
function requireFact(value: unknown, reason: string, blocked = false): asserts value { if (!value) throw new GateError(reason, blocked); }
export function failure(error: unknown): Pick<Step, "result" | "reason" | "category" | "rpcCode"> {
  const category = error instanceof AppServerError ? error.category : error instanceof assert.AssertionError || error instanceof GateError ? "assertion" : "tool";
  const blocked = error instanceof GateError ? error.blocked : ["configuration", "process", "timeout", "network-timeout", "tool"].includes(category)
    || error instanceof Error && /permission|unauthorized|authentication|approval required/i.test(error.message);
  return { result: blocked ? "BLOCKED" : "FAIL", category,
    ...(error instanceof GateError ? { reason: error.message } : {}),
    ...(error instanceof AppServerError && typeof error.code === "number" ? { rpcCode: error.code } : {}) };
}

/** No transport call occurs before scope, stage, budget and durable journal checks. */
export class RecoveryBoundary {
  readonly counts: Record<Mutation, number> = { "thread/unarchive": 0, "thread/resume": 0, "thread/archive": 0 };
  readonly candidates = new Set<string>();
  readonly rpcCounts: Record<string, number> = {};
  private readonly transport: Request;
  private readonly execute: boolean;
  private readonly targetSha: string;
  private readonly beforeMutation: (method: Mutation) => void;
  private selected: string | undefined;
  private armed = false;
  private activeIdentity = false;
  private stopped = false;
  constructor(transport: Request, execute: boolean, targetSha: string, beforeMutation: (method: Mutation) => void = () => {}) {
    this.transport = transport; this.execute = execute; this.targetSha = targetSha; this.beforeMutation = beforeMutation;
  }
  select(id: string): void { requireFact(this.candidates.has(id) && digest(id) === this.targetSha && this.selected === undefined, "target identity not approved", true); this.selected = id; }
  get targetId(): string { requireFact(this.selected, "target identity unavailable", true); return this.selected; }
  arm(): void { requireFact(this.selected, "target identity unavailable", true); this.armed = true; }
  confirmActiveIdentity(): void { requireFact(this.counts["thread/unarchive"] === 1, "unarchive not attempted", true); this.activeIdentity = true; }
  stopFunctionalWrites(): void { this.stopped = true; }
  request: Request = async (method, params) => {
    const mutations: string[] = ["thread/unarchive", "thread/resume", "thread/archive"];
    if (mutations.includes(method)) {
      const mutation = method as Mutation;
      requireFact(this.execute && this.armed && params.threadId === this.selected && this.selected !== undefined, "write mode or exact target not authorized", true);
      requireFact(this.counts[mutation] === 0, "mutation budget exhausted; retry forbidden", true);
      if (mutation === "thread/unarchive") requireFact(!this.stopped && !this.activeIdentity, "unarchive phase closed", true);
      else requireFact(this.activeIdentity && this.counts["thread/unarchive"] === 1 && (mutation === "thread/archive" || !this.stopped), "active identity or functional phase not confirmed", true);
      const keys = Object.keys(params).sort();
      if (mutation === "thread/resume") {
        requireFact(params.excludeTurns === true && params.sandbox === "read-only" && keys.join(",") === "excludeTurns,sandbox,threadId", "resume must be metadata-only with unchanged read-only policy", true);
      } else requireFact(keys.join(",") === "threadId", "unexpected mutation parameters", true);
      // Consumed even if journaling fails or transport times out. Never replay an uncertain write.
      this.counts[mutation]++;
      this.beforeMutation(mutation);
    } else if (method === "thread/list") {
      requireFact(params.cwd === workspace && params.useStateDbOnly === true && typeof params.archived === "boolean", "metadata query not scoped to test workspace", true);
    } else if (method === "thread/read") {
      requireFact(typeof params.threadId === "string" && (params.threadId === this.selected || params.includeTurns === false && this.candidates.has(params.threadId)), "unconfirmed body read", true);
      requireFact(typeof params.includeTurns === "boolean" && Object.keys(params).sort().join(",") === "includeTurns,threadId", "unexpected read parameters", true);
    } else if (method === "thread/turns/list") {
      requireFact(params.threadId === this.selected && this.selected !== undefined && params.itemsView === "full", "unconfirmed full-history query", true);
    } else throw new GateError("RPC not on archive acceptance allowlist", true);
    this.rpcCounts[method] = (this.rpcCounts[method] ?? 0) + 1;
    return this.transport(method, params);
  };
}

export async function runRecovery(boundary: RecoveryBoundary, hooks: Hooks, expected: Omit<Snapshot, "itemIdentitySha256">, execute = false): Promise<{ steps: Step[]; snapshots: Array<{ stage: string; value: Snapshot }>; restored: boolean; finalResult: string }> {
  const steps: Step[] = [];
  const snapshots: Array<{ stage: string; value: Snapshot }> = [];
  let baseline: Snapshot | undefined;
  let restored = false;
  let stage = "A";
  const operations: Record<string, string> = { A: "Archived read", B: "Unarchive", C: "Active read", D: "Metadata-only resume", E: "Rearchive" };
  const equalHistory = (value: Snapshot) => {
    if (baseline) assert.deepEqual(value, baseline, "history identity or body changed");
    else { const { itemIdentitySha256: _items, ...rest } = value; assert.deepEqual(rest, expected, "history differs from C2 evidence"); }
    requireFact(hooks.unexpectedTurns() === 0, "unexpected turn/started observed");
  };
  const waitState = async (archived: boolean): Promise<void> => {
    // Read-only visibility polling; no mutation is retried.
    for (let i = 0; i < 5; i++) {
      const s = await hooks.state();
      if (s.archived === archived && s.active === !archived) return;
      if (i < 4) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new GateError("active/archived visibility did not settle");
  };
  try {
    await waitState(true);
    const initial = await hooks.snapshot(); equalHistory(initial); baseline = initial; snapshots.push({ stage, value: initial });
    steps.push({ step: stage, operation: operations[stage], result: "PASS" });
    if (execute) {
      stage = "B"; hooks.reserve(); boundary.arm();
      const unarchived = await boundary.request("thread/unarchive", { threadId: boundary.targetId });
      requireFact(isJsonObject(unarchived) && isJsonObject(unarchived.thread) && unarchived.thread.id === boundary.targetId, "unarchive response identity differs");
      await waitState(false); await hooks.metadataIdentity(); boundary.confirmActiveIdentity();
      steps.push({ step: stage, operation: operations[stage], result: "PASS" });
      stage = "C"; const active = await hooks.snapshot(); equalHistory(active); snapshots.push({ stage, value: active });
      steps.push({ step: stage, operation: operations[stage], result: "PASS" });
      stage = "D";
      const resumed = await boundary.request("thread/resume", { threadId: boundary.targetId, excludeTurns: true, sandbox: "read-only" });
      requireFact(isJsonObject(resumed) && isJsonObject(resumed.thread) && resumed.thread.id === boundary.targetId && Array.isArray(resumed.thread.turns) && resumed.thread.turns.length === 0, "resume was not the requested metadata-only identity");
      requireFact(isJsonObject(resumed.sandbox) && resumed.sandbox.type === "readOnly", "resume did not confirm read-only policy");
      const afterResume = await hooks.snapshot(); equalHistory(afterResume); snapshots.push({ stage, value: afterResume });
      steps.push({ step: stage, operation: operations[stage], result: "PASS" });
    }
  } catch (error: unknown) { steps.push({ step: stage, operation: operations[stage], ...failure(error) }); }
  finally {
    boundary.stopFunctionalWrites();
    // A failed/uncertain unarchive may already have applied. Only read, then use
    // the remaining one-shot archive if the same active identity is still reliable.
    if (execute && boundary.counts["thread/unarchive"] > 0 && baseline) {
      let archiveError: unknown;
      try {
        const current = await hooks.state();
        requireFact(current.active !== current.archived, "cleanup state ambiguous; no safe archive", true);
        if (current.active) {
          await hooks.metadataIdentity(); boundary.confirmActiveIdentity();
          try {
            const archived = await boundary.request("thread/archive", { threadId: boundary.targetId });
            requireFact(isJsonObject(archived), "invalid archive response");
          } catch (error: unknown) { archiveError = error; }
        }
        await waitState(true);
        const final = await hooks.snapshot(); equalHistory(final); snapshots.push({ stage: "E", value: final }); restored = true;
        if (archiveError !== undefined) steps.push({ step: "E", operation: operations.E, ...failure(archiveError) });
        else steps.push({ step: "E", operation: operations.E, result: boundary.counts["thread/archive"] === 1 ? "PASS" : "SKIP", ...(boundary.counts["thread/archive"] === 0 ? { reason: "original archived state already preserved; archive not sent" } : {}) });
      } catch (error: unknown) { steps.push({ step: "E", operation: operations.E, ...failure(error) }); }
    }
  }
  for (const name of ["A", "B", "C", "D", "E"]) if (!steps.some((s) => s.step === name)) steps.push({ step: name, operation: operations[name], result: execute ? "BLOCKED" : "SKIP", reason: execute ? "prior step did not complete" : "default read-only mode" });
  const finalResult = steps.some((s) => s.result === "FAIL") ? "M6_C3: FAIL" : execute && restored && steps.every((s) => s.result === "PASS") ? "M6_C3: PASS" : "M6_C3: BLOCKED";
  return { steps, snapshots, restored, finalResult };
}

export function parseArchiveOptions(args: string[], journalExists = existsSync(journalPath)): { executable: string; report: string; historyReport: string; executionRecord: string; execute: boolean } {
  const flags = new Set<string>(), values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (["--write", "--confirm-archive-recovery"].includes(key)) { requireFact(!flags.has(key), "duplicate flag", true); flags.add(key); }
    else { const value = args[++i]; requireFact(["--executable", "--report", "--history-report", "--execution-record"].includes(key) && value && !value.startsWith("--") && !values.has(key), "invalid archive acceptance argument", true); values.set(key, value); }
  }
  requireFact(flags.has("--write") === flags.has("--confirm-archive-recovery"), "archive recovery needs both explicit confirmations", true);
  const executable = values.get("--executable"), report = values.get("--report"), historyReport = values.get("--history-report"), executionRecord = values.get("--execution-record");
  requireFact(executable && isAbsolute(executable) && executable.toLowerCase().endsWith(".exe") && report && historyReport && executionRecord, "required archive acceptance arguments missing", true);
  requireFact(!existsSync(resolve(report)), "report already exists; overwrite forbidden", true);
  requireFact(!flags.has("--write") || !journalExists, "prior archive mutation journal exists; no automatic rerun", true);
  return { executable, report: resolve(report), historyReport: resolve(historyReport), executionRecord: resolve(executionRecord), execute: flags.has("--write") };
}

async function main(): Promise<void> {
  const options = parseArchiveOptions(process.argv.slice(2));
  verifyApprovedExecutionIdentity();
  const version = execFileSync(options.executable, ["--version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const binarySha = createHash("sha256").update(readFileSync(options.executable)).digest("hex");
  requireFact(version === "codex-cli 0.163.0-alpha.11" && binarySha === cliSha, "execution environment differs from approval", true);
  requireFact(createHash("sha256").update(readFileSync(options.historyReport)).digest("hex") === c2Sha, "C2 evidence fingerprint differs", true);
  const history = readEvidenceJson(options.historyReport), record = readEvidenceJson(options.executionRecord);
  requireFact(isJsonObject(history) && history.finalResult === "M6_C2: PASS" && history.identityVerified === true && Array.isArray(history.threads) && history.threads.every(isJsonObject) && Array.isArray(history.metrics) && history.metrics.every(isJsonObject) && isJsonObject(history.environment), "C2 evidence incomplete", true);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  requireFact(history.environment.appCommit === head && history.environment.cliSha256 === binarySha, "C2 environment mismatch", true);
  requireFact(isJsonObject(record) && record.exitCode === 0 && typeof record.startedAt === "string" && typeof record.endedAt === "string", "successful C1 execution window missing", true);
  const c2Threads = history.threads;
  const targetEvidence = c2Threads.find((t) => t.role === "historical");
  const originEvidence = c2Threads.find((t) => t.role === "branch");
  const metric = history.metrics.find((m) => m.role === "historical" && m.requestedItemsView === "full");
  requireFact(targetEvidence && typeof targetEvidence.idSha256 === "string" && originEvidence && typeof originEvidence.idSha256 === "string" && metric && typeof metric.bodySha256 === "string" && typeof metric.turnCount === "number" && typeof metric.itemCount === "number", "C2 selected target evidence missing", true);
  const targetSha = targetEvidence.idSha256;
  let journalReserved = false;
  let unexpectedTurns = 0, stderrBytes = 0, warnings = 0;
  const identity: { passed: boolean; selectedRole: string; idSha256: string } = { passed: false, selectedRole: "historical", idSha256: targetSha };
  const client = new AppServerClient({ cwd: root, executable: options.executable, requestTimeoutMs: 30000, onStderr: (s) => { stderrBytes += Buffer.byteLength(s); }, onProtocolWarning: () => { warnings++; } });
  const boundary = new RecoveryBoundary((method, params) => client.request(method, params), options.execute, targetSha, (method) => {
    requireFact(journalReserved, "durable mutation journal not reserved", true);
    appendFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), event: "mutation-attempt", method, targetSha256: targetSha, attempts: boundary.counts[method] })}\n`);
  });
  client.onNotification(({ method, params }) => { if (method === "turn/started" && typeof params.threadId === "string" && digest(params.threadId) === targetSha) unexpectedTurns++; });
  const request = boundary.request;
  const list = async (archived: boolean): Promise<JsonObject[]> => {
    const found: JsonObject[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
    for (let i = 0; ; i++) {
      requireFact(i < 100, "metadata scan bound exceeded", true);
      const response = await request("thread/list", { cwd: workspace, archived, useStateDbOnly: true, limit: 2, modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"], ...(cursor ? { cursor } : {}) });
      requireFact(isJsonObject(response) && Array.isArray(response.data) && response.data.every(isJsonObject), "invalid metadata response");
      found.push(...response.data);
      if (response.nextCursor == null) break;
      requireFact(typeof response.nextCursor === "string" && !cursors.has(response.nextCursor), "metadata cursor repeated"); cursor = response.nextCursor; cursors.add(cursor);
    }
    return found;
  };
  let cycle: Awaited<ReturnType<typeof runRecovery>> | undefined;
  let identityError: ReturnType<typeof failure> | undefined;
  try {
    await client.initialize();
    const active = await list(false), archived = await list(true);
    validateThreadGroup(active, archived, workspace, Date.parse(record.startedAt), Date.parse(record.endedAt));
    const hydrated: JsonObject[] = [];
    for (const indexed of archived) {
      requireFact(typeof indexed.id === "string" && c2Threads.some((t) => t.idSha256 === digest(indexed.id as string) && t.createdAt === new Date(Number(indexed.createdAt) * 1000).toISOString()), "candidate absent from C2 identity record", true);
      boundary.candidates.add(indexed.id);
      const metadata = await request("thread/read", { threadId: indexed.id, includeTurns: false });
      requireFact(isJsonObject(metadata) && isJsonObject(metadata.thread) && metadata.thread.id === indexed.id && metadata.thread.cwd === workspace && Array.isArray(metadata.thread.turns) && metadata.thread.turns.length === 0, "metadata-only candidate identity mismatch", true);
      hydrated.push({ ...metadata.thread, createdAt: indexed.createdAt });
    }
    const identities = identifyThreads(active, hydrated, workspace, Date.parse(record.startedAt), Date.parse(record.endedAt));
    requireFact(identities.every((i) => c2Threads.some((t) => t.role === i.role && t.idSha256 === digest(i.id))), "C2 ancestry identity mismatch", true);
    const selected = identities.find((i) => i.role === "historical"); requireFact(selected, "explicit historical test role missing", true);
    boundary.select(selected.id); identity.passed = true;
    const metadataIdentity = async (): Promise<void> => {
      const value = await request("thread/read", { threadId: boundary.targetId, includeTurns: false });
      requireFact(isJsonObject(value) && isJsonObject(value.thread) && value.thread.id === boundary.targetId && value.thread.cwd === workspace && typeof value.thread.forkedFromId === "string" && digest(value.thread.forkedFromId) === originEvidence.idSha256 && Array.isArray(value.thread.turns) && value.thread.turns.length === 0, "target metadata identity no longer reliable", true);
    };
    const snapshot = async (): Promise<Snapshot> => {
      const value = await request("thread/read", { threadId: boundary.targetId, includeTurns: true });
      requireFact(isJsonObject(value) && isJsonObject(value.thread) && value.thread.id === boundary.targetId && value.thread.cwd === workspace && Array.isArray(value.thread.turns) && value.thread.turns.every(isJsonObject) && typeof value.thread.forkedFromId === "string", "history response identity mismatch");
      const dto = getThread(value); requireFact(dto?.turns, "history response has no turns"); verifyProjection(value.thread.turns, dto.turns);
      const pages = await capturePages(request, boundary.targetId, "full"); const turns = pages.flatMap((p) => p.turns).reverse();
      assert.deepEqual(dto.turns, turns, "thread/read history differs from full pages");
      return { idSha256: digest(boundary.targetId), turnCount: turns.length, itemCount: turns.flatMap((t) => t.items ?? []).length,
        itemIdentitySha256: digest(JSON.stringify(turns.map((t) => ({ turn: t.id, items: (t.items ?? []).map((i) => i.id) })))), historySha256: digest(JSON.stringify(turns)), forkOriginSha256: digest(value.thread.forkedFromId) };
    };
    const knownIds = new Set(identities.map((i) => i.id));
    const state = async (): Promise<State> => {
      const currentActive = await list(false), currentArchived = await list(true);
      const all = [...currentActive, ...currentArchived];
      requireFact(all.length === 3 && new Set(all.map((t) => t.id)).size === 3 && all.every((t) => typeof t.id === "string" && knownIds.has(t.id) && t.cwd === workspace), "test workspace membership changed", true);
      requireFact(currentActive.every((t) => t.id === boundary.targetId) && currentArchived.filter((t) => t.id !== boundary.targetId).length === 2, "another test thread changed state", true);
      return { active: currentActive.some((t) => t.id === boundary.targetId), archived: currentArchived.some((t) => t.id === boundary.targetId) };
    };
    cycle = await runRecovery(boundary, { state, snapshot, metadataIdentity, unexpectedTurns: () => unexpectedTurns, reserve: () => {
      mkdirSync(dirname(journalPath), { recursive: true });
      writeFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), event: "execution-reserved", targetSha256: targetSha, c2ReportSha256: c2Sha, report: options.report })}\n`, { flag: "wx" }); journalReserved = true;
    } }, { idSha256: targetSha, turnCount: metric.turnCount, itemCount: metric.itemCount, historySha256: metric.bodySha256, forkOriginSha256: originEvidence.idSha256 }, options.execute);
  } catch (error: unknown) { identityError = failure(error); }
  finally { await client.close(); }
  const finalResult = identityError ? "M6_C3: BLOCKED" : warnings > 0 || unexpectedTurns > 0 ? "M6_C3: FAIL" : cycle?.finalResult ?? "M6_C3: BLOCKED";
  const report = { verifiedAt: new Date().toISOString(), environment: { cliVersion: version, cliSha256: binarySha, appCommit: head, executionIdentity: "redacted", platform: process.platform, osRelease: release(), nodeVersion: process.version },
    identityGate: identity.passed ? "PASS" : "FAIL", selectedThread: identity, ...(identityError ? { identityError } : {}), mode: options.execute ? "approved-single-thread-recovery" : "read-only", steps: cycle?.steps ?? [], snapshots: cycle?.snapshots ?? [], originalArchivedStateRestored: cycle?.restored ?? false,
    stateMutationAttempts: boundary.counts, rpcCounts: boundary.rpcCounts, turnStartRequests: 0, modelGenerationRequests: 0, unexpectedTurnStartedNotifications: unexpectedTurns, stderrBytes, protocolWarnings: warnings, finalResult };
  mkdirSync(dirname(options.report), { recursive: true }); writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(report, null, 2)); if (finalResult !== "M6_C3: PASS") process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error(JSON.stringify({ finalResult: "M6_C3: BLOCKED", reason: "setup/report failure; raw details suppressed; no automatic retry" })); process.exitCode = 1; });
