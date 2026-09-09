import assert from "node:assert/strict";
import type { SearchResult } from "../shared/api.ts";
import { moveSearchSelection, searchNavigationTarget } from "./search-navigation.ts";

function main(): void {
  const results: SearchResult[] = [
    { turnId: "turn-1", index: 1, label: "First", snippet: "first", matchKind: "title", score: 1 },
    { turnId: "turn-2", index: 2, label: "Second", snippet: "second", matchKind: "user", score: 1 },
  ];
  assert.equal(moveSearchSelection(-1, results.length, "next"), 0);
  assert.equal(moveSearchSelection(0, results.length, "next"), 1);
  assert.equal(moveSearchSelection(1, results.length, "next"), 1);
  assert.equal(moveSearchSelection(1, results.length, "previous"), 0);
  assert.equal(moveSearchSelection(0, results.length, "previous"), 0);
  assert.equal(moveSearchSelection(-1, 0, "next"), -1);
  assert.equal(searchNavigationTarget(results, 1), "turn-2");
  assert.equal(searchNavigationTarget(results, -1), undefined);
  console.log("[desktop-test] search navigation checks passed");
}

main();
