# Codex app-server protocol validation

`threadpath-protocol` is the runnable `v0.0.1` prototype for ThreadPath. It validates the local Codex `app-server` protocol only; it does not provide an Electron shell or user interface.

## Prerequisites

The current client also exposes typed `archiveThread(threadId)` and `unarchiveThread(threadId)` methods for `thread/archive` and `thread/unarchive`. They validate the response shape and honor explicitly missing capabilities; unknown capability sets are probed through the real RPC. Archive/unarchive does not delete conversation content. The desktop separates these Codex operations from its local hide preferences.

On 2026-10-12, offline transport checks covered both methods, server errors, invalid responses and missing capabilities. The basic live smoke passed; a dedicated non-empty read-only conversation also passed archival, both list filters, archived reading/pagination and restoration to the ordinary list. Only the dedicated test conversation was archived on cleanup. See [the desktop acceptance record](../docs/workspace-archive.md) for scope and limitations.

- Node.js that supports `--experimental-strip-types`;
- Codex CLI installed and authenticated, for the live smoke test;
- a project directory that Codex can open.

Install the development dependencies once:

```powershell
npm install
```

### Windows: Codex is not on `PATH`

The smoke test starts `codex` by default. If Windows cannot find that command, set `CODEX_EXECUTABLE` to the full path of `codex.exe` in the current PowerShell session:

```powershell
$env:CODEX_EXECUTABLE = "C:\path\to\codex.exe"
npm run smoke
```

Omit or clear `CODEX_EXECUTABLE` to return to the default command:

```powershell
Remove-Item Env:CODEX_EXECUTABLE -ErrorAction SilentlyContinue
```

## M6-C current CLI acceptance (safe default)

Use `npm.cmd run acceptance:real -- --executable <absolute-codex.exe-path>` for metadata-only live acceptance. It records the actual CLI version, binary SHA-256, app commit, execution identity, handshake, model count, active/archived list queries and an observed thread-list cursor. It never automatically selects an existing thread body. Raw stderr, error messages, titles, previews, prompts and replies are withheld.

Reading a dedicated test thread requires **both** `--test-thread <id>` and `--confirm-test-thread`. No resume or model call occurs in that mode. Body integrity remains unverified without known synthetic expected text; observing an itemsView only verifies that actual field/parser path, not desktop merge behavior. The scan is bounded to 100 turn pages and fails rather than claiming complete pagination beyond that bound.

Writing requires **both** `--write` and `--confirm-cost-and-state`; it cannot target an existing thread. This delegates to the existing fork smoke in `artifacts/m6c-fork-workspace`, including model calls, manual compaction and archival of its own test threads. It does not delete history. It does **not** cover the complete M6-C matrix: unarchive/restoration, usage payload/lifecycle/duplicate observations and unknown-terminal behavior still need separate evidence. The aggregate result deliberately remains `NEED_USER_VALIDATION`. Do not interpret exit code 0 as full M6-C acceptance. Inspect individual statuses and the separate fork report.

`--report <path>` optionally writes the redacted JSON output. Without it only stdout is used. The output file is **exclusively reserved before any CLI process starts**; an existing path rejects the invocation without touching its contents. Only the descriptor owned by that invocation is updated, and reports carry an `executionBatchId`. Errors or blocked checks return nonzero. Safety/argument/redaction tests run as part of `npm test` using only fake servers/Node fake runners.

Write execution additionally requires a fresh workspace, a new fixed fork report, and an atomic exclusive reservation at `artifacts/m6c-fork-execution.json`. `openSync(..., "wx")` plus `fsyncSync` establishes the cross-process owner before the child can start. The reservation remains after success, failure, spawn error, timeout or process exit; it is never automatically deleted or reused. Legacy `artifacts/m6c-fork-workspace` or `artifacts/m6c-fork-report.json` also blocks the runner, even if no new reservation exists. Do not delete/rename old evidence to rerun: a future batch needs fresh review and explicit authorization; there is no force/retry switch.

The wrapper exclusively owns the fixed fork report before launching the child and passes that descriptor as fd 3, bound to the same batch ID. The child writes the owned descriptor rather than reopening/truncating a path. The total report cannot overlap these reserved paths or the fork workspace. Safety tests cover first ownership, real concurrent Node processes, abrupt exit, failed/uncertain runners, total/fork report conflicts and preserved old bytes/SHA-256. This guarantees the guarded wrapper's entry path, **not** external direct invocations of `smoke:fork`. Direct smoke does not acquire the wrapper's execution reservation; its pathname report write now uses `wx` too, but that alone is not a model-call authorization guard.

