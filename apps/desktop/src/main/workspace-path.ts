import { execFile as execFileCallback } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, resolve, win32 } from "node:path";

const execFile = promisify(execFileCallback);
const GIT_TIMEOUT_MS = 1_000;

export interface WorkspaceIdentity {
  readonly root: string;
  readonly workingDirectory: string;
  readonly key: string;
  readonly repositoryRoot?: string;
  readonly resolvedAt: string;
}

export interface WorkspaceIdentityResolverOptions {
  readonly gitExecutable?: string;
  readonly gitTimeoutMs?: number;
}

export class WorkspaceIdentityResolver {
  private readonly cache = new Map<string, WorkspaceIdentity | undefined>();
  private readonly pending = new Map<string, Promise<WorkspaceIdentity | undefined>>();
  private readonly gitExecutable: string;
  private readonly gitTimeoutMs: number;
  private readonly resolvedListeners = new Set<(identity: WorkspaceIdentity) => void>();

  constructor(options: WorkspaceIdentityResolverOptions = {}) {
    this.gitExecutable = options.gitExecutable ?? "git";
    this.gitTimeoutMs = options.gitTimeoutMs ?? GIT_TIMEOUT_MS;
  }

  getCached(path: string): WorkspaceIdentity | undefined {
    const key = preliminaryWorkspaceKey(path);
    return key === undefined ? undefined : this.cache.get(key);
  }

  onResolved(listener: (identity: WorkspaceIdentity) => void): () => void {
    this.resolvedListeners.add(listener);
    return () => { this.resolvedListeners.delete(listener); };
  }

  async resolve(path: string): Promise<WorkspaceIdentity | undefined> {
    const key = preliminaryWorkspaceKey(path);
    if (key === undefined) return undefined;
    if (this.cache.has(key)) return this.cache.get(key);
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;
    const pending = this.resolveUncached(path, key);
    this.pending.set(key, pending);
    try { return await pending; }
    finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
  }

  invalidate(path?: string): void {
    if (path === undefined) this.cache.clear();
    else {
      const key = preliminaryWorkspaceKey(path);
      if (key !== undefined) {
        const identity = this.cache.get(key);
        for (const [cachedKey, cachedIdentity] of this.cache) {
          if (cachedKey === key || (identity !== undefined && cachedIdentity?.key === identity.key)) this.cache.delete(cachedKey);
        }
      }
    }
  }

  private async resolveUncached(path: string, key: string): Promise<WorkspaceIdentity | undefined> {
    const candidate = preliminaryAbsolutePath(path);
    if (candidate === undefined) return undefined;
    let workingDirectory: string;
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) { this.cache.set(key, undefined); return undefined; }
      workingDirectory = win32.normalize(await realpath(candidate));
    } catch {
      this.cache.set(key, undefined);
      return undefined;
    }
    const repositoryRoot = await this.findGitRoot(workingDirectory);
    const root = repositoryRoot ?? workingDirectory;
    const identity: WorkspaceIdentity = {
      root,
      workingDirectory,
      key: workspaceKey(root),
      ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
      resolvedAt: new Date().toISOString(),
    };
    this.cache.set(key, identity);
    this.cache.set(workspaceKey(workingDirectory), identity);
    this.cache.set(identity.key, identity);
    for (const listener of this.resolvedListeners) listener(identity);
    return identity;
  }

  private async findGitRoot(path: string): Promise<string | undefined> {
    try {
      const result = await execFile(this.gitExecutable, ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: this.gitTimeoutMs, windowsHide: true });
      const output = result.stdout.trim();
      if (output === "") return undefined;
      try { return win32.normalize(await realpath(output)); } catch { return undefined; }
    } catch { return undefined; }
  }
}

export function preliminaryWorkspaceKey(path: string): string | undefined {
  const candidate = preliminaryAbsolutePath(path);
  return candidate === undefined ? undefined : workspaceKey(candidate);
}

export function workspaceKey(path: string): string {
  const normalized = win32.normalize(path.replaceAll("/", "\\")).replace(/[\\]+$/, "");
  return normalized.toLocaleLowerCase();
}

function preliminaryAbsolutePath(path: string): string | undefined {
  const trimmed = path.trim();
  if (trimmed === "" || !isAbsolute(trimmed) && !win32.isAbsolute(trimmed)) return undefined;
  return win32.normalize(resolve(trimmed));
}

export function parentDirectory(path: string): string { return dirname(path); }
