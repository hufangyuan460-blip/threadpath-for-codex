import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { BuildInfo } from "../src/shared/build-info.ts";

function git(repo: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch { return null; }
}

export function readBuildInfo(repo: string): BuildInfo {
  const manifest: unknown = JSON.parse(readFileSync(join(repo, "apps", "desktop", "package.json"), "utf8"));
  if (manifest === null || typeof manifest !== "object" || !("version" in manifest)
    || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("Desktop package version is invalid");
  }
  const root = git(repo, ["rev-parse", "--show-toplevel"]);
  // Native resolution expands Windows 8.3 aliases as well as symlinks.
  const canonical = (path: string): string => process.platform === "win32" ? realpathSync.native(path).toLowerCase() : realpathSync.native(path);
  const ownRepository = root !== null && canonical(root) === canonical(repo);
  const commit = ownRepository ? git(repo, ["rev-parse", "HEAD"]) : null;
  const status = ownRepository ? git(repo, ["status", "--porcelain", "--untracked-files=normal"]) : null;
  const tag = `v${manifest.version}`;
  return {
    version: manifest.version,
    commit: commit !== null && /^[a-f0-9]{40}$/.test(commit) ? commit : null,
    dirty: status === null || status !== "",
    tag: commit !== null && git(repo, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]) === commit ? tag : null,
  };
}

export function assertReleaseBuild(info: BuildInfo): void {
  if (info.commit === null) throw new Error("Release requires Git source provenance");
  if (info.dirty) throw new Error("Release requires a clean working tree (including untracked files)");
  if (info.tag !== `v${info.version}`) throw new Error(`Release requires tag v${info.version} at HEAD`);
}