The original successful C1–C4A evidence is not rerun by this fix. Since this checkout already has the real fork workspace/report, the guarded write mode must now refuse another execution. Default read-only requests do not create a write reservation, fork workspace or fork report. See [the offline safety fix record](../docs/m6-final-safety-fix.md) for exact changes and verification.

On 2026-10-26, normal Windows user execution with CLI `0.163.0-alpha.11` passed the metadata-only checks (7 models, both archive filters, two distinct cursor pages). No user conversation bodies or state-changing RPCs were accessed. The original `npm run smoke` was intentionally **not** run: it selects the first existing history and starts a model turn, contrary to the M6-C approval boundary. Historical smoke successes do not prove compatibility of this CLI. See [M6-C acceptance and remaining gates](../docs/m6-c-real-protocol-acceptance.md) for the complete matrix, environment and copyable commands.

### M6-C2 dedicated history integrity (read-only)

`apps/desktop/scripts/real-history-acceptance.ts` reuses the protocol client/parsers and the desktop `ConversationService` without changing product behavior. Its only live operations after initialize are scoped `thread/list`, `thread/read`, and `thread/turns/list`. It accepts `--executable`, `--execution-record` (the prior successful fork execution envelope), and `--report` (a **new** output path); it has no write mode or arbitrary existing-thread selector. Run it from the repository root with `node --experimental-strip-types apps/desktop/scripts/real-history-acceptance.ts` followed by those options; the desktop package also exposes `acceptance:history`.

Identity must match the prior run's workspace, three archived thread IDs, execution time window and fork ancestry. Because the observed state-DB list returned null fork sources, only metadata-only reads are allowed for validated candidates; full history is enabled only after ancestry is confirmed. Missing/ambiguous identity blocks all body reads. This targeted runner pins the reviewed CLI version/SHA and user identity; it is not a general-purpose history export tool.

Each itemsView is explicitly requested with limit 1, all cursors are consumed, raw bodies are compared with parser output, full read/page bodies and known synthetic prompts/replies are checked, then actual responses are replayed locally for completeness, overlap, thread switching and late-response protection. Replays are labelled separately from real RPC evidence. Reports omit bodies/markers and are created exclusively, never overwritten.

On 2026-10-26, CLI `0.163.0-alpha.11` passed the 3/5/2-turn archived histories, all three loading views and real pagination. The branch had 8 summary items versus 9 full items, including one historical compaction item only available in full. All 28 checks passed (21 real checks and 7 replay records), with zero model/state-changing requests. This closes the tested short-history gate, not unarchive or live Observatory acceptance. See [the complete C2 report](../docs/m6-c2-real-history-acceptance.md) for original blocked evidence, the final report, boundaries and regression results.

### M6-C3 single-thread archive recovery

`apps/desktop/scripts/real-archive-acceptance.ts` (desktop command `acceptance:archive`) defaults to read-only. It requires `--executable`, `--history-report` (the pinned successful C2 report), `--execution-record` (the C1 successful run envelope), and `--report` (a new file). Only `--write --confirm-archive-recovery` together enable the approved state changes. No arbitrary thread ID, model override or message is accepted. Read-only preflight is not a full recovery PASS.

The target is the C2-verified historical fork, reidentified through workspace/time/archived metadata, ID digests and metadata-only ancestry. Before any mutation its full history must match C2. The live allowlist permits only scoped reads and one attempt each of unarchive, metadata-only resume and archive. Resume uses excludeTurns:true and the existing read-only sandbox, without input, history/path or model overrides. No turn/start is available.

A durable one-shot execution journal is reserved before the first mutation, and each budget is consumed before transport. Existing `artifacts/m6c3-archive-recovery.mutations.jsonl` blocks another write run, even with a new report name. Do not delete it to bypass a consumed authorization. Functional failure stops further functional writes; only the remaining archive is allowed when the same active identity can still be verified. All A–E assertions and restoration must pass for exit code 0/full C3 PASS. Reports are redacted and exclusively created; offline safety tests exercise 13 success/failure lifecycles without a live CLI.

On 2026-10-26, CLI `0.163.0-alpha.11` passed archived read → unarchive → active read → metadata-only resume → rearchive, with exactly one call of each authorized mutation. The same 2 turns/4 items and body/origin digests survived; the target was confirmed archived again and absent from active listing. There were zero model-generation/turn-start requests. This closes the tested archive recovery gate, not live Observatory acceptance or a new model continuation test. See [the C3 report](../docs/m6-c3-real-archive-recovery.md) for actual evidence, file hashes and regression results.

