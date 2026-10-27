import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { release } from "node:os";
import { AppServerClient } from "../../../threadpath-protocol/src/app-server-client.ts";
import { AppServerError, getThread, isJsonObject, ProtocolError, type JsonObject, type Turn } from "../../../threadpath-protocol/src/protocol.ts";
import { parseThreadTokenUsageUpdatedNotification } from "../../../threadpath-protocol/src/token-usage.ts";
import { ObservatoryService } from "../src/main/observatory-service.ts";
import { capturePages, digest, identifyThreads, readEvidenceJson, validateThreadGroup, verifyProjection } from "./real-history-acceptance.ts";
import { failure, RecoveryBoundary, runRecovery, type Snapshot, type Step } from "./real-archive-acceptance.ts";
import { usageParams } from "./real-observatory-acceptance.ts";
import { verifyApprovedExecutionIdentity } from "./approved-execution-identity.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workspace = resolve(root, "artifacts/m6c-fork-workspace");
const journalPath = resolve(root, "artifacts/m6c4a-resume-usage.mutations.jsonl");
const cliSha = "00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c";
const c2Sha = "96d5579e7287c24f8e70d27f09736fc3a5cbebdefd7c903d0d6591bd2665adad";
const c3Sha = "f7450dcf95da512f8dc6dd028715cafb338ce214ffeb1eb50de827aa5d636f5d";
const c4Sha = "ef87535f2bab7d6d5a7f033a5487d00df9535620b7d2c6e252a7f765986f0af6";
class ProbeError extends Error {}
function requireFact(value: unknown, code: string): asserts value { if (!value) throw new ProbeError(code); }
function shaFile(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

/** Pure in-memory observer. begin/acknowledge/cancel do not send any RPC. */
export class ResumeUsageProbe {
  readonly records: JsonObject[] = [];
  readonly knownTurns = new Set<string>();
  invalidPayloads = 0; scopeMismatches = 0; excluded = 0; overflow = 0; duplicateFailures = 0;
  unknownTurnStarted = 0; historicalTurnStarted = 0;
  listenerReady = false; begun = false; acknowledged = false;
  eligibleUsageCount = 0; preResumeUsageCount = 0;
  private readonly target: string;
  private readonly windowMs: number;
  private readonly store = new ObservatoryService();
  private phase: "pre-resume" | "before-response" | "after-response" | "closed" = "pre-resume";
  private previous: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done: Promise<void> = Promise.resolve();
  private resolveDone: () => void = () => {};
  private atAcknowledgement: JsonObject | null = null;
  private atClose: JsonObject | null = null;
  private startedAt: string | null = null;
  private acknowledgedAt: string | null = null;
  private closedAt: string | null = null;
  constructor(target: string, windowMs = 5000) { requireFact(Number.isFinite(windowMs) && windowMs >= 0 && windowMs <= 5000, "invalid probe window"); this.target = target; this.windowMs = windowMs; }
  clientState(): JsonObject {
    const state = this.store.get(this.target);
    return { revision: state.revision, source: state.usage?.source ?? null, receivedAt: state.usage?.receivedAt ?? null, usageKnown: state.usage !== null, usageError: state.usageError ?? null };
  }
  markListenerReady(): void { this.listenerReady = true; }
  begin(): void {
    requireFact(this.listenerReady && this.knownTurns.size > 0 && !this.begun && this.phase === "pre-resume", "listener/history not ready or probe already begun");
    this.begun = true; this.phase = "before-response"; this.startedAt = new Date().toISOString();
    this.store.beginResume(this.target);
    this.done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
  }
  acknowledge(): void {
    requireFact(this.begun && !this.acknowledged && this.phase === "before-response", "unexpected resume acknowledgement");
    this.acknowledged = true; this.phase = "after-response"; this.acknowledgedAt = new Date().toISOString();
    this.store.completeResume(this.target); this.atAcknowledgement = this.clientState();
    this.timer = setTimeout(() => this.close(), this.windowMs);
  }
  async waitForWindow(): Promise<void> { requireFact(this.acknowledged, "resume not acknowledged"); await this.done; }
  close(): void {
    if (this.phase === "closed") return;
    if (this.timer) clearTimeout(this.timer);
    this.store.cancelResume(this.target); this.phase = "closed"; this.closedAt = new Date().toISOString();
    this.atClose = this.clientState(); this.resolveDone();
  }
  observe(method: string, params: JsonObject): void {
    if (!this.listenerReady || this.phase === "closed") return;
    if (method === "turn/started" && params.threadId === this.target) {
      const turnId = typeof params.turnId === "string" ? params.turnId : isJsonObject(params.turn) ? params.turn.id : undefined;
      if (typeof turnId === "string" && this.knownTurns.has(turnId)) this.historicalTurnStarted++; else this.unknownTurnStarted++;
      return;
    }
    if (method !== "thread/tokenUsage/updated") return;
    if (params.threadId !== this.target) { this.excluded++; return; }
    if (this.records.length >= 128) { this.overflow++; return; }
    const receivedAt = new Date().toISOString();
    let event: ReturnType<typeof parseThreadTokenUsageUpdatedNotification>;
    try { event = parseThreadTokenUsageUpdatedNotification(params); }
    catch {
      this.invalidPayloads++; this.store.observeNotification(method, params);
      this.records.push({ source: "REAL_SERVER_OBSERVATION", phase: this.phase, receivedAt, parserAccepted: false, threadMatches: true, turnIdType: typeof params.turnId, tokenUsageObjectPresent: isJsonObject(params.tokenUsage), clientState: this.clientState() });
      return;
    }
    if (!this.knownTurns.has(event.turnId)) { this.scopeMismatches++; return; }
    const canonical = usageParams(event); const fingerprint = digest(JSON.stringify(canonical));
    const before = this.store.get(this.target); this.store.observeNotification(method, canonical); const after = this.store.get(this.target);
    const comparableDuplicate = this.previous === fingerprint && before.usage !== null && after.usage !== null && before.usage.source === after.usage.source && before.usage.stale === after.usage.stale;
    const stable = comparableDuplicate ? before.revision === after.revision && before.usage?.receivedAt === after.usage?.receivedAt : null;
    if (stable === false) this.duplicateFailures++;
    this.previous = fingerprint;
    if (this.begun) this.eligibleUsageCount++; else this.preResumeUsageCount++;
    this.records.push({ source: "REAL_SERVER_OBSERVATION", phase: this.phase, receivedAt, parserAccepted: true, threadSha256: digest(event.threadId), turnSha256: digest(event.turnId), snapshotSha256: digest(JSON.stringify(event.tokenUsage)),
      tokenUsage: { total: { ...event.tokenUsage.total }, last: { ...event.tokenUsage.last }, modelContextWindow: event.tokenUsage.modelContextWindow },
      duplicateStable: stable, clientState: this.clientState() });
  }
  summary(): JsonObject {
    return { listenerReadyBeforeResume: this.listenerReady && this.begun, acknowledged: this.acknowledged, windowMsAfterResponse: this.windowMs,
      resumeStartedAt: this.startedAt, acknowledgedAt: this.acknowledgedAt, closedAt: this.closedAt, eligibleUsageNotifications: this.eligibleUsageCount, preResumeUsageNotifications: this.preResumeUsageCount,
      invalidPayloads: this.invalidPayloads, scopeMismatches: this.scopeMismatches, excludedOtherThreadEvents: this.excluded, overflow: this.overflow, duplicateIdempotencyFailures: this.duplicateFailures,
      unknownTurnStartedSignals: this.unknownTurnStarted, historicalTurnStartedSignals: this.historicalTurnStarted,
      observatoryAtAcknowledgement: this.atAcknowledgement, observatoryAtWindowClose: this.atClose, records: this.records,
      provenanceMeaning: "resumed is a client observation label after validated RPC acknowledgement, not a server replay guarantee" };
  }
}

export function resumeVerdict(execute: boolean, identity: boolean, steps: Step[], restored: boolean, summary: JsonObject, warnings = 0): string {
  if (steps.some((s) => s.result === "FAIL") || Number(summary.invalidPayloads) > 0 || Number(summary.duplicateIdempotencyFailures) > 0 || warnings > 0) return "RESUME_USAGE: FAIL";
  if (!execute || !identity || !restored || !["A", "B", "C", "D", "E"].every((name) => steps.some((s) => s.step === name && s.result === "PASS")) || steps.some((s) => s.result === "BLOCKED" || s.result === "SKIP") || summary.acknowledged !== true || Number(summary.scopeMismatches) > 0 || Number(summary.overflow) > 0 || Number(summary.unknownTurnStartedSignals) > 0) return "RESUME_USAGE: BLOCKED";
  return Number(summary.eligibleUsageNotifications) > 0 ? "RESUME_USAGE: PASS" : "RESUME_USAGE: NOT_OBSERVED";
}
export function parseProbeOptions(args: string[], journalExists = existsSync(journalPath)) {
  const flags = new Set<string>(), values = new Map<string, string>();
  const keys = ["--executable", "--history-report", "--archive-report", "--observatory-report", "--execution-record", "--report"];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (["--write", "--confirm-resume-usage"].includes(key)) { requireFact(!flags.has(key), "duplicate probe flag"); flags.add(key); }
    else { const value = args[++i]; requireFact(keys.includes(key) && value && !value.startsWith("--") && !values.has(key), "invalid probe argument"); values.set(key, value); }
  }
  requireFact(keys.every((k) => values.has(k)) && flags.has("--write") === flags.has("--confirm-resume-usage"), "probe options or explicit confirmation missing");
  const executable = values.get("--executable")!; requireFact(isAbsolute(executable) && executable.toLowerCase().endsWith(".exe"), "absolute native CLI required");
  const execute = flags.has("--write"); const report = resolve(values.get("--report")!);
  requireFact(!existsSync(report), "report exists; overwrite forbidden"); requireFact(!execute || !journalExists, "prior probe execution journal exists; no rerun");
  return { executable, execute, report, historyReport: resolve(values.get("--history-report")!), archiveReport: resolve(values.get("--archive-report")!), observatoryReport: resolve(values.get("--observatory-report")!), executionRecord: resolve(values.get("--execution-record")!) };
}

