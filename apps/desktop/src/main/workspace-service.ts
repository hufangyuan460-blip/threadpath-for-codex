import { existsSync, statSync } from "node:fs";
import { ConfigurationError } from "../../../../threadpath-protocol/src/protocol.ts";
import type { ThreadListItem, WorkspaceState } from "../shared/api";
import type { UserPreferencesService } from "./user-preferences.ts";

export interface WorkspaceServiceOptions {
  readonly preferences: UserPreferencesService;
}

export class WorkspaceService {
  private readonly preferences: UserPreferencesService;

  constructor(options: WorkspaceServiceOptions) { this.preferences = options.preferences; }

  getState(threads: readonly ThreadListItem[]): WorkspaceState {
    const directories = this.preferences.getWorkingDirectories();
    const grouped = new Map(directories.map((path) => [path, [] as ThreadListItem[]]));
    const unclassifiedThreads: ThreadListItem[] = [];
    for (const thread of threads) {
      const path = this.preferences.getThreadWorkingDirectory(thread.id) ?? thread.workspacePath;
      const target = path === undefined ? undefined : grouped.get(path);
      if (target === undefined) unclassifiedThreads.push(thread);
      else target.push({ ...thread, workspacePath: path });
    }
    return {
      ...(this.preferences.getCurrentWorkingDirectory() === undefined ? {} : { currentPath: this.preferences.getCurrentWorkingDirectory() }),
      directories: directories.map((path) => ({ path, name: workspaceDisplayName(path), expanded: this.preferences.getWorkspaceExpanded(path), threads: grouped.get(path) ?? [] })),
      unclassifiedThreads,
    };
  }

  async addDirectory(path: unknown): Promise<void> {
    const validPath = validateWorkspacePath(path);
    await this.preferences.addWorkingDirectory(validPath);
  }

  async setCurrent(path: unknown): Promise<void> {
    const validPath = validateWorkspacePath(path);
    await this.preferences.setCurrentWorkingDirectory(validPath);
  }

  async toggle(path: unknown): Promise<void> {
    const validPath = validateWorkspacePath(path);
    await this.preferences.setWorkspaceExpanded(validPath, !this.preferences.getWorkspaceExpanded(validPath));
  }

  async associateThread(threadId: string, path: unknown): Promise<void> {
    if (path === undefined || path === null) {
      await this.preferences.setThreadWorkingDirectory(threadId, undefined);
      return;
    }
    const validPath = validateWorkspacePath(path);
    await this.preferences.setThreadWorkingDirectory(threadId, validPath);
  }
}

export function validateWorkspacePath(path: unknown): string {
  if (typeof path !== "string" || path.trim() === "" || path !== path.trim() || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) throw new ConfigurationError("workspace path must be a valid directory path");
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new ConfigurationError(`workspace directory does not exist: ${path}`);
  return path;
}

export function workspaceDisplayName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const separator = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return normalized.slice(separator + 1) || normalized;
}
