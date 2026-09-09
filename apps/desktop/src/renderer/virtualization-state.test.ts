import assert from "node:assert/strict";
import { firstItemIndexForTurnCount, visibleTurnIds } from "./virtualization-state.ts";

const performanceFixture = Array.from({ length: 10_000 }, (_, index) => `turn-${index + 1}`);
assert.equal(performanceFixture.length, 10_000);
assert.equal(new Map(performanceFixture.map((id, index) => [id, index])).get("turn-9876"), 9875);
assert.deepEqual(visibleTurnIds(performanceFixture, 4_995, 5_004), performanceFixture.slice(4_995, 5_005));
assert.equal(firstItemIndexForTurnCount(10_000), 990_000);
assert.equal(firstItemIndexForTurnCount(1_000_001), 1);
console.log("[desktop-test] virtualization state checks passed");