### M6-C4 Observatory evidence collection (read-only only)

`apps/desktop/scripts/real-observatory-acceptance.ts` (desktop command `acceptance:observatory`) has no write mode. It requires `--executable`, the pinned C2 `--history-report`, C3 `--archive-report`, C1 `--execution-record`, and a new `--report`. It reuses C2's candidate/confirmed-ID gates and full-history parser. The only post-initialize calls are scoped thread/list, thread/read, thread/turns/list and `account/usage/read` with **exactly one confirmed threadId**. Account-wide fallback, messages and all activity RPCs are rejected.

The estimated ThreadUsage response from account/usage/read is not the notification's ThreadTokenUsage: credits/group totals must not become total/last/window snapshots or billing/occupancy calculations. The collector discards amounts/account summary and records only availability/known field types. Real callbacks and local replay use separate stores; derived lifecycle envelopes from real history are explicitly LOCAL_REPLAY, never counted as live server notifications.

On 2026-10-26, the 3/5/2-turn archived histories matched C2/C3 and retained one historical compaction item with id/type but no lifecycle status. Four local history/derived-event replay checks passed; three Usage replay checks were SKIP for lack of a captured real payload. No live Usage or item lifecycle notifications were observed in the bounded read-only window, and all three thread estimates were unavailable. Model/activity RPC counts were zero. The outcome is **M6_C4: NEED_APPROVAL**, not full compatibility PASS. Exit code 0 only means permitted collection completed. See [C4 evidence, gaps and the minimum approval request](../docs/m6-c4-real-observatory-acceptance.md). The proposed activity path is not implemented/enabled by this command and requires separate authorization.

## Verification

Run the deterministic checks first. They start a local fake app-server and require neither Codex authentication nor network access:

```powershell
npm run typecheck
npm test
```

The test suite covers JSONL framing, request ID correlation, server errors, unsupported server requests, malformed stdout, client request timeouts, early process exit, startup failure, both existing and empty thread lists, and all three terminal turn events: `turn/completed`, `turn/failed`, and `turn/interrupted`.

Representative JSONL messages are versioned under `fixtures/` and checked by the fixture test. Process exit and timeout fixtures intentionally describe the absence of a valid response; their live behavior is exercised by the fake app-server process tests.

`src/token-usage.ts` strictly projects `thread/tokenUsage/updated` using the checked-in v2 schema: all six counters in `total` and `last` are required non-negative safe integers; `modelContextWindow` is an integer or explicit `null`. Missing or invalid fields raise `ProtocolError`; extra fields are discarded, never forwarded. `token-usage-tests.ts` covers valid, null-window, malformed, duplicate and resume-replay fixtures. The desktop rejects invalid snapshots independently of conversation operations. `total` is cumulative usage and `last` is the latest server snapshot, neither is exact context occupancy. See [observatory semantics](../docs/token-usage-observatory.md).

When a supported app-server message changes, update the smallest relevant fixture and its assertions together. Keep request and response IDs matched, keep notification fixtures ID-free, and use redacted stable values. Unknown fields should remain in representative fixtures when they verify forward-compatible parsing; do not add local authentication data, full conversation content, or machine-specific thread IDs.

## Reusable client API

`src/app-server-client.ts` keeps the generic `request(method, params)` method at the protocol boundary and exposes typed operations for callers:

```text
initialize()
listThreads(options)
listThreadPage(options) → { threads, nextCursor? }
readThread(threadId)
resumeThread(threadId) → re-activate an existing thread before a new turn
forkThread(threadId, options?) → a new thread, optionally through lastTurnId inclusive
listTurns(threadId, options?) → { turns, nextCursor? }
listModels() → account-visible model ids and supported reasoning efforts
startThread(options) → supports an optional model override
startTurn(threadId, input, options?) → supports optional model and effort overrides
waitForTurnTerminal(turnId)
close()
```

Callers can subscribe to notifications with `onNotification`. Optional `onDiagnostic` records request IDs, methods, durations, terminal outcomes, and error categories without recording complete payloads or conversation text.

Diagnostics are disabled by default. Enable them explicitly with a callback when structured records are needed:

```ts
const client = new AppServerClient({
  cwd: projectDirectory,
  onDiagnostic: (record) => console.error(JSON.stringify(record)),
});
```

