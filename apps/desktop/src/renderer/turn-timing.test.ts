import assert from "node:assert/strict";
import { formatElapsedTime } from "./turn-timing.ts";

assert.equal(formatElapsedTime(1_000, 1_000), "00:00");
assert.equal(formatElapsedTime(1_000, 6_999), "00:05");
assert.equal(formatElapsedTime(1_000, 126_000), "02:05");
assert.equal(formatElapsedTime(5_000, 1_000), "00:00");
console.log("[desktop-test] turn timing checks passed");
