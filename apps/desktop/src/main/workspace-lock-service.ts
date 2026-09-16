import type { ThreadWriteState } from "../shared/api";
import { ActiveTurnError, ProcessError } from "../../../../threadpath-protocol/src/protocol.ts";

export interface WriteLock {
  readonly threadId: string;
  readonly workspaceKey?: string;
  readonly local: boolean;
}

export class WorkspaceLockService {
  private readonly locksByThread = new Map<string, WriteLock>();
  private readonly locksByWorkspace = new Map<string, Map<string, WriteLock>>();

  private workspaceLocks(workspaceKey: string, create = false): Map<string, WriteLock> | undefined {
    const existing = this.locksByWorkspace.get(workspaceKey);
    if (existing !== undefined || !create) return existing;
    const locks = new Map<string, WriteLock>();
    this.locksByWorkspace.set(workspaceKey, locks);
    return locks;
  }

  private addLock(lock: WriteLock): void {
    this.locksByThread.set(lock.threadId, lock);
    if (lock.workspaceKey !== undefined) this.workspaceLocks(lock.workspaceKey, true)?.set(lock.threadId, lock);
  }

  private removeLock(lock: WriteLock): void {
    if (this.locksByThread.get(lock.threadId) !== lock) return;
    this.locksByThread.delete(lock.threadId);
    if (lock.workspaceKey === undefined) return;
    const locks = this.workspaceLocks(lock.workspaceKey);
    if (locks === undefined) return;
    locks.delete(lock.threadId);
    if (locks.size === 0) this.locksByWorkspace.delete(lock.workspaceKey);
  }

  state(threadId: string, workspaceKey: string | undefined, inputAvailable = true): ThreadWriteState {
    if (!inputAvailable) return "inputUnavailable";
    const threadLock = this.locksByThread.get(threadId);
    if (threadLock !== undefined) return threadLock.local ? "localTurnRunning" : "externalThreadWriter";
    if (workspaceKey !== undefined) {
      if ((this.workspaceLocks(workspaceKey)?.size ?? 0) > 0) return "workspaceLocked";
    }
    return "available";
  }

  acquire(threadId: string, workspaceKey: string | undefined, local = true): void {
    const state = this.state(threadId, workspaceKey);
    if (state !== "available") throw new ActiveTurnError(state === "workspaceLocked" ? "This workspace is already running another conversation." : "This conversation is already responding.");
    const lock: WriteLock = { threadId, ...(workspaceKey === undefined ? {} : { workspaceKey }), local };
    this.addLock(lock);
  }

  reserveWorkspace(ownerId: string, workspaceKey: string): void {
    if ((this.workspaceLocks(workspaceKey)?.size ?? 0) > 0) throw new ActiveTurnError("This workspace is already running another conversation.");
    const lock: WriteLock = { threadId: ownerId, workspaceKey, local: true };
    this.addLock(lock);
  }

  transfer(ownerId: string, threadId: string): void {
    const lock = this.locksByThread.get(ownerId);
    if (lock === undefined) return;
    const target = this.locksByThread.get(threadId);
    if (target !== undefined && threadId !== ownerId) throw new ActiveTurnError("The target conversation already has a write lock.");
    this.removeLock(lock);
    const next: WriteLock = { ...lock, threadId };
    this.addLock(next);
  }

  markExternal(threadId: string, workspaceKey?: string): void {
    if (this.locksByThread.get(threadId)?.local === true) return;
    const existing = this.locksByThread.get(threadId);
    if (existing !== undefined && existing.local) return;
    if (existing !== undefined) this.removeLock(existing);
    const retainedWorkspaceKey = workspaceKey ?? existing?.workspaceKey;
    const lock: WriteLock = { threadId, ...(retainedWorkspaceKey === undefined ? {} : { workspaceKey: retainedWorkspaceKey }), local: false };
    this.addLock(lock);
  }

  release(threadId: string): void {
    const lock = this.locksByThread.get(threadId);
    if (lock === undefined) return;
    this.removeLock(lock);
  }

  clearExternal(threadId: string): void {
    if (this.locksByThread.get(threadId)?.local !== false) return;
    this.release(threadId);
  }

  clear(): void { this.locksByThread.clear(); this.locksByWorkspace.clear(); }
}

export function requireKnownWorkspace(workspaceKey: string | undefined): string {
  if (workspaceKey === undefined) throw new ProcessError("Workspace state is unknown; refresh before sending.");
  return workspaceKey;
}