async function main(): Promise<void> {
  const options = parseProbeOptions(process.argv.slice(2));
  verifyApprovedExecutionIdentity();
  const version = execFileSync(options.executable, ["--version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  requireFact(version === "codex-cli 0.163.0-alpha.11" && shaFile(options.executable) === cliSha, "environment differs from approved probe");
  requireFact(shaFile(options.historyReport) === c2Sha && shaFile(options.archiveReport) === c3Sha && shaFile(options.observatoryReport) === c4Sha, "prior evidence fingerprint mismatch");
  const c2 = readEvidenceJson(options.historyReport), c3 = readEvidenceJson(options.archiveReport), c4 = readEvidenceJson(options.observatoryReport), record = readEvidenceJson(options.executionRecord);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  requireFact(isJsonObject(c2) && c2.finalResult === "M6_C2: PASS" && isJsonObject(c2.environment) && c2.environment.appCommit === head && Array.isArray(c2.threads) && c2.threads.every(isJsonObject) && Array.isArray(c2.metrics) && c2.metrics.every(isJsonObject), "C2 identity evidence unavailable");
  requireFact(isJsonObject(c3) && c3.finalResult === "M6_C3: PASS" && c3.originalArchivedStateRestored === true && isJsonObject(c4) && c4.identityVerified === true && c4.stateChangingRpcCount === 0, "prior original state not confirmed");
  requireFact(isJsonObject(record) && record.exitCode === 0 && typeof record.startedAt === "string" && typeof record.endedAt === "string", "successful C1 execution window missing");
  const known = c2.threads; const target = known.find((t) => t.role === "source"); const metric = c2.metrics.find((m) => m.role === "source" && m.requestedItemsView === "full");
  requireFact(target && typeof target.idSha256 === "string" && metric && typeof metric.turnCount === "number" && typeof metric.itemCount === "number" && typeof metric.bodySha256 === "string", "explicit source evidence missing");
  const targetSha = target.idSha256; let reserved = false, identityPassed = false, stderrBytes = 0, warnings = 0;
  let probe: ResumeUsageProbe | undefined; let unsubscribe: (() => void) | undefined;
  let lastState: { active: boolean; archived: boolean } | null = null;
  const client = new AppServerClient({ cwd: root, executable: options.executable, requestTimeoutMs: 30000, onStderr: (s) => { stderrBytes += Buffer.byteLength(s); }, onProtocolWarning: () => { warnings++; } });
  const boundary = new RecoveryBoundary(async (method, params) => {
    try {
      const response = await client.request(method, params);
      if (method === "thread/resume") {
        if (!isJsonObject(response) || !isJsonObject(response.thread) || response.thread.id !== boundary.targetId || response.thread.cwd !== workspace || !Array.isArray(response.thread.turns) || response.thread.turns.length !== 0 || !isJsonObject(response.sandbox) || response.sandbox.type !== "readOnly") throw new ProtocolError("resume acknowledgement identity/policy/metadata mismatch");
        probe!.acknowledge();
      }
      return response;
    } catch (error: unknown) { if (method === "thread/resume") probe?.close(); throw error; }
  }, options.execute, targetSha, (method) => {
    requireFact(reserved, "durable probe budget not reserved");
    appendFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), method, targetSha256: targetSha, attempt: boundary.counts[method] })}\n`);
    if (method === "thread/resume") probe!.begin();
  });
  const request = boundary.request;
  const list = async (archived: boolean): Promise<JsonObject[]> => {
    const rows: JsonObject[] = [], cursors = new Set<string>(); let cursor: string | undefined;
    for (let i = 0; ; i++) {
      requireFact(i < 100, "metadata bound exceeded");
      const r = await request("thread/list", { cwd: workspace, archived, limit: 2, useStateDbOnly: true, modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"], ...(cursor ? { cursor } : {}) });
      requireFact(isJsonObject(r) && Array.isArray(r.data) && r.data.every(isJsonObject), "invalid metadata page"); rows.push(...r.data);
      if (r.nextCursor == null) break; requireFact(typeof r.nextCursor === "string" && !cursors.has(r.nextCursor), "repeated metadata cursor"); cursor = r.nextCursor; cursors.add(cursor);
    }
    return rows;
  };
  let cycle: Awaited<ReturnType<typeof runRecovery>> | undefined; let gateError: ReturnType<typeof failure> | undefined;
  try {
    await client.initialize(); const active = await list(false), archived = await list(true);
    validateThreadGroup(active, archived, workspace, Date.parse(record.startedAt), Date.parse(record.endedAt));
    const hydrated: JsonObject[] = [];
    for (const row of archived) {
      requireFact(typeof row.id === "string" && known.some((k) => k.idSha256 === digest(row.id as string) && k.createdAt === new Date(Number(row.createdAt) * 1000).toISOString()), "candidate absent from C2 record");
      boundary.candidates.add(row.id); const r = await request("thread/read", { threadId: row.id, includeTurns: false });
      requireFact(isJsonObject(r) && isJsonObject(r.thread) && r.thread.id === row.id && r.thread.cwd === workspace && Array.isArray(r.thread.turns) && r.thread.turns.length === 0, "candidate metadata identity mismatch"); hydrated.push({ ...r.thread, createdAt: row.createdAt });
    }
    const identities = identifyThreads(active, hydrated, workspace, Date.parse(record.startedAt), Date.parse(record.endedAt));
    requireFact(identities.every((i) => known.some((k) => k.role === i.role && k.idSha256 === digest(i.id))), "C2 ancestry mismatch");
    const selected = identities.find((i) => i.role === "source"); requireFact(selected, "source role absent"); boundary.select(selected.id); identityPassed = true; probe = new ResumeUsageProbe(selected.id);
    const metadataIdentity = async (): Promise<void> => {
      const r = await request("thread/read", { threadId: boundary.targetId, includeTurns: false });
      requireFact(isJsonObject(r) && isJsonObject(r.thread) && r.thread.id === boundary.targetId && r.thread.cwd === workspace && r.thread.forkedFromId === null && Array.isArray(r.thread.turns) && r.thread.turns.length === 0, "source metadata identity no longer reliable");
      const status = r.thread.status; requireFact(status !== "active" && !(isJsonObject(status) && status.type === "active"), "source has an active writer; unsafe to proceed");
      if (!probe!.listenerReady && boundary.counts["thread/unarchive"] === 1 && boundary.counts["thread/resume"] === 0) { unsubscribe = client.onNotification(({ method, params }) => probe!.observe(method, params)); probe!.markListenerReady(); }
    };
    const snapshot = async (): Promise<Snapshot> => {
      if (boundary.counts["thread/resume"] === 1 && boundary.counts["thread/archive"] === 0 && probe!.acknowledged) await probe!.waitForWindow();
      const r = await request("thread/read", { threadId: boundary.targetId, includeTurns: true });
      requireFact(isJsonObject(r) && isJsonObject(r.thread) && r.thread.id === boundary.targetId && r.thread.cwd === workspace && r.thread.forkedFromId === null && Array.isArray(r.thread.turns) && r.thread.turns.every(isJsonObject), "source history identity mismatch");
      const dto = getThread(r); requireFact(dto?.turns, "missing source history"); verifyProjection(r.thread.turns, dto.turns);
      const pages = await capturePages(request, boundary.targetId, "full"), turns = pages.flatMap((p) => p.turns).reverse(); assert.deepEqual(dto.turns, turns, "read/full pages differ");
      if (probe!.knownTurns.size === 0) for (const turn of turns) probe!.knownTurns.add(turn.id);
      return { idSha256: digest(boundary.targetId), turnCount: turns.length, itemCount: turns.flatMap((t) => t.items ?? []).length, itemIdentitySha256: digest(JSON.stringify(turns.map((t) => ({ turn: t.id, items: (t.items ?? []).map((i) => i.id) })))), historySha256: digest(JSON.stringify(turns)), forkOriginSha256: digest("null") };
    };
    const ids = new Set(identities.map((i) => i.id));
    const state = async () => {
      const a = await list(false), b = await list(true), all = [...a, ...b];
      requireFact(all.length === 3 && new Set(all.map((r) => r.id)).size === 3 && all.every((r) => typeof r.id === "string" && ids.has(r.id) && r.cwd === workspace), "workspace membership changed");
      requireFact(a.every((r) => r.id === boundary.targetId) && b.filter((r) => r.id !== boundary.targetId).length === 2, "other test thread state changed");
      const value = { active: a.some((r) => r.id === boundary.targetId), archived: b.some((r) => r.id === boundary.targetId) }; lastState = value; return value;
    };
    cycle = await runRecovery(boundary, { state, snapshot, metadataIdentity, unexpectedTurns: () => probe!.unknownTurnStarted, reserve: () => {
      mkdirSync(dirname(journalPath), { recursive: true }); writeFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), event: "C4A-execution-reserved", targetRole: "source", targetSha256: targetSha, report: options.report, limits: { unarchive: 1, resume: 1, archive: 1, threadStart: 0, turnStart: 0, fork: 0, compact: 0 } })}\n`, { flag: "wx" }); reserved = true;
    } }, { idSha256: targetSha, turnCount: metric.turnCount, itemCount: metric.itemCount, historySha256: metric.bodySha256, forkOriginSha256: digest("null") }, options.execute);
  } catch (error: unknown) { gateError = failure(error); }
  finally { probe?.close(); unsubscribe?.(); await client.close(); }
  const observation = probe?.summary() ?? {};
  const finalResult = gateError ? "RESUME_USAGE: BLOCKED" : resumeVerdict(options.execute, identityPassed, cycle?.steps ?? [], cycle?.restored ?? false, observation, warnings);
  const report = { verifiedAt: new Date().toISOString(), environment: { cliVersion: version, cliSha256: cliSha, appCommit: head, executionIdentity: "redacted", osRelease: release(), nodeVersion: process.version },
    authorization: { independentlyConfirmedByUser: options.execute, phase: "C4A only", limits: { unarchive: 1, resume: 1, archive: 1, threadStart: 0, turnStart: 0, fork: 0, compact: 0 } }, identityGate: identityPassed ? "PASS" : "FAIL", selectedRole: "source", selectedIdSha256: targetSha,
    ...(gateError ? { gateError } : {}), rpcCounts: boundary.rpcCounts, mutationAttempts: boundary.counts, realUsageNotifications: observation, archiveRecoverySteps: cycle?.steps ?? [], historySnapshots: cycle?.snapshots ?? [],
    originalStateAndHistoryRestored: cycle?.restored ?? false, lastObservedListState: lastState, localReplay: { performedInLiveRun: false, syntheticTestsAreNotServerEvidence: true }, modelGenerationRequests: 0, turnStartRequests: 0, stderrBytes, protocolWarnings: warnings,
    notObservedMeaning: "no eligible notification in this bounded resume window; does not establish protocol non-support", finalResult, m6c4: "INCOMPLETE" };
  mkdirSync(dirname(options.report), { recursive: true }); writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" }); console.log(JSON.stringify(report, null, 2));
  if (!["RESUME_USAGE: PASS", "RESUME_USAGE: NOT_OBSERVED"].includes(finalResult)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error(JSON.stringify({ finalResult: "RESUME_USAGE: BLOCKED", reason: "setup/report failure; raw details suppressed; no retry" })); process.exitCode = 1; });
