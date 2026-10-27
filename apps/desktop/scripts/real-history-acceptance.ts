import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { release } from "node:os";
import { AppServerClient } from "../../../threadpath-protocol/src/app-server-client.ts";
import { AppServerError, getThread, getTurnPage, isJsonObject, type JsonObject, type JsonValue, type Thread, type Turn, type TurnPage } from "../../../threadpath-protocol/src/protocol.ts";
import { ConversationService, mergeConversationTurns, type ConversationClient } from "../src/main/conversation-service.ts";
import type { ConversationThreadView } from "../src/shared/api.ts";
import { verifyApprovedExecutionIdentity } from "./approved-execution-identity.ts";

type View = "notLoaded" | "summary" | "full";
type Role = "source" | "branch" | "historical";
type Status = "PASS" | "FAIL" | "BLOCKED" | "SKIP";
type Request = (method: string, params: JsonObject) => Promise<JsonValue>;
export interface Identity { id: string; role: Role; createdAt: number; }
export interface Evidence { name: string; source: "real-rpc" | "local-replay-of-real-responses"; status: Status; detail?: string; category?: string; rpcCode?: number; }
interface Capture { identity: Identity; metadata: Thread; read: Thread; pages: Partial<Record<View, TurnPage[]>>; }
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workspace = resolve(root, "artifacts/m6c-fork-workspace");
const views: View[] = ["notLoaded", "summary", "full"];
const expectedSha = "00c0f1e4099246fddcd67ec620ca8ed50827c7d70e113b7224f7a2933cf2d67c";
const format = 'Return only a JSON object with exactly the keys "base", "source", "branch", each a string or null. Use only the state established in this conversation. Do not call tools, inspect files, or change the workspace.';
class InvariantError extends Error {}
function requireFact(value: unknown, code: string): asserts value { if (!value) throw new InvariantError(code); }
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function readEvidenceJson(path: string): unknown { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
function samePath(a: string, b: string): boolean { return normalize(a).toLowerCase() === normalize(b).toLowerCase(); }
function timestamp(value: JsonValue | undefined): number {
  return typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
}

export function validateThreadGroup(active: JsonObject[], archived: JsonObject[], cwd: string, start: number, end: number): void {
  requireFact(Number.isFinite(start) && Number.isFinite(end) && start < end, "IDENTITY_BLOCKED: invalid execution window");
  requireFact(active.length === 0 && archived.length === 3, "IDENTITY_BLOCKED: expected exactly three archived threads and zero active threads");
  const ids = new Set<string>();
  for (const t of archived) {
    requireFact(typeof t.id === "string" && t.id.trim() && !ids.has(t.id), "IDENTITY_BLOCKED: invalid or duplicate identity");
    ids.add(t.id);
    requireFact(typeof t.cwd === "string" && samePath(t.cwd, cwd), "IDENTITY_BLOCKED: unexpected workspace");
    requireFact(timestamp(t.createdAt) >= Math.floor(start / 1000) * 1000 && timestamp(t.createdAt) <= end, "IDENTITY_BLOCKED: creation outside approved execution");
    requireFact(t.archived !== false, "IDENTITY_BLOCKED: archived filter contradiction");
  }
}

export function identifyThreads(active: JsonObject[], archived: JsonObject[], cwd: string, start: number, end: number): Identity[] {
  validateThreadGroup(active, archived, cwd, start, end);
  const source = archived.filter((t) => t.forkedFromId == null);
  requireFact(source.length === 1, "IDENTITY_BLOCKED: source chain is ambiguous");
  const branch = archived.filter((t) => t.forkedFromId === source[0].id);
  requireFact(branch.length === 1, "IDENTITY_BLOCKED: branch chain is ambiguous");
  const historical = archived.filter((t) => t.forkedFromId === branch[0].id);
  requireFact(historical.length === 1 && historical[0].id !== source[0].id, "IDENTITY_BLOCKED: historical chain is ambiguous");
  return [source[0], branch[0], historical[0]].map((t, i) => ({ id: t.id as string, role: (["source", "branch", "historical"] as const)[i], createdAt: timestamp(t.createdAt) }));
}

export function readOnlyBoundary(request: Request, confirmed: Set<string>, metadataCandidates: Set<string> = new Set()): Request {
  return async (method, params) => {
    requireFact(["thread/list", "thread/read", "thread/turns/list"].includes(method), "forbidden RPC");
    if (method === "thread/list") {
      requireFact(params.cwd === workspace && params.useStateDbOnly === true, "unscoped metadata query");
    } else requireFact(typeof params.threadId === "string" && (confirmed.has(params.threadId) || method === "thread/read" && params.includeTurns === false && metadataCandidates.has(params.threadId)), "unconfirmed thread body blocked");
    return request(method, params);
  };
}

export function verifyProjection(raw: JsonObject[], parsed: Turn[], requested?: View): void {
  requireFact(raw.length === parsed.length, "parser dropped a turn");
  raw.forEach((turn, index) => {
    const dto = parsed[index];
    requireFact(dto.id === turn.id && dto.itemsView === turn.itemsView, "parser changed turn identity or itemsView");
    if (requested) requireFact(turn.itemsView === requested, "server returned a different itemsView");
    requireFact(Array.isArray(turn.items), "server omitted items array");
    requireFact((dto.items?.length ?? 0) === turn.items.length, "parser dropped an item");
    turn.items.forEach((item, itemIndex) => {
      requireFact(isJsonObject(item), "server returned invalid item");
      const projected = dto.items![itemIndex];
      requireFact(projected.id === item.id && projected.type === item.type, "parser changed item identity");
      for (const key of ["text", "content"] as const) if (item[key] !== undefined) assert.deepEqual(projected[key], item[key], "parser lost text or content");
      // Do not silently claim all full bodies survived if non-empty reasoning text was discarded.
      if (item.type === "reasoning" && Array.isArray(item.summary) && item.summary.some((s) => typeof s === "string" && s.length > 0)) {
        assert.deepEqual(projected.summary, item.summary, "parser lost reasoning summary");
      }
    });
  });
}

export async function capturePages(request: Request, threadId: string, view: View): Promise<TurnPage[]> {
  const pages: TurnPage[] = [];
  const cursors = new Set<string>();
  const turns = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; ; i++) {
    requireFact(i < 100, "pagination bound exceeded");
    const response = await request("thread/turns/list", { threadId, itemsView: view, sortDirection: "desc", limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    requireFact(isJsonObject(response) && Array.isArray(response.data) && response.data.every(isJsonObject), "invalid turn page structure");
    const page = getTurnPage(response);
    verifyProjection(response.data, page.turns, view);
    requireFact(page.turns.length <= 1, "server ignored limit=1");
    for (const t of page.turns) { requireFact(!turns.has(t.id), "duplicate turn across actual pages"); turns.add(t.id); }
    pages.push(page);
    if (response.nextCursor == null) { requireFact(page.nextCursor === undefined, "parser invented next cursor"); break; }
    requireFact(typeof response.nextCursor === "string" && response.nextCursor.length > 0 && !cursors.has(response.nextCursor), "invalid or repeated cursor");
    requireFact(page.nextCursor === response.nextCursor && page.turns.length > 0, "cursor changed or empty continuing page");
    cursor = response.nextCursor; cursors.add(cursor);
  }
  return pages;
}
function allTurns(pages: TurnPage[]): Turn[] { return pages.flatMap((p) => p.turns).reverse(); }
export function itemText(item: { text?: string; content?: JsonValue }): string {
  if (item.text !== undefined) return item.text;
  if (Array.isArray(item.content)) return item.content.map((p) => isJsonObject(p) && typeof p.text === "string" ? p.text : "").join("");
  return typeof item.content === "string" ? item.content : "";
}
function messages(turn: Turn, type: string): string { return (turn.items ?? []).filter((i) => i.type === type).map(itemText).join(""); }
export function verifySyntheticHistory(source: Turn[], branch: Turn[], historical: Turn[]): { conversationTurns: number[]; compactionItems: number } {
  const userTurns = (turns: Turn[]) => turns.filter((t) => (t.items ?? []).some((i) => i.type === "userMessage"));
  const groups = [source, branch, historical].map(userTurns);
  assert.deepEqual(groups.map((g) => g.length), [3, 4, 2], "known synthetic conversation membership differs");
  const first = messages(groups[0][0], "userMessage");
  const match = /^Start a synthetic state test\. Set base to "(BASE_([a-f0-9]{32}))"; source and branch are null\. Remember these values\.\n/.exec(first);
  requireFact(match, "synthetic base marker not found");
  const base = match[1], sourceMarker = `SOURCE_${match[2]}`, branchMarker = `BRANCH_${match[2]}`;
  const reportPrompt = `Report the current state without changing it.\n${format}`;
  const expectedPrompts = [
    [first, `Set source to "${sourceMarker}". Leave base and branch unchanged.\n${format}`, reportPrompt],
    [first, `Set branch to "${branchMarker}". Leave base and source unchanged.\n${format}`, reportPrompt, reportPrompt],
    [first, reportPrompt],
  ];
  requireFact(first === `Start a synthetic state test. Set base to "${base}"; source and branch are null. Remember these values.\n${format}`, "synthetic seed prompt differs");
  groups.forEach((group, groupIndex) => group.forEach((turn, i) => {
    requireFact(turn.itemsView === "full", "body comparison requires actual full view");
    assert.equal(messages(turn, "userMessage"), expectedPrompts[groupIndex][i], "synthetic prompt missing or altered");
    const text = messages(turn, "agentMessage").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const reply: unknown = JSON.parse(text);
    assert.deepEqual(reply, { base, source: groupIndex === 0 && i > 0 ? sourceMarker : null, branch: groupIndex === 1 && i > 0 ? branchMarker : null }, "synthetic reply missing or altered");
  }));
  requireFact(groups[0][0].id === groups[1][0].id && groups[0][0].id === groups[2][0].id, "inherited base turn identity differs");
  assert.deepEqual(groups[0][0].items, groups[1][0].items, "fork changed shared full body");
  assert.deepEqual(groups[0][0].items, groups[2][0].items, "historical fork changed shared full body");
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
    const unique = new Set(groups[a].slice(1).map((t) => t.id));
    requireFact(groups[b].slice(1).every((t) => !unique.has(t.id)), "fork-only turn crossed branch boundary");
  }
  return { conversationTurns: groups.map((g) => g.length), compactionItems: branch.flatMap((t) => t.items ?? []).filter((i) => i.type === "contextCompaction").length };
}

export function replayClient(read: (id: string) => Promise<Thread>, page: (id: string, cursor?: string) => Promise<TurnPage>): ConversationClient {
  const forbidden = async (): Promise<never> => { throw new InvariantError("mutating replay operation forbidden"); };
  return { listThreads: async () => [], readThread: read, listTurns: (id, options) => page(id, options?.cursor),
    startThread: forbidden, resumeThread: forbidden, forkThread: forbidden, startTurn: forbidden, interruptTurn: forbidden,
    onNotification: () => () => undefined, threadReadOrder: "oldest-first", turnPageOrder: "newest-first" };
}
function pageAt(capture: Capture, view: View, cursor?: string): TurnPage {
  const pages = capture.pages[view]; requireFact(pages, "captured view unavailable");
  const index = cursor === undefined ? 0 : pages.findIndex((p) => p.nextCursor === cursor) + 1;
  requireFact(index >= 0 && index < pages.length && (cursor === undefined || index > 0), "unknown replay cursor");
  return structuredClone(pages[index]);
}
async function complete(service: ConversationService, id: string): Promise<ConversationThreadView> {
  let view = await service.readThread(id);
  for (let i = 0; view.paging.hasMore; i++) { requireFact(i < 100, "replay bound exceeded"); view = await service.loadMoreTurns(id); }
  return view;
}
function textSnapshot(view: ConversationThreadView): unknown {
  return view.turns.map((t) => ({ id: t.id, items: t.items.filter((i) => i.kind === "text").map((i) => ({ id: i.id, text: i.text, completeness: i.bodyCompleteness })) }));
}
export async function verifyReplay(captures: Capture[]): Promise<string[]> {
  let mode: View = "notLoaded";
  const byId = new Map(captures.map((c) => [c.identity.id, c]));
  const find = (id: string) => { const c = byId.get(id); requireFact(c, "unconfirmed replay identity"); return c; };
  const client = replayClient(async (id) => structuredClone(find(id).metadata), async (id, cursor) => pageAt(find(id), mode, cursor));
  const service = new ConversationService({ getReadyClient: () => client });
  const results: string[] = [];
  const fullViews = new Map<string, ConversationThreadView>();
  for (const c of captures) {
    mode = "notLoaded"; const unloaded = await complete(service, c.identity.id);
    requireFact(unloaded.turns.every((t) => t.itemsView === "notLoaded" && t.items.length === 0), "unloaded body falsely marked loaded");
    mode = "summary"; const summary = await complete(service, c.identity.id);
    requireFact(summary.turns.every((t) => t.itemsView === "summary" && t.items.every((i) => i.bodyCompleteness !== "full")), "summary falsely marked full");
    mode = "full"; const full = await complete(service, c.identity.id);
    requireFact(full.turns.every((t) => t.itemsView === "full"), "full body completeness lost");
    for (const turn of allTurns(c.pages.full!)) for (const item of turn.items ?? []) {
      if (item.type !== "userMessage" && item.type !== "agentMessage") continue;
      const displayed = full.turns.find((t) => t.id === turn.id)?.items.find((i) => i.id === item.id);
      requireFact(displayed?.kind === "text" && displayed.text === itemText(item), "desktop projection lost actual body");
    }
    fullViews.set(c.identity.id, full);
    mode = "summary"; const downgraded = await complete(service, c.identity.id);
    assert.deepEqual(textSnapshot(downgraded), textSnapshot(full), "summary overwrote captured full text");
    assert.deepEqual(mergeConversationTurns(full.turns, full.turns.slice(0, 2)), full.turns, "overlapping captured page duplicated or changed turns");
  }
  results.push("notLoaded -> summary -> full", "full -> summary retains full bodies", "overlapping captured pages deduplicate");
  for (const c of captures) {
    mode = "full"; const switched = await complete(service, c.identity.id);
    requireFact(switched.id === c.identity.id, "thread switch identity leaked");
    assert.deepEqual(textSnapshot(switched), textSnapshot(fullViews.get(c.identity.id)!), "thread switch body changed");
  }
  results.push("thread switching and inherited turn identity isolation");
  const c = captures[0];
  let releaseOld!: (thread: Thread) => void;
  let calls = 0;
  const delayed = replayClient(async () => ++calls === 1 ? new Promise<Thread>((resolve) => { releaseOld = resolve; }) : structuredClone(c.metadata), async (_id, cursor) => pageAt(c, "full", cursor));
  const ordered = new ConversationService({ getReadyClient: () => delayed });
  const old = ordered.readThread(c.identity.id);
  const rejected = assert.rejects(old, /superseded/);
  const newest = await complete(ordered, c.identity.id);
  releaseOld(structuredClone(c.metadata)); await rejected;
  assert.deepEqual(ordered.getLoadedThread(c.identity.id), newest, "late captured response changed current history");
  let releasePage!: (page: TurnPage) => void;
  let holdPage = true;
  const paging = replayClient(async () => structuredClone(c.metadata), async (_id, cursor) => cursor !== undefined && holdPage ? new Promise<TurnPage>((resolve) => { releasePage = resolve; }) : pageAt(c, "full", cursor));
  const paged = new ConversationService({ getReadyClient: () => paging });
  const initial = await paged.readThread(c.identity.id);
  requireFact(initial.paging.hasMore, "captured source has no pagination for late-page check");
  const late = paged.loadMoreTurns(c.identity.id); const rejectedPage = assert.rejects(late, /superseded/);
  holdPage = false; const current = await complete(paged, c.identity.id);
  releasePage(pageAt(c, "full", initial.paging.nextCursor)); await rejectedPage;
  assert.deepEqual(paged.getLoadedThread(c.identity.id), current, "late captured page changed current history");
  results.push("late older read rejected", "late older page rejected");
  return results;
}

export function parseHistoryOptions(args: string[]): { executable: string; report: string; executionRecord: string } {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    requireFact(["--executable", "--report", "--execution-record"].includes(key) && value && !value.startsWith("--") && !options.has(key), "invalid history acceptance arguments");
    options.set(key, value);
  }
  const executable = options.get("--executable"), report = options.get("--report"), executionRecord = options.get("--execution-record");
  requireFact(executable && isAbsolute(executable) && executable.toLowerCase().endsWith(".exe") && report && executionRecord, "required history acceptance arguments missing");
  requireFact(!existsSync(resolve(report)), "report already exists; overwrite forbidden");
  return { executable, report: resolve(report), executionRecord: resolve(executionRecord) };
}

