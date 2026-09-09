import assert from "node:assert/strict";
import { chooseActiveTurnId, chooseActiveTurnIdFromRange, type TurnRectSnapshot } from "./scroll-state.ts";

function main(): void {
  const turns: TurnRectSnapshot[] = [
    { turnId: "turn-1", top: -180, bottom: -20 },
    { turnId: "turn-2", top: 10, bottom: 170 },
    { turnId: "turn-3", top: 190, bottom: 350 },
    { turnId: "turn-4", top: 700, bottom: 860 },
  ];
  assert.equal(chooseActiveTurnId(turns, 0, 600), "turn-2");
  assert.equal(chooseActiveTurnId(turns, 180, 600), "turn-3");
  assert.equal(chooseActiveTurnId(turns, 400, 600), "turn-3");
  assert.equal(chooseActiveTurnId(turns, 0, 0), undefined);
  assert.equal(chooseActiveTurnId([], 0, 600), undefined);
  assert.equal(chooseActiveTurnId([{ turnId: "upper", top: -500, bottom: -10 }, { turnId: "lower", top: 700, bottom: 900 }], 0, 600), "upper");
  assert.equal(chooseActiveTurnIdFromRange(["turn-1", "turn-2", "turn-3"], { startIndex: 1, endIndex: 2 }), "turn-2");
  assert.equal(chooseActiveTurnIdFromRange(["turn-1"], { startIndex: 9, endIndex: 9 }), "turn-1");
  assert.equal(chooseActiveTurnIdFromRange([], { startIndex: 0, endIndex: 0 }), undefined);
  console.log("[desktop-test] scroll state checks passed");
}

main();
