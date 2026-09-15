import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Language } from "../shared/api";

const MAX_THREAD_NAME_LENGTH = 72;

export interface UserPreferencesFile {
  readonly language?: Language;
  readonly threadNames?: Readonly<Record<string, string>>;
  readonly workingDirectories?: readonly string[];
  readonly currentWorkingDirectory?: string;
  readonly expandedWorkingDirectories?: Readonly<Record<string, boolean>>;
  readonly threadWorkingDirectories?: Readonly<Record<string, string>>;
}

export interface ThreadNameParts {
  readonly customName?: string;
  readonly firstUserText?: string;
  readonly serverTitle?: string;
  readonly language: Language;
}

export function sanitizeThreadDisplayName(value: string, maxLength = MAX_THREAD_NAME_LENGTH): string {
  const withoutMarkup = value.replace(/<[^>]*>/g, " ");
  const plain = withoutMarkup.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(plain).slice(0, maxLength).join("").trim();
}

export function automaticThreadDisplayName(parts: Omit<ThreadNameParts, "customName">): string {
  const candidate = sanitizeThreadDisplayName(parts.firstUserText ?? "") || sanitizeThreadDisplayName(parts.serverTitle ?? "");
  if (candidate !== "") return candidate;
  return parts.language === "zh-CN" ? "未命名会话" : "Untitled conversation";
}

export function threadDisplayName(parts: ThreadNameParts): string {
  const custom = sanitizeThreadDisplayName(parts.customName ?? "");
  return custom || automaticThreadDisplayName(parts);
}

export function firstReadableUserText(turns: readonly { items: readonly { kind: string; role?: string; text?: string }[] }[] | undefined): string | undefined {
  for (const turn of turns ?? []) {
    for (const item of turn.items) {
      if (item.kind === "text" && item.role === "user" && typeof item.text === "string" && sanitizeThreadDisplayName(item.text) !== "") return item.text;
    }
  }
  return undefined;
}

export class UserPreferencesService {
  private readonly configPath: string;
  private readonly defaultLanguage: Language;
  private data: UserPreferencesFile = {};

  constructor(configPath: string, defaultLanguage: Language) {
    this.configPath = configPath;
    this.defaultLanguage = defaultLanguage;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
      this.data = isPreferencesFile(raw) ? raw : {};
    } catch (error: unknown) {
      if (isMissingFile(error)) return;
      this.data = {};
    }
  }

  getLanguage(): Language { return this.data.language ?? this.defaultLanguage; }

  async setLanguage(language: Language): Promise<Language> {
    this.data = { ...this.data, language };
    await this.persist();
    return language;
  }

  getThreadDisplayName(threadId: string, serverTitle?: string, firstUserText?: string): string {
    return threadDisplayName({ customName: this.data.threadNames?.[threadId], firstUserText, serverTitle, language: this.getLanguage() });
  }

  async setThreadDisplayName(threadId: string, name: string | null): Promise<string | undefined> {
    const names = { ...(this.data.threadNames ?? {}) };
    const sanitized = sanitizeThreadDisplayName(name ?? "");
    if (sanitized === "") delete names[threadId];
    else names[threadId] = sanitized;
    this.data = { ...this.data, threadNames: names };
    await this.persist();
    return sanitized || undefined;
  }

  async pruneThreadNames(activeThreadIds: readonly string[]): Promise<void> {
    const active = new Set(activeThreadIds);
    const names = Object.fromEntries(Object.entries(this.data.threadNames ?? {}).filter(([id]) => active.has(id)));
    const directories = Object.fromEntries(Object.entries(this.data.threadWorkingDirectories ?? {}).filter(([id]) => active.has(id)));
    if (Object.keys(names).length === Object.keys(this.data.threadNames ?? {}).length && Object.keys(directories).length === Object.keys(this.data.threadWorkingDirectories ?? {}).length) return;
    this.data = { ...this.data, threadNames: names, threadWorkingDirectories: directories };
    await this.persist();
  }

  getWorkingDirectories(): string[] { return [...(this.data.workingDirectories ?? [])]; }
  getCurrentWorkingDirectory(): string | undefined { return this.data.currentWorkingDirectory; }
  getWorkspaceExpanded(path: string): boolean { return this.data.expandedWorkingDirectories?.[path] ?? true; }
  getThreadWorkingDirectory(threadId: string): string | undefined { return this.data.threadWorkingDirectories?.[threadId]; }

  async addWorkingDirectory(path: string): Promise<void> {
    this.data = { ...this.data, workingDirectories: [...new Set([...this.getWorkingDirectories(), path])], currentWorkingDirectory: path };
    await this.persist();
  }

  async setCurrentWorkingDirectory(path: string): Promise<void> {
    if (!this.getWorkingDirectories().includes(path)) return this.addWorkingDirectory(path);
    this.data = { ...this.data, currentWorkingDirectory: path };
    await this.persist();
  }

  async setWorkspaceExpanded(path: string, expanded: boolean): Promise<void> {
    this.data = { ...this.data, expandedWorkingDirectories: { ...(this.data.expandedWorkingDirectories ?? {}), [path]: expanded } };
    await this.persist();
  }

  async setThreadWorkingDirectory(threadId: string, path: string | undefined): Promise<void> {
    const directories = { ...(this.data.threadWorkingDirectories ?? {}) };
    if (path === undefined) delete directories[threadId];
    else directories[threadId] = path;
    this.data = { ...this.data, threadWorkingDirectories: directories };
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }
}

function isPreferencesFile(value: unknown): value is UserPreferencesFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  const language = object.language;
  if (language !== undefined && language !== "zh-CN" && language !== "en-US") return false;
  const names = object.threadNames;
  if (names !== undefined && (names === null || typeof names !== "object" || Array.isArray(names) || Object.values(names).some((name) => typeof name !== "string"))) return false;
  const directories = object.workingDirectories;
  if (directories !== undefined && (!Array.isArray(directories) || directories.some((path) => typeof path !== "string"))) return false;
  if (object.currentWorkingDirectory !== undefined && typeof object.currentWorkingDirectory !== "string") return false;
  const expanded = object.expandedWorkingDirectories;
  if (expanded !== undefined && (expanded === null || typeof expanded !== "object" || Array.isArray(expanded) || Object.values(expanded).some((value) => typeof value !== "boolean"))) return false;
  const associations = object.threadWorkingDirectories;
  if (associations !== undefined && (associations === null || typeof associations !== "object" || Array.isArray(associations) || Object.values(associations).some((path) => typeof path !== "string"))) return false;
  return true;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
