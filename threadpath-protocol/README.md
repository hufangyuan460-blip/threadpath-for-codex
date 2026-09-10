# Codex app-server protocol validation

`threadpath-protocol` is the runnable `v0.0.1` prototype for ThreadPath. It validates the local Codex `app-server` protocol only; it does not provide an Electron shell or user interface.

## Prerequisites

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

When a supported app-server message changes, update the smallest relevant fixture and its assertions together. Keep request and response IDs matched, keep notification fixtures ID-free, and use redacted stable values. Unknown fields should remain in representative fixtures when they verify forward-compatible parsing; do not add local authentication data, full conversation content, or machine-specific thread IDs.

## Reusable client API

`src/app-server-client.ts` keeps the generic `request(method, params)` method at the protocol boundary and exposes typed operations for callers:

```text
initialize()
listThreads(options)
readThread(threadId)
resumeThread(threadId) → re-activate an existing thread before a new turn
listTurns(threadId, options?) → { turns, nextCursor? }
startThread(options)
startTurn(threadId, input)
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

`initialize()` also returns and stores the server version, protocol version, compatibility information, and a typed capability set. Callers can inspect `client.capabilities` and use `client.supports("thread/turns/list")` before selecting a protocol path. `listTurns(threadId, { limit, cursor })` returns a typed page with `turns` and an optional `nextCursor`; callers should pass that cursor to load older pages.

The minimum method set for the current live flow is `thread/list`, `thread/start`, and `turn/start`. `thread/read`, `thread/turns/list`, and `thread/resume` are required only when reading or continuing an existing thread; an empty thread list remains valid. `thread/read` does not activate a thread for writing, so callers must use `resumeThread(threadId)` immediately before `startTurn` for existing threads. If the server explicitly reports a missing capability, the client raises a `CompatibilityError` before making that method call (or while waiting for an unsupported terminal event). A server `thread_not_found` response is mapped by the desktop service to an actionable unavailable-thread error without issuing `turn/start`.

Older app-servers that omit capability information remain supported in compatibility mode: the client allows the protocol methods and terminal events implemented by this prototype, while `supports()` returns `false` for unknown names. Unknown fields in initialize responses are ignored, so newer servers can add metadata without breaking this client.

The desktop conversation service treats explicit `running`, `in_progress`, `started`, `pending`, and `queued` turn states as busy. A plain thread status of `active` only means that the thread is available; without an explicitly active turn it does not disable input. An `already has an active writer` response is mapped to a typed busy-thread error, preserves the draft, and prevents another `turn/start` until a terminal event or a status refresh confirms that the thread is no longer active. Turn pages are oriented to chronological display order before merging: timestamp order is used only to orient a page when both boundaries are valid and distinct; otherwise the app-server's newest-first page direction is used as the stable fallback. Older pages are then inserted before existing turns by unique ID, without reordering duplicates.

No verified app-server per-turn cancellation method is included in the current protocol capabilities. The desktop running-state control therefore shows a disabled pause indicator with an accessible explanation; it never kills the app-server process or calls an unverified RPC.

## Known limits

- The fake server proves transport behavior, not compatibility with every Codex CLI version.
- The live smoke test needs a functioning local Codex authentication and may fail a turn because the upstream Responses connection is unavailable or times out. That is reported separately from initialization and JSON-RPC failures.
- Protocol method payloads are kept close to this executable prototype and must be re-verified against the installed app-server before expanding the client.
