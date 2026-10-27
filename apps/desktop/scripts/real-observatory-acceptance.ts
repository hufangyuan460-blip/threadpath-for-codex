import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { release } from "node:os";
import { AppServerClient } from "../../../threadpath-protocol/src/app-server-client.ts";
import { AppServerError, getThread, isJsonObject, type JsonObject, type JsonValue, type Turn } from "../../../threadpath-protocol/src/protocol.ts";
import { parseThreadTokenUsageUpdatedNotification, type ThreadTokenUsageUpdatedNotification } from "../../../threadpath-protocol/src/token-usage.ts";
import { ObservatoryService } from "../src/main/observatory-service.ts";
import { capturePages, digest, identifyThreads, readEvidenceJson, readOnlyBoundary, validateThreadGroup, verifyProjection, type Identity } from "./real-history-acceptance.ts";
import { verifyApprovedExecutionIdentity } from "./approved-execution-identity.ts";

type Status = "PASS" | "FAIL" | "SKIP" | "BLOCKED";
export interface Evidence { capability: string; source: "REAL_SERVER_OBSERVATION" | "LOCAL_REPLAY"; status: Status; detail: string; }
export interface HistoryCapture { identity: Identity; turns: Turn[]; }
interface CompactionEvent { method: "item/started" | "item/completed"; threadId: string; turnId: string; itemId: string; timestampMs: number; }
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workspace = resolve(root, "artifacts/m6c-fork-workspace");
const expectedCliSha = "00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c";
const expectedC2Sha = "96d5579e7287c24f8e70d27f09736fc3a5cbebdefd7c903d0d6591bd2665adad";
const expectedC3Sha = "f7450dcf95da512f8dc6dd028715cafb338ce214ffeb1eb50de827aa5d636f5d";
class GateError extends Error {}
function requireFact(value: unknown, code: string): asserts value { if (!value) throw new GateError(code); }
function shaFile(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
export function observatoryReadBoundary(transport: (method: string, params: JsonObject) => Promise<JsonValue>, confirmed: Set<string>, candidates: Set<string>) {
  const historyRead = readOnlyBoundary(transport, confirmed, candidates);
  return async (method: string, params: JsonObject): Promise<JsonValue> => {
    if (method !== "account/usage/read") return historyRead(method, params);
    requireFact(Object.keys(params).join(",") === "threadId" && typeof params.threadId === "string" && confirmed.has(params.threadId), "estimated metadata query must be thread-scoped and confirmed");
    return transport(method, params);
  };
}
export function usageParams(event: ThreadTokenUsageUpdatedNotification): JsonObject {
  return { threadId: event.threadId, turnId: event.turnId, tokenUsage: { total: { ...event.tokenUsage.total }, last: { ...event.tokenUsage.last }, modelContextWindow: event.tokenUsage.modelContextWindow } };
}

/** Receives only actual transport callbacks in the live runner. Replay uses separate stores. */
export class ScopedObservations {
  private readonly confirmed: Set<string>;
  private readonly bound: number;
  private readonly usage: ThreadTokenUsageUpdatedNotification[] = [];
  private readonly compactions: CompactionEvent[] = [];
  private readonly fallback = new ObservatoryService();
  invalidUsage = 0; invalidCompaction = 0; excluded = 0; overflow = 0;
  private invalidDowngradeCount = 0;
  constructor(confirmed: Set<string>, bound = 128) { this.confirmed = confirmed; this.bound = bound; }
  observe(method: string, params: JsonObject): void {
    if (!["thread/tokenUsage/updated", "item/started", "item/completed"].includes(method)) return;
    if (typeof params.threadId !== "string" || !this.confirmed.has(params.threadId)) { this.excluded++; return; }
    if (method !== "thread/tokenUsage/updated" && (!isJsonObject(params.item) || params.item.type !== "contextCompaction")) return;
    if (this.usage.length + this.compactions.length >= this.bound) { this.overflow++; return; }
    if (method === "thread/tokenUsage/updated") {
      try { this.usage.push(parseThreadTokenUsageUpdatedNotification(params)); }
      catch { this.invalidUsage++; this.fallback.observeNotification(method, params); const state = this.fallback.get(params.threadId); if (state.usage === null && state.usageError === "invalid-payload") this.invalidDowngradeCount++; }
    } else {
      const at = params[method === "item/started" ? "startedAtMs" : "completedAtMs"];
      if (typeof params.turnId !== "string" || !isJsonObject(params.item) || typeof params.item.id !== "string" || !params.item.id.trim() || typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) { this.invalidCompaction++; return; }
      this.compactions.push({ method: method as CompactionEvent["method"], threadId: params.threadId, turnId: params.turnId, itemId: params.item.id, timestampMs: at });
    }
  }
  finish(histories: HistoryCapture[]): { usages: ThreadTokenUsageUpdatedNotification[]; summary: JsonObject } {
    const owners = new Map(histories.map((h) => [h.identity.id, new Set(h.turns.map((t) => t.id))]));
    const usage = this.usage.filter((u) => owners.get(u.threadId)?.has(u.turnId));
    const items = new Set(histories.flatMap((h) => h.turns.flatMap((t) => (t.items ?? []).filter((i) => i.type === "contextCompaction").map((i) => JSON.stringify([h.identity.id, t.id, i.id])))));
    const events = this.compactions.filter((e) => items.has(JSON.stringify([e.threadId, e.turnId, e.itemId])));
    const grouped = new Map<string, Set<string>>();
    for (const e of events) { const key = JSON.stringify([e.threadId, e.turnId, e.itemId]); const methods = grouped.get(key) ?? new Set(); methods.add(e.method); grouped.set(key, methods); }
    const store = new ObservatoryService();
    let consecutiveDuplicates = 0, duplicateIdempotencyFailures = 0;
    const previous = new Map<string, string>();
    for (const u of usage) {
      const canonical = usageParams(u), fingerprint = digest(JSON.stringify(canonical)); const before = store.get(u.threadId);
      store.observeNotification("thread/tokenUsage/updated", canonical);
      if (previous.get(u.threadId) === fingerprint) { if (store.get(u.threadId) !== before) duplicateIdempotencyFailures++; consecutiveDuplicates++; }
      previous.set(u.threadId, fingerprint);
    }
    return { usages: usage, summary: {
      acceptedUsageNotifications: usage.length, invalidUsageNotifications: this.invalidUsage, invalidCompactionNotifications: this.invalidCompaction,
      acceptedCompactionNotifications: events.length, matchedCompactionLifecycles: [...grouped.values()].filter((v) => v.has("item/started") && v.has("item/completed")).length,
      consecutiveDuplicateUsageSnapshots: consecutiveDuplicates, duplicateIdempotencyFailures, invalidUsageDegradedToUnknown: this.invalidUsage === 0 ? null : this.invalidDowngradeCount === this.invalidUsage,
      nullContextWindowNotifications: usage.filter((u) => u.tokenUsage.modelContextWindow === null).length,
      excludedUnconfirmedOrUnscopedNotifications: this.excluded, outsideCapturedHistory: this.usage.length - usage.length + this.compactions.length - events.length, overflow: this.overflow,
      usagePayloads: usage.map((u) => ({ threadSha256: digest(u.threadId), turnSha256: digest(u.turnId), snapshotSha256: digest(JSON.stringify(u.tokenUsage)), sixBreakdownFieldsValidated: true, windowType: u.tokenUsage.modelContextWindow === null ? "null" : "number" })),
      compactionEvents: events.map((e) => ({ method: e.method, threadSha256: digest(e.threadId), turnSha256: digest(e.turnId), itemSha256: digest(e.itemId), timestampType: typeof e.timestampMs })),
    } };
  }
}

export function realCapabilities(summary: JsonObject, historyVerified: boolean): Evidence[] {
  const row = (capability: string, status: Status, detail: string): Evidence => ({ capability, source: "REAL_SERVER_OBSERVATION", status, detail });
  const hasUsage = Number(summary.acceptedUsageNotifications) > 0;
  return [
    row("Token Usage notification", Number(summary.invalidUsageNotifications) > 0 ? "FAIL" : hasUsage ? "PASS" : "BLOCKED", hasUsage ? "actual scoped notification parsed; six fields required in total and last" : "no trustworthy saved payload or scoped notification in the bounded read-only observation window; no activity authorized"),
    row("total / last / modelContextWindow", Number(summary.invalidUsageNotifications) > 0 ? "FAIL" : hasUsage ? "PASS" : "BLOCKED", "total is cumulative, last is latest snapshot, window is model-reported size; no context occupancy or cost arithmetic"),
    row("Null context window", Number(summary.nullContextWindowNotifications) > 0 ? "PASS" : "SKIP", "only an actual null sample counts; schema/offline null tests are not server evidence"),
    row("Duplicate notification", Number(summary.duplicateIdempotencyFailures) > 0 ? "FAIL" : Number(summary.consecutiveDuplicateUsageSnapshots) > 0 ? "PASS" : "SKIP", "no duplicate is inferred from silence or manufactured server events; actual duplicate changes are failures"),
    row("Resume snapshot", "BLOCKED", "resume RPC prohibited; client resumed labels and fixture tests are not proof of server replay"),
    row("Fork usage inheritance", "BLOCKED", "no trustworthy before/after fork usage samples; totals do not prove extra consumption"),
    row("Compaction item history", historyVerified ? "PASS" : "BLOCKED", "actual archived full-history item identity/type and parser projection; history does not establish lifecycle completion"),
    row("Compaction live lifecycle", Number(summary.invalidCompactionNotifications) > 0 ? "FAIL" : Number(summary.matchedCompactionLifecycles) > 0 ? "PASS" : "BLOCKED", "requires actual item/started and item/completed with the same thread/turn/item identity; derived replay envelopes never count"),
  ];
}

export function replayHistory(histories: HistoryCapture[], usage: ThreadTokenUsageUpdatedNotification[]): Evidence[] {
  const result: Evidence[] = [];
  const pass = (capability: string, detail: string) => result.push({ capability, source: "LOCAL_REPLAY", status: "PASS", detail });
  const store = new ObservatoryService();
  for (const h of histories) {
    store.observeHistory(h.identity.id, h.turns); const before = store.get(h.identity.id);
    store.observeHistory(h.identity.id, h.turns); store.observeHistory(h.identity.id, [...h.turns].reverse());
    assert.deepEqual(store.get(h.identity.id), before, "actual history duplicate changed revision");
    const expectedKeys = new Set(h.turns.flatMap((t) => (t.items ?? []).filter((i) => i.type === "contextCompaction").map((i) => JSON.stringify([t.id, i.id]))));
    assert.equal(before.compactions.length, expectedKeys.size, "history compaction was lost or duplicated");
    requireFact(before.compactions.every((i) => i.status === "unknown" && i.source === "history"), "history incorrectly inferred completion");
    assert.equal(before.usage, null, "history manufactured usage counters");
  }
  pass("Real history repetition/reordering", "unchanged revision and deduplicated identity; ended history remains unknown; no usage fabricated");
  const withCompaction = histories.filter((h) => h.turns.some((t) => t.items?.some((i) => i.type === "contextCompaction")));
  requireFact(withCompaction.length === 1, "expected exactly one branch containing historical compaction");
  for (const h of histories.filter((h) => !withCompaction.includes(h))) assert.equal(store.get(h.identity.id).compactions.length, 0, "compaction leaked between threads");
  pass("History thread isolation", "only the actual branch owning the historical item contains that record; inherited turn IDs do not mix states");
  const h = withCompaction[0]; const turn = h.turns.find((t) => t.items?.some((i) => i.type === "contextCompaction"))!;
  const item = turn.items!.find((i) => i.type === "contextCompaction")!;
  // Identities/item come from real history; these event envelopes/timestamps are
  // deliberately generated locally and never enter ScopedObservations.
  const params: JsonObject = { threadId: h.identity.id, turnId: turn.id, item: { id: item.id!, type: "contextCompaction" }, startedAtMs: 0, completedAtMs: 1 };
  const local = new ObservatoryService();
  local.observeNotification("item/started", params); const started = local.get(h.identity.id);
  local.observeNotification("item/started", params); assert.equal(local.get(h.identity.id), started);
  local.observeNotification("item/completed", params); const completed = local.get(h.identity.id);
  local.observeNotification("item/completed", params); local.observeHistory(h.identity.id, h.turns); local.observeNotification("item/started", params);
  assert.equal(local.get(h.identity.id), completed, "history or late/duplicate event downgraded completed");
  requireFact(completed.compactions.length === 1 && completed.compactions[0].status === "completed", "local lifecycle association failed");
  pass("Derived lifecycle duplicate/late-start replay", "SYNTHETIC_ENVELOPE_FROM_REAL_HISTORY: started/completed identities deduplicate and completed survives history unknown; not a captured live lifecycle");
  const reversed = new ObservatoryService(); reversed.observeNotification("item/completed", params); reversed.observeNotification("item/started", params);
  assert.equal(reversed.get(h.identity.id).compactions[0]?.status, "completed");
  const incomplete = new ObservatoryService(); incomplete.observeNotification("item/started", params); incomplete.disconnected();
  assert.equal(incomplete.get(h.identity.id).compactions[0]?.status, "unknown"); assert.equal(incomplete.get(h.identity.id).usage, null);
  pass("Derived out-of-order/disconnect replay", "SYNTHETIC_ENVELOPE_FROM_REAL_HISTORY: completed-before-start is stable; missing completion becomes unknown, not failed/completed or token savings");
  if (usage.length === 0) {
    for (const capability of ["Usage duplicate/revision/receivedAt", "Client resumed provenance", "Usage null/unknown/missing-field variants"]) result.push({ capability, source: "LOCAL_REPLAY", status: "SKIP", detail: "no actual Usage payload captured; existing synthetic unit tests reported separately" });
  } else {
    const event = usage[0]; const canonical = usageParams(event);
    const u = new ObservatoryService(); u.observeNotification("thread/tokenUsage/updated", canonical); const initial = u.get(event.threadId);
    u.observeNotification("thread/tokenUsage/updated", canonical); assert.equal(u.get(event.threadId), initial);
    pass("Usage duplicate/revision/receivedAt", "same captured absolute snapshot is not accumulated and does not refresh revision/receivedAt");
    const r = new ObservatoryService(); r.beginResume(event.threadId); r.observeNotification("thread/tokenUsage/updated", canonical); assert.equal(r.get(event.threadId).usage, null); r.completeResume(event.threadId);
    const resumed = r.get(event.threadId); assert.equal(resumed.usage?.source, "resumed"); r.observeNotification("thread/tokenUsage/updated", canonical); assert.equal(r.get(event.threadId), resumed);
    pass("Client resumed provenance", "local begin/complete methods only; identical replay retains client resumed label, revision and receivedAt; no resume RPC executed");
    const withUnknown = { ...canonical, unknown: "synthetic-extra" }; assert.deepEqual(parseThreadTokenUsageUpdatedNotification(withUnknown), event);
    const nullWindow = { ...canonical, tokenUsage: { ...canonical.tokenUsage as JsonObject, modelContextWindow: null } }; assert.equal(parseThreadTokenUsageUpdatedNotification(nullWindow).tokenUsage.modelContextWindow, null);
    const missing = { ...canonical, tokenUsage: { last: {}, modelContextWindow: null } }; assert.throws(() => parseThreadTokenUsageUpdatedNotification(missing)); u.observeNotification("thread/tokenUsage/updated", missing); assert.equal(u.get(event.threadId).usageError, "invalid-payload");
    pass("Usage null/unknown/missing-field variants", "locally modified captured payloads only; unknown extras dropped, null accepted, invalid required fields degrade to unknown; not observed server variants");
  }
  return result;
}

export function parseObservatoryOptions(args: string[]): { executable: string; historyReport: string; archiveReport: string; executionRecord: string; report: string } {
  const allowed = ["--executable", "--history-report", "--archive-report", "--execution-record", "--report"], values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) { const key = args[i], value = args[++i]; requireFact(allowed.includes(key) && value && !value.startsWith("--") && !values.has(key), "invalid read-only observatory option"); values.set(key, value); }
  requireFact(allowed.every((key) => values.has(key)), "required observatory options missing");
  const executable = values.get("--executable")!; requireFact(isAbsolute(executable) && executable.toLowerCase().endsWith(".exe"), "native executable path required");
  const report = resolve(values.get("--report")!); requireFact(!existsSync(report), "report exists; overwrite forbidden");
  return { executable, report, historyReport: resolve(values.get("--history-report")!), archiveReport: resolve(values.get("--archive-report")!), executionRecord: resolve(values.get("--execution-record")!) };
}

