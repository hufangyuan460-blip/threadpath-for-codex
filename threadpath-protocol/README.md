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

It starts `codex app-server --stdio` in `D:\threadPath` by default, then runs:

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
