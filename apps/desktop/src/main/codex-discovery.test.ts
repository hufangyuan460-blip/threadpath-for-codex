import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError } from "../../../../threadpath-protocol/src/protocol.ts";
import { CodexDiscoveryService, selectedDialogPath } from "./codex-discovery.ts";

interface TestPaths {
  readonly root: string;
  readonly configPath: string;
  readonly cwd: string;
  readonly pathDirectory: string;
  readonly localAppData: string;
}

async function createTestPaths(): Promise<TestPaths> {
  const root = await mkdtemp(join(tmpdir(), "threadpath-discovery-"));
  const paths = {
    root,
    configPath: join(root, "config.json"),
    cwd: join(root, "project"),
    pathDirectory: join(root, "path-bin"),
    localAppData: join(root, "local-app-data"),
  };
  await Promise.all([
    writeFile(join(paths.root, "environment.exe"), "test"),
    writeFile(join(paths.root, "saved.exe"), "test"),
    writeFile(join(paths.root, "path-bin", "codex.exe"), "test").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(paths.pathDirectory, { recursive: true });
      await writeFile(join(paths.pathDirectory, "codex.exe"), "test");
    }),
    writeFile(join(paths.cwd, ".keep"), "test").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(paths.cwd, { recursive: true });
      await writeFile(join(paths.cwd, ".keep"), "test");
    }),
  ]);
  return paths;
}

function validator(accepted: Set<string>, calls: string[]): (path: string) => Promise<string> {
  return async (path: string): Promise<string> => {
    calls.push(path);
    if (!accepted.has(path)) throw new ConfigurationError(`invalid candidate: ${path}`);
    return "codex 0.1.0";
  };
}

async function testEnvironmentPriority(): Promise<void> {
  const paths = await createTestPaths();
  const environment = join(paths.root, "environment.exe");
  const saved = join(paths.root, "saved.exe");
  await writeFile(paths.configPath, JSON.stringify({ executablePath: saved, cwd: paths.cwd }));
  const calls: string[] = [];
  const service = new CodexDiscoveryService({ configPath: paths.configPath, platform: "win32", env: { CODEX_EXECUTABLE: environment, PATH: paths.pathDirectory }, validateExecutable: validator(new Set([environment]), calls) });
  const result = await service.discover();
  assert.equal(result.executablePath, environment);
  assert.equal(result.source, "environment");
  assert.deepEqual(calls, [environment]);
}

async function testSavedAndPathPriority(): Promise<void> {
  const paths = await createTestPaths();
  const saved = join(paths.root, "saved.exe");
  await writeFile(paths.configPath, JSON.stringify({ executablePath: saved, cwd: paths.cwd }));
  const savedCalls: string[] = [];
  const savedService = new CodexDiscoveryService({ configPath: paths.configPath, platform: "win32", env: { PATH: paths.pathDirectory }, validateExecutable: validator(new Set([saved]), savedCalls) });
  assert.equal((await savedService.discover()).source, "saved");
  const pathCalls: string[] = [];
  const pathExecutable = join(paths.pathDirectory, "codex.exe");
  const pathService = new CodexDiscoveryService({ configPath: join(paths.root, "path-config.json"), platform: "win32", env: { PATH: paths.pathDirectory }, validateExecutable: validator(new Set([pathExecutable]), pathCalls) });
  const result = await pathService.discover();
  assert.equal(result.source, "path");
  assert.deepEqual(pathCalls, [pathExecutable]);
}

async function testKnownInstallAndInvalidSavedRecovery(): Promise<void> {
  const paths = await createTestPaths();
  const knownExecutable = join(paths.localAppData, "OpenAI", "Codex", "bin", "1.2.3", "codex.exe");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(paths.localAppData, "OpenAI", "Codex", "bin", "1.2.3"), { recursive: true });
  await writeFile(knownExecutable, "test");
  await writeFile(paths.configPath, JSON.stringify({ executablePath: join(paths.root, "missing.exe"), cwd: paths.cwd }));
  const calls: string[] = [];
  const service = new CodexDiscoveryService({ configPath: paths.configPath, platform: "win32", localAppData: paths.localAppData, env: {}, validateExecutable: validator(new Set([knownExecutable]), calls) });
  const result = await service.discover();
  assert.equal(result.source, "known-install");
  assert.equal(result.executablePath, knownExecutable);
  const saved = JSON.parse(await readFile(paths.configPath, "utf8")) as { executablePath?: string };
  assert.equal(saved.executablePath, knownExecutable);
}

async function testValidationFailureAndSelection(): Promise<void> {
  const paths = await createTestPaths();
  const environment = join(paths.root, "environment.exe");
  const pathExecutable = join(paths.pathDirectory, "codex.exe");
  const calls: string[] = [];
  const service = new CodexDiscoveryService({ configPath: paths.configPath, platform: "win32", env: { CODEX_EXECUTABLE: environment, PATH: paths.pathDirectory }, validateExecutable: validator(new Set([pathExecutable]), calls) });
  const result = await service.discover();
  assert.equal(result.source, "path");
  assert.deepEqual(calls, [environment, pathExecutable]);
  const manual = await service.selectExecutable(pathExecutable);
  assert.equal(manual.source, "manual");
  const selected = await service.selectWorkingDirectory(paths.cwd);
  assert.equal(selected, paths.cwd);
  await assert.rejects(() => service.selectWorkingDirectory(join(paths.root, "missing-directory")), ConfigurationError);
}

function testDialogCancellation(): void {
  assert.equal(selectedDialogPath(true, ["C:\\ignored.exe"]), undefined);
  assert.equal(selectedDialogPath(false, []), undefined);
  assert.equal(selectedDialogPath(false, ["C:\\selected.exe"]), "C:\\selected.exe");
}

async function testVersionTimeout(): Promise<void> {
  const paths = await createTestPaths();
  const executable = join(paths.root, "slow.cmd");
  await writeFile(executable, "@echo off\r\nping 127.0.0.1 -n 5 > nul\r\n", "utf8");
  const service = new CodexDiscoveryService({ configPath: paths.configPath, platform: "win32", versionTimeoutMs: 20, env: {} });
  await assert.rejects(() => service.selectExecutable(executable), /timed out|version check failed/u);
}

async function main(): Promise<void> {
  await testEnvironmentPriority();
  await testSavedAndPathPriority();
  await testKnownInstallAndInvalidSavedRecovery();
  await testValidationFailureAndSelection();
  testDialogCancellation();
  await testVersionTimeout();
  console.log("[desktop-test] Codex discovery checks passed");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
