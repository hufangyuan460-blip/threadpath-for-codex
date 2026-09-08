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

The smoke output deliberately logs IDs, counts, method names, and error categories rather than full thread or turn content.

## Error categories

The small client exposes distinct errors for configuration, child-process lifecycle, malformed protocol output, client request timeout, network timeout reported by the server, and ordinary app-server business errors. A server-reported connection timeout is retained as a network timeout; it is not converted into a protocol failure.

An empty `thread/list` is valid. In that case the live smoke test skips the read operations and continues with a new ephemeral thread.

## Known limits

- The fake server proves transport behavior, not compatibility with every Codex CLI version.
- The live smoke test needs a functioning local Codex authentication and may fail a turn because the upstream Responses connection is unavailable or times out. That is reported separately from initialization and JSON-RPC failures.
- Protocol method payloads are kept close to this executable prototype and must be re-verified against the installed app-server before expanding the client.
