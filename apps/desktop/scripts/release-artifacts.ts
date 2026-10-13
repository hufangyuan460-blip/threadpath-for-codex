import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, normalize, relative } from "node:path";
import type { BuildInfo } from "../src/shared/build-info.ts";
import { assertReleaseBuild, readBuildInfo } from "./build-info.ts";

export interface ReleaseManifest extends BuildInfo {
  readonly installer: { readonly name: string; readonly bytes: number; readonly sha256: string };
}

const require = createRequire(import.meta.url);
// ASAR is supplied by the pinned builder dependency. Keep its untyped boundary here.
const builderRequire = createRequire(require.resolve("electron-builder"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const asar = appBuilderRequire("@electron/asar") as { extractFile: (archive: string, filename: string) => Buffer };
const builderUtilRequire = createRequire(builderRequire.resolve("builder-util"));
const { path7za } = builderUtilRequire("7zip-bin") as { path7za: string };

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

export async function inspectArtifacts(repo: string, info: BuildInfo): Promise<ReleaseManifest> {
  const desktop = join(repo, "apps", "desktop");
  const out = join(desktop, "out");
  const release = join(repo, "release");
  const archive = join(release, "win-unpacked", "resources", "app.asar");
  assert.deepEqual(JSON.parse(await readFile(join(out, "main", "build-info.json"), "utf8")), info, "Build metadata differs from source");
  const packagedManifest: unknown = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  assert.ok(packagedManifest !== null && typeof packagedManifest === "object" && "version" in packagedManifest);
  assert.equal(packagedManifest.version, info.version, "Packaged app version differs from source");
  for (const path of await files(out)) {
    assert.ok(asar.extractFile(archive, normalize(join("out", relative(out, path)))).equals(await readFile(path)), `Packaged file differs: ${relative(out, path)}`);
  }
  assert.ok((await readFile(join(release, "win-unpacked", "resources", "icon.ico"))).equals(await readFile(join(desktop, "build", "icon.ico"))), "Packaged runtime icon differs");
  const name = `ThreadPath for Codex Setup ${info.version}.exe`;
  const installerPath = join(release, name);
  const installer = await readFile(installerPath);
  assert.equal(installer.subarray(0, 2).toString(), "MZ", "Installer is not a Windows executable");
  // Inspect the compressed NSIS payload without running/installing the installer.
  const installedAsar = execFileSync(path7za, ["e", "-so", installerPath, "resources\\app.asar"], { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  assert.ok(installedAsar.equals(await readFile(archive)), "Installer payload differs from the tested packaged app");
  return { ...info, installer: { name, bytes: installer.length, sha256: createHash("sha256").update(installer).digest("hex") } };
}

export function manifestName(version: string): string { return `ThreadPath-${version}-build.json`; }
export function sumsName(version: string): string { return `ThreadPath-${version}-SHA256SUMS.txt`; }
export function checksumText(manifest: ReleaseManifest): string {
  // GitHub normalizes spaces in asset names to dots.
  return `${manifest.installer.sha256}  ${manifest.installer.name.replaceAll(" ", ".")}\n`;
}

export async function writeReleaseArtifacts(repo: string, info: BuildInfo): Promise<void> {
  const manifest = await inspectArtifacts(repo, info);
  await writeFile(join(repo, "release", manifestName(info.version)), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(repo, "release", sumsName(info.version)), checksumText(manifest));
}

export async function verifyReleaseArtifacts(repo: string): Promise<ReleaseManifest> {
  const info = readBuildInfo(repo);
  assertReleaseBuild(info);
  const manifest = await inspectArtifacts(repo, info);
  assert.deepEqual(JSON.parse(await readFile(join(repo, "release", manifestName(info.version)), "utf8")), manifest, "Installer manifest differs from artifact/source");
  assert.equal(await readFile(join(repo, "release", sumsName(info.version)), "utf8"), checksumText(manifest), "Installer checksum file differs");
  return manifest;
}
