import assert from "node:assert/strict";
import { preserveScrollTop } from "./scroll-preservation.ts";

assert.equal(preserveScrollTop(240, 1600, 1900), 540);
assert.equal(preserveScrollTop(0, 1600, 1600), 0);
assert.equal(preserveScrollTop(100, Number.NaN, 1900), 100);
console.log("[desktop-test] scroll preservation checks passed");
