import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseBuild, readBuildInfo } from "./build-info.ts";
import { writeReleaseArtifacts } from "./release-artifacts.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const desktop = join(repo, "apps", "desktop");
const require = createRequire(import.meta.url);
const release = process.argv.includes("--release");
const info = readBuildInfo(repo);
if (release) assertReleaseBuild(info);

function run(script: string, args: readonly string[]): void {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: desktop, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packaging command failed (${result.status})`);
}

run(join(dirname(require.resolve("electron-vite/package.json")), "bin", "electron-vite.js"), ["build"]);
run(require.resolve("electron-builder/cli.js"), ["--win", "nsis", "--x64"]);
assert.deepEqual(readBuildInfo(repo), info, "Source changed while packaging; discard this build");
await writeReleaseArtifacts(repo, info);
console.log(`[package] verified ${info.version} from ${info.commit ?? "unknown"}${info.dirty ? " (development changes)" : ""}`);
