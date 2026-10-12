import assert from "node:assert/strict";
import { inheritedTurnIds, locateBranchPoint } from "./branch-navigation.ts";
import type { ConversationThreadView } from "../shared/api.ts";

function view(ids: string[], cursor?: string, id = "source"): ConversationThreadView {
  return { id, title: "Source", status: "idle", turns: ids.map((turnId, index) => ({ id: turnId, index: index + 1, status: "completed", items: [] })), outline: [], paging: { firstItemIndex: 1000, orderedTurnIds: ids, hasMore: cursor !== undefined, ...(cursor === undefined ? {} : { nextCursor: cursor }), isLoadingMore: false } };
}
async function main(): Promise<void> {
  let calls = 0;
  const pages = [view(["middle", "later"], "oldest"), view(["base", "middle", "later"])];
  const found = await locateBranchPoint(view(["later"], "older"), "base", async () => { calls++; return pages.shift()!; }, () => true);
  assert.equal(found.outcome, "found");
  assert.equal(calls, 2);
  const missing = await locateBranchPoint(view(["later"]), "deleted", async () => { throw new Error("must not load without a cursor"); }, () => true);
  assert.equal(missing.outcome, "missing");
  let current = true;
  const cancelled = await locateBranchPoint(view(["later"], "older"), "base", async () => { current = false; return view(["base", "later"]); }, () => current);
  assert.equal(cancelled.outcome, "cancelled", "a late response must not trigger an old navigation");
  await assert.rejects(locateBranchPoint(view(["later"], "same"), "base", async () => view(["later"], "same"), () => true), /did not advance/, "broken pagination must fail instead of reporting a deleted turn");
  await assert.rejects(locateBranchPoint(view(["later"], "older"), "base", async () => { throw new Error("offline"); }, () => true), /offline/);
  await assert.rejects(locateBranchPoint(view(["later"], "older"), "base", async () => view(["base"], undefined, "other"), () => true), /another conversation/);
  assert.deepEqual([...inheritedTurnIds(view(["base", "cutoff", "new"]), "cutoff") ?? []], ["base", "cutoff"]);
  assert.equal(inheritedTurnIds(view(["new"]), "unloaded"), undefined, "missing boundary must not guess inherited membership");
  assert.deepEqual([...inheritedTurnIds(view(["base"]), "base") ?? []], ["base"]);
  console.log("[desktop-test] branch-point pagination, cancellation, missing turn and history boundary checks passed");
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
