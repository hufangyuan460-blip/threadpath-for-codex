import assert from "node:assert/strict";
import { ActiveTurnError, CompatibilityError, ProtocolError, type ForkThreadOptions, type Thread } from "../../../../threadpath-protocol/src/protocol.ts";
import { ConversationService, type ConversationClient } from "./conversation-service.ts";

async function main(): Promise<void> {
  const source: Thread = { id: "source", cwd: process.cwd(), turns: [{ id: "base", status: "completed", items: [] }, { id: "later", status: "completed", items: [] }] };
  let received: ForkThreadOptions | undefined;
  let failFork = true;
  let sends = 0;
  let resumedSandbox: string | undefined;
  const client: ConversationClient = {
    listThreads: async () => [], readThread: async () => source,
    listTurns: async () => ({ turns: [...source.turns ?? []].reverse() }),
    startThread: async () => ({ id: "new" }),
    forkThread: async (_id, options) => {
      received = options;
      if (failFork) throw new Error("fixture fork failed");
      return { ...source, id: "branch", forkedFromId: "source", turns: source.turns?.slice(0, 1) };
    },
    resumeThread: async (id, options) => {
      resumedSandbox = options?.sandbox;
      if (options?.sandbox !== "read-only") throw new Error("sandbox override lost");
      return { id, turns: [], canAcceptDirectInput: true };
    },
    startTurn: async () => { sends++; return { id: "started", status: "inProgress" }; },
    interruptTurn: async () => undefined,
    onNotification: () => () => undefined,
  };
  const service = new ConversationService({ getReadyClient: () => client }, (id) => id === "branch");
  await assert.rejects(service.forkConversation("source", "base", process.cwd()), /Load the source/);
  await service.readThread("source");
  await assert.rejects(service.forkConversation("source", "base", process.cwd()), /fixture fork failed/);
  failFork = false;
  const branch = await service.forkConversation("source", "base", process.cwd());
  assert.deepEqual(branch.turns?.map((turn) => turn.id), ["base"]);
  assert.deepEqual(source.turns?.map((turn) => turn.id), ["base", "later"]);
  assert.deepEqual(received, { lastTurnId: "base", cwd: process.cwd(), ephemeral: false, sandbox: "read-only" });
  await service.startTurn("branch", "branch input");
  assert.equal(resumedSandbox, "read-only");
  assert.equal(sends, 1);
  await assert.rejects(service.forkConversation("source", "base", process.cwd()), ActiveTurnError);
  const unsupported = new ConversationService({ getReadyClient: () => ({ ...client, forkThread: undefined }) });
  await unsupported.readThread("source");
  await assert.rejects(unsupported.forkConversation("source", "base", process.cwd()), CompatibilityError);
  const wrongParent = new ConversationService({ getReadyClient: () => ({ ...client, forkThread: async () => ({ id: "branch", forkedFromId: "other" }) }) });
  await wrongParent.readThread("source");
  await assert.rejects(wrongParent.forkConversation("source", "base", process.cwd()), ProtocolError);
  const active = new ConversationService({ getReadyClient: () => ({ ...client, readThread: async () => ({ ...source, turns: [{ id: "base", status: "inProgress", items: [] }] }), listTurns: async () => ({ turns: [] }) }) });
  await active.readThread("source");
  await assert.rejects(active.forkConversation("source", "base", process.cwd()), ActiveTurnError);
  console.log("[desktop-test] branch cutoff, retry, sandbox, active and compatibility checks passed");
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
