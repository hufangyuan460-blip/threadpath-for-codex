import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceIdentityResolver, workspaceKey } from "./workspace-path.ts";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "threadpath-path-"));
  const nested = join(root, "nested");
  await mkdir(nested);
  const resolver = new WorkspaceIdentityResolver({ gitExecutable: "missing-git-for-test" });
  const identity = await resolver.resolve(nested);
  assert.ok(identity);
  assert.equal(identity?.workingDirectory, (await resolver.resolve(nested))?.workingDirectory);
  assert.equal(workspaceKey(identity?.root ?? ""), identity?.key);
  assert.equal(await resolver.resolve(join(root, "missing")), undefined);
  assert.equal(workspaceKey("C:/Work/Project/"), workspaceKey("c:\\work\\project"));

  const concurrent = new WorkspaceIdentityResolver({ gitExecutable: "missing-git-for-test" });
  const [one, two] = await Promise.all([concurrent.resolve(nested), concurrent.resolve(join(root, ".\\nested"))]);
  assert.equal(one?.key, two?.key);
  concurrent.invalidate(nested);
  assert.equal(concurrent.getCached(nested), undefined);
  console.log("[desktop-test] workspace path checks passed");
}

main().catch((error: unknown) => { console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
