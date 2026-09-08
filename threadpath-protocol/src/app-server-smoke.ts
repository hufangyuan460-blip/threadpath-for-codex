import { AppServerClient } from "./app-server-client.ts";
import { AppServerError, getThreadId, getThreads, getTurnId, type JsonObject } from "./protocol.ts";

const cwd = process.env.CODEX_SMOKE_CWD ?? "D:\\threadPath";
const timeoutMs = Number(process.env.CODEX_SMOKE_TIMEOUT_MS ?? 120_000);
const executable = process.env.CODEX_EXECUTABLE?.trim() || undefined;

function log(message: string, value?: unknown): void {
  if (value === undefined) console.log(`[smoke] ${message}`);
  else console.log(`[smoke] ${message}`, JSON.stringify(value));
}

function asObject(value: unknown, description: string): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as JsonObject;
  throw new Error(`${description} returned a non-object response`);
}

async function main(): Promise<void> {
  const client = new AppServerClient({
    cwd,
    executable,
    requestTimeoutMs: timeoutMs,
    onStderr: (text) => process.stderr.write(`[app-server] ${text}`),
    onProtocolWarning: (error) => log(`protocol warning: ${error.message}`),
  });
  client.onNotification(({ method }) => log(`notification: ${method}`));
  try {
    await client.request("initialize", {
      clientInfo: { name: "threadpath-protocol-smoke", title: "ThreadPath protocol smoke", version: "0.0.1" },
      capabilities: null,
    });
    client.notify("initialized");
    log("initialize OK");

    const listed = await client.request("thread/list", { archived: false, limit: 10 });
    const threads = getThreads(listed);
    log("thread/list OK", { count: threads.length });
    const existingThreadId = threads[0]?.id;
    if (existingThreadId === undefined) {
      log("no existing thread available; thread/read and thread/turns/list are skipped");
    } else {
      const read = asObject(await client.request("thread/read", { threadId: existingThreadId, includeTurns: true }), "thread/read");
      const thread = asObject(read.thread, "thread/read thread");
      log("thread/read OK", { threadId: existingThreadId, hasTurns: Array.isArray(thread.turns) });
      const turns = await client.request("thread/turns/list", { threadId: existingThreadId, limit: 10 });
      const turnList = asObject(turns, "thread/turns/list");
      log("thread/turns/list OK", { count: Array.isArray(turnList.data) ? turnList.data.length : undefined });
    }

    const threadId = getThreadId(await client.request("thread/start", {
      cwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
    }));
    if (threadId === undefined) throw new Error("thread/start returned no thread id");
    log("thread/start OK", { threadId });

    const turnId = getTurnId(await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Reply with exactly: app-server stream OK" }],
    }));
    if (turnId === undefined) throw new Error("turn/start returned no turn id");
    log("turn/start accepted", { turnId });

    const terminal = await client.waitForTurnTerminal(turnId);
    if (terminal.outcome === "completed") {
      log("turn completed OK", { turnId });
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
