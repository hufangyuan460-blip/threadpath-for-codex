import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const executable = process.env.THREADPATH_PACKAGED_EXE;
if (executable === undefined || !existsSync(executable)) throw new Error("THREADPATH_PACKAGED_EXE must point to the actual packaged executable");
const desktop = fileURLToPath(new URL("../", import.meta.url));
for (const test of ["about", "new-conversation", "branches", "branch-points", "workspace-archive"]) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", `tests/e2e/${test}.e2e.ts`], { cwd: desktop, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packaged acceptance failed: ${test} (${result.status})`);
}