Diagnostic records contain only protocol method or notification names, request/turn IDs, an ISO start time when applicable, duration, status, outcome, and error category. Configuration validation failures use a `client.failed` record. They never include request parameters, response bodies, authentication data, tokens, or conversation text. Applications should apply their own retention and access controls to emitted logs.

Run the live protocol smoke test separately:

```powershell
npm run smoke
```

It starts `codex app-server --stdio` in the legacy fixed Windows project directory by default (see `app-server-smoke.ts`); set `CODEX_SMOKE_CWD` for your project. It then runs:

```text
initialize → initialized → thread/list → optional thread/read + thread/turns/list
→ thread/start (ephemeral) → turn/start → streaming notifications → terminal turn event
```

Set `CODEX_SMOKE_CWD` to use another project directory, and `CODEX_SMOKE_TIMEOUT_MS` to change the per-request and terminal-event timeout. The default is five minutes (`300_000` ms) because a real app-server turn may spend time starting tools, streaming, retrying a Responses connection, or falling back from WebSocket to HTTPS; the previous two-minute default could expire before a terminal turn event arrived.

```powershell
$env:CODEX_SMOKE_CWD = "D:\another-project"
$env:CODEX_SMOKE_TIMEOUT_MS = "180000"
npm run smoke
```

To explicitly verify continuation of a known existing thread, set both values below. This is opt-in because it appends a real turn to that thread; the smoke test first confirms the ID is still present in `thread/list`, then runs `thread/read` → `thread/resume` → `turn/start` and waits for completion. Do not use an ID you do not intend to modify.

```powershell
$env:CODEX_SMOKE_EXISTING_THREAD_ID = "your-confirmed-thread-id"
$env:CODEX_SMOKE_EXISTING_MESSAGE = "A short test message"
npm run smoke
```

The smoke output deliberately logs IDs, counts, method names, and error categories rather than full thread or turn content.

## Error categories

The small client exposes distinct errors for configuration, child-process lifecycle, malformed protocol output, client request timeout, network timeout reported by the server, and ordinary app-server business errors. A server-reported connection timeout is retained as a network timeout; it is not converted into a protocol failure.

An empty `thread/list` is valid. In that case the live smoke test skips the read operations and continues with a new ephemeral thread.

## Capability detection

`initialize()` also returns and stores the server version, protocol version, compatibility information, and a typed capability set. Callers can inspect `client.capabilities` and use `client.supports("thread/turns/list")` before selecting a protocol path. `listThreadPage()` exposes the public `thread/list` cursor when the server returns one; `listThreads()` follows non-repeating cursors and no longer fixes the directory at ten items. The desktop history synchronizer requests both `archived: false` and `archived: true` using this public API. If an installation rejects archived listing or does not expose verified pagination, the desktop reports a partial sync and retains the prior local mirror instead of claiming that all history was synchronized. `listTurns(threadId, { limit, cursor })` returns a typed page with `turns` and an optional `nextCursor`; callers should pass that cursor to load older pages.

The minimum method set for the current live flow is `thread/list`, `thread/start`, and `turn/start`. `thread/read`, `thread/turns/list`, and `thread/resume` are required only when reading or continuing an existing thread; an empty thread list remains valid. `thread/read` does not activate a thread for writing, so callers must use `resumeThread(threadId)` immediately before `startTurn` for existing threads. `interruptTurn(threadId, turnId)` sends the verified `turn/interrupt` request for a ThreadPath-owned active turn; callers must not use it to stop an externally owned turn. If the server explicitly reports a missing capability, the client raises a `CompatibilityError` before making that method call (or while waiting for an unsupported terminal event). A server `thread_not_found` response is mapped by the desktop service to an actionable unavailable-thread error without issuing `turn/start`.

Older app-servers that omit capability information remain supported in compatibility mode: the client allows the protocol methods and terminal events implemented by this prototype, while `supports()` returns `false` for unknown names. Unknown fields in initialize responses are ignored, so newer servers can add metadata without breaking this client.

