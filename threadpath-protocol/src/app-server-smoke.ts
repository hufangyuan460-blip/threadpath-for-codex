import { AppServerClient } from "./app-server-client.ts";
import { AppServerError, ConfigurationError, type DiagnosticRecord } from "./protocol.ts";

const cwd = process.env.CODEX_SMOKE_CWD ?? "D:\\threadPath";
const timeoutMs = Number(process.env.CODEX_SMOKE_TIMEOUT_MS ?? 300_000);
const executable = process.env.CODEX_EXECUTABLE?.trim() || undefined;
const requestedExistingThreadId = process.env.CODEX_SMOKE_EXISTING_THREAD_ID?.trim();
const existingTurnText = process.env.CODEX_SMOKE_EXISTING_MESSAGE?.trim();

function log(message: string, value?: unknown): void {
  if (value === undefined) console.log(`[smoke] ${message}`);
  else console.log(`[smoke] ${message}`, JSON.stringify(value));
}

function logDiagnostic(record: DiagnosticRecord): void {
  log("diagnostic", record);
}

async function main(): Promise<void> {
  const client = new AppServerClient({
    cwd,
    executable,
    requestTimeoutMs: timeoutMs,
    onStderr: (text) => process.stderr.write(`[app-server] ${text}`),
    onDiagnostic: logDiagnostic,
    onProtocolWarning: (error) => log(`protocol warning: ${error.message}`),
  });
  client.onNotification(({ method }) => log(`notification: ${method}`));
  try {
    const initialized = await client.initialize();
    log("initialize OK", { platform: initialized.platformOs });

    const threads = await client.listThreads({ archived: false, limit: 10 });
    log("thread/list OK", { count: threads.length });
    const existingThreadId = requestedExistingThreadId || threads[0]?.id;
    if (requestedExistingThreadId !== undefined && !threads.some((thread) => thread.id === requestedExistingThreadId)) {
      throw new ConfigurationError(`requested existing thread was not returned by thread/list: ${requestedExistingThreadId}`);
    }
    if (existingThreadId === undefined) {
      log("no existing thread available; thread/read and thread/turns/list are skipped");
    } else {
      const thread = await client.readThread(existingThreadId);
      log("thread/read OK", { threadId: thread.id, hasTurns: thread.turns !== undefined });
      const turns = await client.listTurns(existingThreadId, { limit: 10 });
      log("thread/turns/list OK", { count: turns.turns.length, hasMore: turns.nextCursor !== undefined });
      if (requestedExistingThreadId !== undefined) {
        if (existingTurnText === undefined || existingTurnText === "") throw new ConfigurationError("CODEX_SMOKE_EXISTING_MESSAGE is required when CODEX_SMOKE_EXISTING_THREAD_ID is set");
        await client.resumeThread(existingThreadId);
        log("thread/resume OK", { threadId: existingThreadId });
        const resumedTurn = await client.startTurn(existingThreadId, [{ type: "text", text: existingTurnText }]);
        log("existing thread turn/start accepted", { turnId: resumedTurn.id });
        const resumedTerminal = await client.waitForTurnTerminal(resumedTurn.id);
        if (resumedTerminal.outcome !== "completed") throw new Error(`existing thread turn ${resumedTerminal.outcome}`);
        log("existing thread turn completed OK", { turnId: resumedTurn.id });
        return;
      }
    }

    const thread = await client.startThread({ cwd, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
    log("thread/start OK", { threadId: thread.id });
    const turn = await client.startTurn(thread.id, [{ type: "text", text: "Reply with exactly: app-server stream OK" }]);
    log("turn/start accepted", { turnId: turn.id });

    const terminal = await client.waitForTurnTerminal(turn.id);
    if (terminal.outcome === "completed") {
      log("turn completed OK", { turnId: turn.id });
      return;
    }
    const detail = terminal.error instanceof AppServerError
      ? { category: terminal.error.category, message: terminal.error.message }
      : undefined;
    throw new Error(`turn ${terminal.outcome}`, { cause: detail });
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  const category = error instanceof AppServerError ? ` [${error.category}]` : "";
  console.error(`[smoke] FAILED${category}: ${detail}`);
  process.exitCode = 1;
});
