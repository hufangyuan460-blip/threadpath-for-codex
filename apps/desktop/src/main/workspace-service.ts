import { ConfigurationError } from "../../../../threadpath-protocol/src/protocol.ts";
import type { ConfiguredWorkspace, ThreadListItem, WorkspaceState } from "../shared/api";
import type { UserPreferencesService } from "./user-preferences.ts";
import { WorkspaceIdentityResolver, preliminaryWorkspaceKey } from "./workspace-path.ts";
import type { HistorySyncSnapshot } from "../shared/api";

export interface WorkspaceServiceOptions {
  readonly preferences: UserPreferencesService;
  readonly identityResolver?: WorkspaceIdentityResolver;
}

export class WorkspaceService {
  private readonly preferences: UserPreferencesService;
  readonly identityResolver: WorkspaceIdentityResolver;

  constructor(options: WorkspaceServiceOptions) {
    this.preferences = options.preferences;
    this.identityResolver = options.identityResolver ?? new WorkspaceIdentityResolver();
  }

  async getState(threads: readonly ThreadListItem[], sync: HistorySyncSnapshot = { state: "idle", threadCount: threads.length, missingThreadIds: [] }): Promise<WorkspaceState> {
    const directorySet = new Set(this.preferences.getWorkingDirectories().map((path) => this.cachedRoot(path)).filter((path): path is string => path !== undefined));
    for (const thread of threads) {
      const rawPath = this.preferences.getThreadWorkingDirectory(thread.id) ?? thread.workspacePath;
      const path = rawPath === undefined ? undefined : this.cachedRoot(rawPath);
      if (path !== undefined) directorySet.add(path);
    }
    const directories = [...directorySet];
    const userDirectories = new Set(this.preferences.getWorkingDirectories());
    const configured = new Map(this.preferences.getConfiguredWorkspaces().map((workspace) => [workspace.primaryDirectory, workspace]));
    for (const path of directories) {
      if (configured.has(path)) continue;
      configured.set(path, {
        id: path,
        primaryDirectory: path,
        additionalDirectories: [],
        source: userDirectories.has(path) ? "user-configured" : "synced",
        applyState: userDirectories.has(path) ? "applied" : "not-applied",
      });
    }
    const grouped = new Map(directories.map((path) => [path, [] as ThreadListItem[]]));
    const unclassifiedThreads: ThreadListItem[] = [];
    for (const thread of threads) {
      const rawPath = this.preferences.getThreadWorkingDirectory(thread.id) ?? thread.workspacePath;
      const path = rawPath === undefined ? undefined : this.cachedRoot(rawPath);
      const target = path === undefined ? undefined : grouped.get(path);
      if (target === undefined) unclassifiedThreads.push(thread);
      else target.push({ ...thread, workspacePath: path });
    }
    const currentPath = this.cachedRoot(this.preferences.getCurrentWorkingDirectory() ?? "");
    return {
      ...(currentPath === undefined ? {} : { currentPath }),
      directories: directories.map((path) => ({ path, name: workspaceDisplayName(path), expanded: this.preferences.getWorkspaceExpanded(path), threads: grouped.get(path) ?? [] })),
      unclassifiedThreads,
      configuredWorkspaces: [...configured.values()] as readonly ConfiguredWorkspace[],
      sync,
    };
  }

  async addDirectory(path: unknown): Promise<void> {
    const validPath = await validateWorkspacePath(path, this.identityResolver);
    await this.preferences.addWorkingDirectory(validPath);
  }

  async setCurrent(path: unknown): Promise<void> {
    const validPath = await validateWorkspacePath(path, this.identityResolver);
    await this.preferences.setCurrentWorkingDirectory(validPath);
  }

  async toggle(path: unknown): Promise<void> {
    const validPath = await validateWorkspacePath(path, this.identityResolver);
    await this.preferences.setWorkspaceExpanded(validPath, !this.preferences.getWorkspaceExpanded(validPath));
  }

  async associateThread(threadId: string, path: unknown): Promise<void> {
    if (path === undefined || path === null) {
      await this.preferences.setThreadWorkingDirectory(threadId, undefined);
      return;
    }
    const validPath = await validateWorkspacePath(path, this.identityResolver);
    await this.preferences.setThreadWorkingDirectory(threadId, validPath);
  }
  private cachedRoot(path: string): string | undefined {
    const identity = this.identityResolver.getCached(path);
    if (identity !== undefined) return identity.root;
    const key = preliminaryWorkspaceKey(path);
    if (key !== undefined) void this.identityResolver.resolve(path);
    return undefined;
  }
}

export async function validateWorkspacePath(path: unknown, resolver = new WorkspaceIdentityResolver()): Promise<string> {
  if (typeof path !== "string" || path.trim() === "" || path !== path.trim() || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) throw new ConfigurationError("workspace path must be a valid directory path");
  const identity = await resolver.resolve(path);
  if (identity === undefined) throw new ConfigurationError(`workspace directory does not exist: ${path}`);
  return identity.root;
}

export function workspaceDisplayName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const separator = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return normalized.slice(separator + 1) || normalized;
}