The desktop conversation service treats explicit `running`, `in_progress`, `inProgress`, `started`, `pending`, and `queued` turn states as busy, and treats an object or string thread status of `active` as busy. An `already has an active writer` response is mapped to a typed busy-thread error, preserves the draft, and prevents another `turn/start` until a terminal event or a `thread/resume` reconciliation confirms that the thread is idle. A `turn/completed` notification with a terminal `failed` or `interrupted` status is normalized to that outcome. Turn collections are normalized by explicit adapter order facts, never by timestamps or array heuristics: the verified current app-server adapter declares `thread/read` as oldest-first and `thread/turns/list` as newest-first with `nextCursor` pointing to older content. The canonical desktop order is always oldest-first; older pages are inserted before existing turns by unique ID, while duplicate turns keep their original position. The alternative oldest-first page contract is covered by `fixtures/turns-list-oldest-first.jsonl`.

ThreadPath never kills the app-server process to recover a stuck UI state. It reconciles through `thread/resume`; when the server reports the thread is idle, it releases only the corresponding local lock. The stop control is available only for a local turn started by ThreadPath and uses `turn/interrupt`; external writers remain blocked rather than cancellable.

## Known limits

- The fake server proves transport behavior, not compatibility with every Codex CLI version.
- The live smoke test needs a functioning local Codex authentication and may fail a turn because the upstream Responses connection is unavailable or times out. That is reported separately from initialization and JSON-RPC failures.
- Protocol method payloads are kept close to this executable prototype and must be re-verified against the installed app-server before expanding the client.

## Terminal status and history completeness compatibility

`terminalTurnEvent` accepts success from `turn/completed` only when `turn.status` is explicitly `completed`. Known `failed` and `interrupted` statuses retain their mappings, including the dedicated legacy notification names. An unknown or absent status settles the waiter through the existing `failed` path with a `CompatibilityError`; it does not assert a server-side failure or successful completion. The desktop uses the same mapping, releases the local running guard, leaves partial output unfinalized and does not automatically send another turn. The normal send path still reconciles server activity.

History turns retain optional `itemsView` (`notLoaded`, `summary`, `full`). An unsupported value is a compatibility error; absence remains unreported for older fixtures. Valid current full snapshots replace the previous item membership and body, including shorter text, empty text and empty arrays. Summary responses preserve full content by item ID while admitting new IDs, with per-item completeness retained for mixed turns. notLoaded retains cached bodies rather than declaring them empty. Paginated metadata-only reads do not establish complete history membership. Per-thread read epochs reject superseded reads/pages before they change history or paging state. These epochs order client requests, not server storage revisions; no server revision or cross-process synchronization guarantee is inferred. No RPC, resume, full-history fetch or dependency was added.

Accepted input is reconciled only against raw user items from the current RPCs, scoped by thread and turn and requiring a real item ID and exact input. Cached display content and local placeholders are not evidence of echo. While input is pending, empty/partial server input bubbles remain deferred; after confirmation all server user IDs are retained, including equal-text messages. Compatibility uncertainty is retained as view metadata and reidentified in unknown/missing historical statuses; the UI says final status cannot be confirmed instead of claiming model failure. Body completeness never proves completion. Recognized terminal statuses can resolve the uncertainty even when the body is notLoaded. No automatic send or retry is introduced.

The new regression fixtures are synthetic projections of the locally available schema, not captures proving current CLI compatibility. The protocol/desktop unit tests and fake desktop E2E cover these boundaries. Live smoke is intentionally excluded from M6-B because the task prohibits creating real Codex conversations; successful initialize/model listing alone does not verify history or terminal behavior.

## Fork protocol verification

`resumeThread(threadId, { sandbox: "read-only" })` requests the explicit sandbox override and requires `response.sandbox.type === "readOnly"` before returning. A missing or different policy raises `CompatibilityError`; desktop discussion branches then skip `turn/start` and retain their draft. Calling `resumeThread(threadId)` without options keeps existing behavior. This policy is checked again for every discussion-branch send, including after restarting the desktop.

`forkThread(threadId, { lastTurnId })` requests `thread/fork` directly. The returned ID must be new; the inclusive cutoff retains the specified ended turn and excludes later turns. Omitting `lastTurnId` requests the stored history. The narrow options also support `cwd`, `ephemeral`, `model`, `approvalPolicy`, and `sandbox`. Invalid cutoff and unsupported-method responses retain their server error category; malformed or reused thread IDs are protocol errors. Explicitly missing capabilities are rejected before the RPC. On a server that omits capability discovery, the RPC can be tried, but `supports("thread/fork")` remains false until supported methods are explicitly advertised; no CLI-wide compatibility is inferred from an absent capability list.

