import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { ConfigurationError } from "../../../../threadpath-protocol/src/protocol.ts";

export type CodexDiscoverySource = "environment" | "saved" | "path" | "known-install" | "manual";

export interface CodexDiscoveryResult {
  readonly executablePath: string;
  readonly version: string;
  readonly source: CodexDiscoverySource;
  readonly cwd?: string;
}

export interface CodexSavedConfiguration {
  readonly executablePath?: string;
  readonly cwd?: string;
}

export interface CodexDiscoveryOptions {
  readonly configPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly localAppData?: string;
  readonly versionTimeoutMs?: number;
  readonly validateExecutable?: (executablePath: string) => Promise<string>;
}

const versionTimeoutMs = 5_000;
const maxVersionOutputBytes = 4_096;

export class CodexDiscoveryService {
  private readonly options: CodexDiscoveryOptions;
  private savedConfiguration: CodexSavedConfiguration = {};

  constructor(options: CodexDiscoveryOptions) {
    this.options = options;
  }

  async discover(): Promise<CodexDiscoveryResult> {
    this.savedConfiguration = await this.readSavedConfiguration();
    const candidates = await this.candidates();
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const version = await this.validate(candidate.path);
        const cwd = this.resolveSavedCwd();
        await this.saveConfiguration({ executablePath: candidate.path, ...(cwd === undefined ? {} : { cwd }) });
        return { executablePath: candidate.path, version, source: candidate.source, ...(cwd === undefined ? {} : { cwd }) };
      } catch (error: unknown) {
        lastError = error;
      }
    }
    const reason = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
    throw new ConfigurationError(`No usable Codex CLI was found. Install Codex CLI or choose its executable manually.${reason}`);
  }

  async selectExecutable(executablePath: string): Promise<CodexDiscoveryResult> {
    const candidate = executablePath.trim();
    if (candidate === "") throw new ConfigurationError("Codex executable path is empty");
    const version = await this.validate(candidate);
    const cwd = this.resolveSavedCwd();
    await this.saveConfiguration({ executablePath: candidate, ...(cwd === undefined ? {} : { cwd }) });
    return { executablePath: candidate, version, source: "manual", ...(cwd === undefined ? {} : { cwd }) };
  }

  async selectWorkingDirectory(cwd: string): Promise<string> {
    const selected = cwd.trim();
    if (selected === "") throw new ConfigurationError("Working directory is empty");
    const directory = await stat(selected).catch(() => undefined);
    if (directory === undefined || !directory.isDirectory()) throw new ConfigurationError(`Working directory does not exist: ${selected}`);
    await this.saveConfiguration({ ...this.savedConfiguration, cwd: selected });
    this.savedConfiguration = { ...this.savedConfiguration, cwd: selected };
    return selected;
  }

  getSavedConfiguration(): CodexSavedConfiguration {
    return this.savedConfiguration;
  }

  private async candidates(): Promise<Array<{ path: string; source: CodexDiscoverySource }>> {
    const result: Array<{ path: string; source: CodexDiscoverySource }> = [];
    const envExecutable = this.options.env?.CODEX_EXECUTABLE?.trim();
    if (envExecutable !== undefined && envExecutable !== "") result.push({ path: envExecutable, source: "environment" });
    const savedExecutable = this.savedConfiguration.executablePath?.trim();
    if (savedExecutable !== undefined && savedExecutable !== "") result.push({ path: savedExecutable, source: "saved" });
    for (const pathCandidate of await this.pathCandidates()) result.push({ path: pathCandidate, source: "path" });
    for (const pathCandidate of await this.knownInstallCandidates()) result.push({ path: pathCandidate, source: "known-install" });
    const seen = new Set<string>();
    return result.filter((candidate) => {
      const key = normalize(candidate.path).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async pathCandidates(): Promise<string[]> {
    const pathValue = this.options.env?.PATH ?? "";
    const names = this.options.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat"] : ["codex"];
    const candidates: string[] = [];
    for (const directory of pathValue.split(delimiter).filter((item) => item !== "")) {
      for (const name of names) {
        const candidate = join(directory, name);
        if (await isFile(candidate)) candidates.push(candidate);
      }
    }
    return candidates;
  }

  private async knownInstallCandidates(): Promise<string[]> {
    if (this.options.platform !== "win32") return [];
    const localAppData = this.options.localAppData ?? this.options.env?.LOCALAPPDATA;
    if (localAppData === undefined || localAppData.trim() === "") return [];
    const root = join(localAppData, "OpenAI", "Codex", "bin");
    const candidates: string[] = [];
    if (await isFile(join(root, "codex.exe"))) candidates.push(join(root, "codex.exe"));
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const directory of directories) {
      const candidate = join(root, directory, "codex.exe");
      if (await isFile(candidate)) candidates.push(candidate);
    }
    return candidates;
  }

  private resolveSavedCwd(): string | undefined {
    const envCwd = this.options.env?.CODEX_CWD?.trim();
    if (envCwd !== undefined && envCwd !== "") return envCwd;
    const savedCwd = this.savedConfiguration.cwd?.trim();
    if (savedCwd !== undefined && savedCwd !== "") return savedCwd;
    return undefined;
  }

  private async validate(executablePath: string): Promise<string> {
    if (looksLikePath(executablePath) && !(await isFile(executablePath))) throw new ConfigurationError(`Codex executable does not exist: ${executablePath}`);
    if (this.options.validateExecutable !== undefined) return this.options.validateExecutable(executablePath);
    return runVersion(executablePath, this.options.platform ?? process.platform, this.options.versionTimeoutMs ?? versionTimeoutMs);
  }

  private async readSavedConfiguration(): Promise<CodexSavedConfiguration> {
    const raw = await readFile(this.options.configPath, "utf8").catch(() => undefined);
    if (raw === undefined) return {};
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
      const record = value as Record<string, unknown>;
      return {
        ...(typeof record.executablePath === "string" ? { executablePath: record.executablePath } : {}),
        ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
      };
    } catch {
      return {};
    }
  }

  private async saveConfiguration(configuration: CodexSavedConfiguration): Promise<void> {
    await mkdir(dirname(this.options.configPath), { recursive: true });
    await writeFile(this.options.configPath, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export function selectedDialogPath(canceled: boolean, filePaths: readonly string[]): string | undefined {
  return canceled ? undefined : filePaths[0];
}

async function isFile(filePath: string): Promise<boolean> {
  const file = await stat(filePath).catch(() => undefined);
  return file !== undefined && file.isFile();
}

function looksLikePath(value: string): boolean {
  return value.includes("\\") || value.includes("/") || value.toLowerCase().endsWith(".exe") || value.toLowerCase().endsWith(".cmd") || value.toLowerCase().endsWith(".bat");
}

function runVersion(executablePath: string, platform: NodeJS.Platform, timeoutMs: number): Promise<string> {
  return new Promise((resolveVersion, rejectVersion) => {
    const child = spawn(executablePath, ["--version"], {
      shell: platform === "win32" && /\.(cmd|bat)$/i.test(executablePath),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (chunk: Buffer): void => {
      if (Buffer.byteLength(output, "utf8") < maxVersionOutputBytes) output += chunk.toString("utf8").slice(0, maxVersionOutputBytes);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => finish(() => rejectVersion(new ConfigurationError(`Codex version check failed: ${error.message}`))));
    child.once("close", (code) => finish(() => {
      const version = output.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== "");
      if (code !== 0 || version === undefined) rejectVersion(new ConfigurationError(`Codex version check failed for ${executablePath}`));
      else resolveVersion(version.slice(0, 200));
    }));
    const timer = setTimeout(() => finish(() => {
      child.kill();
      rejectVersion(new ConfigurationError(`Codex version check timed out for ${executablePath}`));
    }), timeoutMs);
  });
}