async function main(): Promise<void> {
  const options = parseObservatoryOptions(process.argv.slice(2));
  verifyApprovedExecutionIdentity();
  const version = execFileSync(options.executable, ["--version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  requireFact(version === "codex-cli 0.163.0-alpha.11" && shaFile(options.executable) === expectedCliSha, "execution environment differs from reviewed baseline");
  requireFact(shaFile(options.historyReport) === expectedC2Sha && shaFile(options.archiveReport) === expectedC3Sha, "prior C2/C3 evidence changed");
  const c2 = readEvidenceJson(options.historyReport), c3 = readEvidenceJson(options.archiveReport), record = readEvidenceJson(options.executionRecord);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  requireFact(isJsonObject(c2) && c2.finalResult === "M6_C2: PASS" && c2.identityVerified === true && isJsonObject(c2.environment) && c2.environment.appCommit === head && Array.isArray(c2.threads) && c2.threads.every(isJsonObject) && Array.isArray(c2.metrics) && c2.metrics.every(isJsonObject), "C2 evidence invalid");
  requireFact(isJsonObject(c3) && c3.finalResult === "M6_C3: PASS" && c3.originalArchivedStateRestored === true && isJsonObject(c3.environment) && c3.environment.appCommit === head, "C3 original state not confirmed");
  requireFact(isJsonObject(record) && record.exitCode === 0 && typeof record.startedAt === "string" && typeof record.endedAt === "string", "successful C1 identity window unavailable");
  const known = c2.threads, metrics = c2.metrics;
  const confirmed = new Set<string>(), candidates = new Set<string>();
  const observations = new ScopedObservations(confirmed);
  const rpcCounts: Record<string, number> = {};
  let stderrBytes = 0, warnings = 0, identityVerified = false;
  const client = new AppServerClient({ cwd: root, executable: options.executable, requestTimeoutMs: 30000, onStderr: (s) => { stderrBytes += Buffer.byteLength(s); }, onProtocolWarning: () => { warnings++; } });
  const request = observatoryReadBoundary(async (method, params) => { rpcCounts[method] = (rpcCounts[method] ?? 0) + 1; return client.request(method, params); }, confirmed, candidates);
  client.onNotification(({ method, params }) => observations.observe(method, params));
  const histories: HistoryCapture[] = [], historyItems: JsonObject[] = [], historyChecks: Evidence[] = [], estimatedMetadata: JsonObject[] = [];
  let captureError: { category: string; reason?: string } | undefined;
  try {
    await client.initialize();
    const list = async (archived: boolean): Promise<JsonObject[]> => {
      const rows: JsonObject[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
      for (let i = 0; ; i++) {
        requireFact(i < 100, "identity metadata bound exceeded");
        const response = await request("thread/list", { cwd: workspace, archived, limit: 2, useStateDbOnly: true, modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"], ...(cursor ? { cursor } : {}) });
        requireFact(isJsonObject(response) && Array.isArray(response.data) && response.data.every(isJsonObject), "invalid metadata page"); rows.push(...response.data);
        if (response.nextCursor == null) break; requireFact(typeof response.nextCursor === "string" && !cursors.has(response.nextCursor), "repeated metadata cursor"); cursor = response.nextCursor; cursors.add(cursor);
      }
      return rows;
    };
    const active = await list(false), archived = await list(true);
    validateThreadGroup(active, archived, workspace, Date.parse(record.startedAt), Date.parse(record.endedAt));
    const hydrated: JsonObject[] = [];
    for (const row of archived) {
      requireFact(typeof row.id === "string" && known.some((k) => k.idSha256 === digest(row.id as string) && k.createdAt === new Date(Number(row.createdAt) * 1000).toISOString()), "candidate absent from C2 identity record");
      candidates.add(row.id);
      const raw = await request("thread/read", { threadId: row.id, includeTurns: false });
      requireFact(isJsonObject(raw) && isJsonObject(raw.thread) && raw.thread.id === row.id && raw.thread.cwd === workspace && Array.isArray(raw.thread.turns) && raw.thread.turns.length === 0, "candidate metadata identity mismatch");
      hydrated.push({ ...raw.thread, createdAt: row.createdAt });
    }
    const identities = identifyThreads(active, hydrated, workspace, Date.parse(record.startedAt), Date.parse(record.endedAt));
    requireFact(identities.every((i) => known.some((k) => k.role === i.role && k.idSha256 === digest(i.id))), "C2 ancestry identity mismatch");
    identities.forEach((i) => confirmed.add(i.id)); identityVerified = true;
    for (const identity of identities) {
      const raw = await request("thread/read", { threadId: identity.id, includeTurns: true });
      requireFact(isJsonObject(raw) && isJsonObject(raw.thread) && raw.thread.id === identity.id && raw.thread.cwd === workspace && Array.isArray(raw.thread.turns) && raw.thread.turns.every(isJsonObject), "history identity mismatch");
      const dto = getThread(raw); requireFact(dto?.turns, "history missing turns"); verifyProjection(raw.thread.turns, dto.turns);
      const pages = await capturePages(request, identity.id, "full"); const turns = pages.flatMap((p) => p.turns).reverse();
      assert.deepEqual(dto.turns, turns, "read/page body differs");
      const old = metrics.find((m) => m.role === identity.role && m.requestedItemsView === "full");
      requireFact(old && old.bodySha256 === digest(JSON.stringify(turns)) && old.turnCount === turns.length, "history differs from C2 fingerprint");
      histories.push({ identity, turns });
      for (const turn of raw.thread.turns) for (const item of Array.isArray(turn.items) ? turn.items : []) if (isJsonObject(item) && item.type === "contextCompaction") {
        historyItems.push({ role: identity.role, threadSha256: digest(identity.id), turnSha256: digest(String(turn.id)), itemSha256: digest(String(item.id)), knownFields: ["id", "type"].filter((k) => Object.hasOwn(item, k)), historyStatusFieldPresent: Object.hasOwn(item, "status"), parentTurnCompleted: turn.status === "completed" });
      }
      historyChecks.push({ capability: `${identity.role}: archived full history and parser`, source: "REAL_SERVER_OBSERVATION", status: "PASS", detail: `turns=${turns.length}; C2 body fingerprint unchanged; direct usage field present=${Object.hasOwn(raw.thread, "tokenUsage")}` });
      // A separate estimated-usage API, never converted into notification snapshots
      // or a billing ledger. Do not inspect/persist account summary or amounts.
      try {
        const estimated = await request("account/usage/read", { threadId: identity.id });
        requireFact(isJsonObject(estimated), "invalid estimated metadata response");
        if (estimated.threadUsage == null) estimatedMetadata.push({ role: identity.role, source: "REAL_SERVER_OBSERVATION", status: "SKIP", detail: "thread estimate unavailable; no account-wide fallback attempted" });
        else {
          requireFact(isJsonObject(estimated.threadUsage) && estimated.threadUsage.threadId === identity.id && Array.isArray(estimated.threadUsage.groups) && estimated.threadUsage.groups.every(isJsonObject), "estimated metadata identity or structure mismatch");
          const groups = estimated.threadUsage.groups;
          estimatedMetadata.push({ role: identity.role, source: "REAL_SERVER_OBSERVATION", status: "PASS", detail: "thread-scoped estimate structure only; not total/last/window notification evidence", groupCount: groups.length, amountValuesPersisted: false,
            groups: groups.map((g) => ({ tokenFieldTypes: Object.fromEntries(["netNewInputTokens", "cachedInputTokens", "inputTokens", "outputTokens", "totalTokens"].map((k) => [k, g[k] === null ? "null" : typeof g[k]])) })) });
        }
      } catch (error: unknown) {
        estimatedMetadata.push({ role: identity.role, source: "REAL_SERVER_OBSERVATION", status: error instanceof GateError ? "FAIL" : "BLOCKED", detail: error instanceof GateError ? error.message : "thread-scoped estimated metadata RPC failed; no fallback or retry", category: error instanceof AppServerError ? error.category : "tool", ...(error instanceof AppServerError && typeof error.code === "number" ? { rpcCode: error.code } : {}) });
      }
    }
    requireFact(historyItems.length === 1 && historyItems[0].role === "branch", "known historical compaction membership differs");
    // Bounded grace only. No resume, subscriptions via RPC, model or compaction requests.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const endActive = await list(false), endArchived = await list(true);
    validateThreadGroup(endActive, endArchived, workspace, Date.parse(record.startedAt), Date.parse(record.endedAt));
    requireFact(endArchived.every((t) => typeof t.id === "string" && confirmed.has(t.id)), "ending archive identity changed");
  } catch (error: unknown) { captureError = { category: error instanceof AppServerError ? error.category : error instanceof assert.AssertionError ? "assertion" : "gate", ...(error instanceof GateError ? { reason: error.message } : {}) }; }
  finally { await client.close(); }
  const captured = observations.finish(histories);
  const realResults = realCapabilities(captured.summary, !captureError && historyItems.length === 1);
  let localReplay: Evidence[] = [];
  if (!captureError) {
    try { localReplay = replayHistory(histories, captured.usages); }
    catch { localReplay.push({ capability: "History/derived replay", source: "LOCAL_REPLAY", status: "FAIL", detail: "local replay assertion failed; raw payload suppressed" }); }
  }
  const protocolFailure = identityVerified && captureError !== undefined && ["protocol", "assertion"].includes(captureError.category) || realResults.some((r) => r.status === "FAIL") || localReplay.some((r) => r.status === "FAIL") || estimatedMetadata.some((r) => r.status === "FAIL") || warnings > 0;
  const finalResult = protocolFailure ? "M6_C4: COMPATIBILITY_FIX_REQUIRED" : captureError || !identityVerified || Number(captured.summary.overflow) > 0 || Number(captured.summary.outsideCapturedHistory) > 0 ? "M6_C4: BLOCKED" : realResults.some((r) => r.status !== "PASS") ? "M6_C4: NEED_APPROVAL" : "M6_C4: PASS";
  const report = { verifiedAt: new Date().toISOString(), environment: { cliVersion: version, cliSha256: expectedCliSha, appCommit: head, executionIdentity: "redacted", nodeVersion: process.version, osRelease: release(), platform: process.platform },
    existingEvidence: { c1SavedUsagePayloads: 0, c1SavedLiveCompactionPayloads: 0, c2Sha256: expectedC2Sha, c3Sha256: expectedC3Sha, schemaIsNotRuntimeEvidence: true }, identityVerified,
    ...(captureError ? { captureError } : {}), historyChecks, compactionHistoryItems: historyItems, estimatedThreadMetadata: estimatedMetadata, realProtocolResults: realResults, notificationObservation: captured.summary, localReplay,
    rpcCounts, passiveGraceMs: 500, stateChangingRpcCount: 0, modelGenerationRequests: 0, stderrBytes, protocolWarnings: warnings,
    usageSemantics: { total: "cumulative server-reported token usage", last: "latest server snapshot, not guaranteed per-turn cost", modelContextWindow: "model-reported window or null", derivedOccupancyOrCosts: false }, finalResult };
  mkdirSync(dirname(options.report), { recursive: true }); writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" }); console.log(JSON.stringify(report, null, 2));
  if (!["M6_C4: PASS", "M6_C4: NEED_APPROVAL"].includes(finalResult)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error(JSON.stringify({ finalResult: "M6_C4: BLOCKED", detail: "setup/report failure; raw details suppressed; no write mode exists" })); process.exitCode = 1; });