Thread metadata retains optional `sessionId` and `forkedFromId` across list/read/resume/fork. Do not infer ordinary fork relationships from matching `sessionId`: local CLI `0.162.0-alpha.17.2` returned the fork's own ID in that field on 2026-10-12. Protocol `parentThreadId` describes subagent ancestry, not the ordinary fork source. ThreadPath must separately retain the source cutoff turn when it creates a branch.

`npm test` now also runs a stateful fake-server suite for cutoff, unchanged source history, independent continuation, nested/full-history forks, metadata hydration, process restart, in-progress cutoff rejection and error/compatibility cases. This suite verifies client engineering; it cannot prove model-visible context or actual Codex persistence behavior.

Run the separate live acceptance script:

```powershell
npm run smoke:fork
```

This performs real model calls. It creates only dedicated read-only persistent test threads, checks random synthetic state markers on both routes, restarts app-server, resumes the fork, manually compacts its context, and then forks again from a pre-compaction turn. It archives only the threads it created on completion or failure. No existing user thread is selected or edited, and no Codex authentication or persistent configuration is changed.

Defaults, relative to this package's working directory:

- `CODEX_FORK_SMOKE_CWD`: `../artifacts/fork-smoke-workspace`;
- `CODEX_FORK_SMOKE_REPORT`: `../artifacts/protocol-fork-report.json`;
- `CODEX_FORK_SMOKE_MODEL`: unset, preserving the configured model;
- `CODEX_FORK_SMOKE_COMPACT`: compaction enabled; set to `0` for a reduced run that does **not** claim compaction acceptance;
- `CODEX_EXECUTABLE` and `CODEX_SMOKE_TIMEOUT_MS`: same executable/timeout controls as the basic smoke test.

The script requests `low` reasoning effort only when the selected catalog model advertises it. The report contains check outcomes, durations, platform/version information and archival status; it omits prompts, replies, random markers, thread IDs and environment paths. Raw app-server stderr is not printed or persisted; only its byte count is recorded. A failed real model call, assertion, timeout or archival operation makes the run fail rather than silently reducing coverage.

On 2026-10-12, the full live run on local CLI `0.162.0-alpha.17.2` / Node `v24.19.0` passed all 10 checks, including compaction, and archived all 3 test threads. The changed protocol also passed the basic live smoke, workspace type checks, and protocol/desktop offline tests. See [the dated verification record](../docs/protocol-fork-verification.md) for actual results and limitations. A successful short synthetic run is not a guarantee for every CLI version, long conversation or compression history. Forking conversation history does not restore or isolate code files in the working directory.

After adding desktop discussion branches, the basic live smoke passed again. A second live fork run with `CODEX_FORK_SMOKE_COMPACT=0` passed 7 checks, including the explicit read-only override on restart resume, and archived its 2 dedicated threads. Its redacted report is `artifacts/branch-readonly-report.json`; the reduced run does not claim new compaction coverage. See [the desktop acceptance record](../docs/branch-conversation.md) for the UI, drafts, IPC, and fake-server E2E scope.

## M6-C4A Resume Usage probe

`apps/desktop/scripts/resume-usage-probe.ts` / desktop `acceptance:resume-usage` defaults to read-only. It accepts the reviewed `--executable`, pinned C2 `--history-report`, C3 `--archive-report`, C4 `--observatory-report`, C1 `--execution-record`, and a new `--report`. Only `--write --confirm-resume-usage` together enable the separately approved C4A budget: one unarchive, one metadata-only resume, one archive on the C2 source. No model input, arbitrary target, fork, compact or account usage query is available. A persistent `artifacts/m6c4a-resume-usage.mutations.jsonl` blocks another write run; never delete it to replay consumed approval.

The listener is installed before resume and validates the known thread/turn identities. A validated metadata-only/read-only acknowledgement starts a 5000 ms observation window; pre-response snapshots remain pending until acknowledgement. A valid snapshot only counts when restoration and all history checks succeed. No notification yields NOT_OBSERVED, not protocol non-support. Exit code 0 can mean PASS or NOT_OBSERVED; inspect finalResult. Default read-only checks cannot prove resume behavior.

On 2026-10-26, one approved execution received one valid real Usage notification after the resume response, with all six fields in total/last and a numeric window; source was restored archived with unchanged 3-turn/6-item history. No generation request, fork or compact occurred. Real duplicate/null samples were not observed. Local replay of the saved token values passed separately and is not a second server notification. See [C4A report](../docs/m6-c4a-resume-usage-report.md); full C4 remains INCOMPLETE. The same execution was not rerun when the task instructions were subsequently restated.