async function main(): Promise<void> {
  const options = parseHistoryOptions(process.argv.slice(2));
  verifyApprovedExecutionIdentity();
  const version = execFileSync(options.executable, ["--version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const binarySha = createHash("sha256").update(readFileSync(options.executable)).digest("hex");
  requireFact(version === "codex-cli 0.163.0-alpha.11" && binarySha === expectedSha, "environment differs from approved history run");
  const environment = { cliVersion: version, cliSha256: binarySha, appCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), executionIdentity: "redacted", nodeVersion: process.version, platform: process.platform, osRelease: release() };
  const checks: Evidence[] = [];
  const metrics: JsonObject[] = [];
  const rpcCounts: Record<string, number> = {};
  let stderrBytes = 0, warnings = 0;
  let identityPassed = false;
  const identities: Identity[] = [];
  const captures: Capture[] = [];
  const client = new AppServerClient({ cwd: root, executable: options.executable, requestTimeoutMs: 30000, onStderr: (t) => { stderrBytes += Buffer.byteLength(t); }, onProtocolWarning: () => { warnings++; } });
  const confirmed = new Set<string>();
  const metadataCandidates = new Set<string>();
  const request = readOnlyBoundary(async (method, params) => { rpcCounts[method] = (rpcCounts[method] ?? 0) + 1; return client.request(method, params); }, confirmed, metadataCandidates);
  const check = async <T>(name: string, source: Evidence["source"], run: () => Promise<T>): Promise<T | undefined> => {
    try { const result = await run(); checks.push({ name, source, status: "PASS" }); return result; }
    catch (error: unknown) {
      const category = error instanceof AppServerError ? error.category : error instanceof assert.AssertionError || error instanceof InvariantError ? "assertion" : "unexpected";
      checks.push({ name, source, status: name === "identity" || ["configuration", "process", "timeout", "network-timeout"].includes(category) ? "BLOCKED" : "FAIL", category,
        ...(error instanceof InvariantError ? { detail: error.message } : {}), ...(error instanceof AppServerError && typeof error.code === "number" ? { rpcCode: error.code } : {}) });
      return undefined;
    }
  };
  try {
    const initialized = await check("initialize", "real-rpc", async () => { await client.initialize(); return true; });
    const found = initialized && await check("identity", "real-rpc", async () => {
      const record = readEvidenceJson(options.executionRecord);
      const previous = readEvidenceJson(resolve(root, "artifacts/m6c-fork-report.json"));
      requireFact(isJsonObject(record) && typeof record.startedAt === "string" && typeof record.endedAt === "string" && record.exitCode === 0 && typeof record.reportPath === "string", "IDENTITY_BLOCKED: missing successful execution record");
      const aggregate = readEvidenceJson(record.reportPath);
      requireFact(isJsonObject(aggregate) && isJsonObject(aggregate.environment) && aggregate.mode === "approved-fork-subset" && aggregate.environment.cliSha256 === expectedSha && aggregate.environment.appCommit === environment.appCommit, "IDENTITY_BLOCKED: prior environment mismatch");
      requireFact(isJsonObject(previous) && previous.passed === true && previous.createdThreadCount === 3 && previous.archivePassed === true && typeof previous.verifiedAt === "string" && Date.parse(previous.verifiedAt) >= Date.parse(record.startedAt) && Date.parse(previous.verifiedAt) <= Date.parse(record.endedAt), "IDENTITY_BLOCKED: prior fork evidence mismatch");
      const list = async (archived: boolean) => {
        const result: JsonObject[] = []; const seen = new Set<string>(); let cursor: string | undefined;
        for (let i = 0; ; i++) {
          requireFact(i < 100, "IDENTITY_BLOCKED: metadata scan bound exceeded");
          const response = await request("thread/list", { cwd: workspace, archived, useStateDbOnly: true, limit: 2, modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"], ...(cursor ? { cursor } : {}) });
          requireFact(isJsonObject(response) && Array.isArray(response.data) && response.data.every(isJsonObject), "IDENTITY_BLOCKED: invalid metadata response");
          result.push(...response.data);
          if (response.nextCursor == null) break;
          requireFact(typeof response.nextCursor === "string" && !seen.has(response.nextCursor), "IDENTITY_BLOCKED: repeated metadata cursor");
          cursor = response.nextCursor; seen.add(cursor);
        }
        return result;
      };
      const active = await list(false), archived = await list(true);
      const start = Date.parse(record.startedAt), end = Date.parse(record.endedAt);
      validateThreadGroup(active, archived, workspace, start, end);
      const hydrated: JsonObject[] = [];
      for (const listed of archived) {
        metadataCandidates.add(listed.id as string);
        const response = await request("thread/read", { threadId: listed.id, includeTurns: false });
        requireFact(isJsonObject(response) && isJsonObject(response.thread) && response.thread.id === listed.id && response.thread.cwd === listed.cwd && Array.isArray(response.thread.turns) && response.thread.turns.length === 0, "IDENTITY_BLOCKED: metadata hydration mismatch or unexpected bodies");
        metrics.push({ name: "identity metadata hydration", listForkSourceNull: listed.forkedFromId == null, readForkSourcePresent: typeof response.thread.forkedFromId === "string", bodyCount: 0 });
        hydrated.push({ ...response.thread, createdAt: listed.createdAt });
      }
      return identifyThreads(active, hydrated, workspace, start, end);
    });
    if (found) {
      identities.push(...found); found.forEach((t) => confirmed.add(t.id)); identityPassed = true;
      for (const identity of identities) {
        const capture: Capture = { identity, metadata: { id: identity.id }, read: { id: identity.id }, pages: {} }; captures.push(capture);
        for (const includeTurns of [false, true]) await check(`${identity.role}.thread/read.${includeTurns ? "history" : "metadata"}`, "real-rpc", async () => {
          const response = await request("thread/read", { threadId: identity.id, includeTurns });
          requireFact(isJsonObject(response) && isJsonObject(response.thread) && response.thread.id === identity.id && typeof response.thread.cwd === "string" && samePath(response.thread.cwd, workspace), "read identity or cwd differs");
          const dto = getThread(response); requireFact(dto && Array.isArray(response.thread.turns), "invalid history read");
          requireFact(response.thread.turns.every(isJsonObject), "invalid raw turn identity");
          verifyProjection(response.thread.turns, dto.turns ?? []);
          if (includeTurns) capture.read = dto; else { requireFact((dto.turns?.length ?? 0) === 0, "metadata read unexpectedly returned bodies"); capture.metadata = dto; }
          metrics.push({ role: identity.role, method: "thread/read", includeTurns, turnCount: dto.turns?.length ?? 0, historyMode: dto.historyMode ?? "unreported", itemsViews: (dto.turns ?? []).map((t) => t.itemsView ?? "unreported") });
        });
        for (const view of views) await check(`${identity.role}.itemsView.${view}`, "real-rpc", async () => {
          const pages = await capturePages(request, identity.id, view); capture.pages[view] = pages;
          metrics.push({ role: identity.role, requestedItemsView: view, pages: pages.length, turnCount: allTurns(pages).length, itemCount: allTurns(pages).flatMap((t) => t.items ?? []).length, bodySha256: digest(JSON.stringify(allTurns(pages))), cursorConsumed: pages.length > 1, terminalCursorAbsent: pages.at(-1)?.nextCursor === undefined });
        });
        if (views.every((v) => capture.pages[v])) await check(`${identity.role}.pagination-membership-order`, "real-rpc", async () => {
          const full = allTurns(capture.pages.full!);
          for (const view of views) assert.deepEqual(allTurns(capture.pages[view]!).map((t) => t.id), full.map((t) => t.id));
          assert.deepEqual((capture.read.turns ?? []).map((t) => t.id), full.map((t) => t.id), "thread/read differs from complete turn pages");
          const body = (turns: Turn[]) => turns.map((t) => ({ id: t.id, itemsView: t.itemsView, items: t.items }));
          assert.deepEqual(body(capture.read.turns ?? []), body(full), "thread/read full body differs from complete full pages");
          for (const turn of allTurns(capture.pages.summary!)) {
            const fullTurn = full.find((t) => t.id === turn.id);
            requireFact(fullTurn && (turn.items ?? []).every((item) => fullTurn.items?.some((candidate) => candidate.id === item.id && candidate.type === item.type)), "summary item identity absent from full body");
          }
          requireFact(capture.pages.full!.length > 1, "multi-page history not observed");
        });
      }
      if (captures.every((c) => c.pages.full)) await check("synthetic-body-and-fork-integrity", "real-rpc", async () => {
        const evidence = verifySyntheticHistory(...captures.map((c) => allTurns(c.pages.full!)) as [Turn[], Turn[], Turn[]]);
        metrics.push({ name: "synthetic comparison", ...evidence });
      });
      if (captures.every((c) => views.every((v) => c.pages[v]))) await check("desktop-merge-and-request-epochs", "local-replay-of-real-responses", async () => {
        const passed = await verifyReplay(captures);
        for (const name of passed) checks.push({ name, source: "local-replay-of-real-responses", status: "PASS" });
      });
    }
  } finally { await client.close(); }
  if (warnings) checks.push({ name: "protocol-warnings", source: "real-rpc", status: "FAIL", detail: "protocol warning observed" });
  for (const name of ["synthetic-body-and-fork-integrity", "desktop-merge-and-request-epochs"]) if (!checks.some((c) => c.name === name)) checks.push({ name, source: name.startsWith("desktop") ? "local-replay-of-real-responses" : "real-rpc", status: "BLOCKED", detail: "required captures unavailable" });
  const finalResult = checks.some((c) => c.status === "FAIL") ? "M6_C2: COMPATIBILITY_FIX_REQUIRED" : !identityPassed || checks.some((c) => c.status === "BLOCKED") ? "M6_C2: BLOCKED" : "M6_C2: PASS";
  const report = { verifiedAt: new Date().toISOString(), environment, identityVerified: identityPassed, threads: identities.map((i) => ({ role: i.role, idSha256: digest(i.id), createdAt: new Date(i.createdAt).toISOString(), archivedFilter: true })), checks, metrics, rpcCounts, stderrBytes, protocolWarnings: warnings, modelCallsRequested: 0, stateChangingRpcCount: 0, finalResult };
  mkdirSync(dirname(options.report), { recursive: true }); writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
  if (finalResult !== "M6_C2: PASS") process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error(JSON.stringify({ finalResult: "M6_C2: BLOCKED", detail: "setup/report failure; raw details suppressed; no write RPC available" })); process.exitCode = 1; });
