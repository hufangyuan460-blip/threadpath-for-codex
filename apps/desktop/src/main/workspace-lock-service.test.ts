import assert from "node:assert/strict";
import { ActiveTurnError } from "../../../../threadpath-protocol/src/protocol.ts";
import { WorkspaceLockService } from "./workspace-lock-service.ts";

function main(): void {
  const service = new WorkspaceLockService();
  assert.equal(service.state("a", "root"), "available");
  service.acquire("a", "root");
  assert.equal(service.state("a", "root"), "localTurnRunning");
  assert.equal(service.state("b", "root"), "workspaceLocked");
  assert.throws(() => service.acquire("b", "root"), ActiveTurnError);
  service.release("a");
  assert.equal(service.state("b", "root"), "available");
  service.markExternal("b", "root");
  assert.equal(service.state("b", "root"), "externalThreadWriter");
  assert.equal(service.state("c", "root"), "workspaceLocked");
  service.clearExternal("b");
  assert.equal(service.state("c", "root"), "available");
  service.acquire("a", "root");
  service.markExternal("b", "root");
  assert.equal(service.state("a", "root"), "localTurnRunning");
  assert.equal(service.state("c", "root"), "workspaceLocked");
  service.release("b");
  assert.equal(service.state("c", "root"), "workspaceLocked");
  service.release("a");
  assert.equal(service.state("third-thread", "root"), "available");
  service.acquire("a", "root");
  service.markExternal("b", "root");
  service.clearExternal("b");
  assert.equal(service.state("a", "root"), "localTurnRunning");
  service.release("a");
  service.markExternal("b", "root");
  service.acquire("c", "other");
  service.clearExternal("b");
  assert.equal(service.state("third-thread", "root"), "available");
  service.release("c");
  service.reserveWorkspace("new", "root");
  service.transfer("new", "thread-new");
  assert.equal(service.state("thread-new", "root"), "localTurnRunning");
  assert.equal(service.state("third-thread", "root"), "workspaceLocked");
  assert.throws(() => service.acquire("third", "root"), ActiveTurnError);
  service.markExternal("thread-external", "root");
  service.markExternal("thread-external");
  service.release("thread-external");
  assert.equal(service.state("third-thread", "root"), "workspaceLocked");
  service.release("thread-new");
  assert.equal(service.state("third-thread", "root"), "available");
  service.clear();
  console.log("[desktop-test] workspace lock checks passed");
}

try { main(); } catch (error: unknown) { console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
