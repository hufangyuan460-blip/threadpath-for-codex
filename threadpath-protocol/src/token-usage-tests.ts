import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ProtocolError } from "./protocol.ts";
import { parseThreadTokenUsageUpdatedNotification as parse, parseTokenUsageBreakdown } from "./token-usage.ts";

const lines: { params: unknown }[] = (await readFile(new URL("../fixtures/token-usage.jsonl", import.meta.url), "utf8")).trim().split(/\r?\n/).map((line: string) => JSON.parse(line) as { params: unknown });
const normal = parse(lines[0].params);
assert.equal(normal.tokenUsage.total.totalTokens, 60321);
assert.equal(normal.tokenUsage.last.cacheWriteInputTokens, 200);
assert.deepEqual(parse(lines[1].params), normal, "duplicate is the same absolute snapshot");
assert.equal(parse(lines[2].params).tokenUsage.modelContextWindow, null);
assert.throws(() => parse(lines[3].params), ProtocolError);
assert.deepEqual(parse(lines[6].params), normal, "resume replay has the same payload contract");
const counter = normal.tokenUsage.total;
for (const key of Object.keys(counter)) {
  const missing: Record<string, unknown> = { ...counter };
  delete missing[key];
  assert.throws(() => parseTokenUsageBreakdown(missing), ProtocolError, `${key} must not default to zero`);
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "12", null]) {
    assert.throws(() => parseTokenUsageBreakdown({ ...counter, [key]: invalid }), ProtocolError);
  }
}
for (const invalid of [undefined, null, [], {}, { threadId: "x" }]) assert.throws(() => parse(invalid), ProtocolError);
for (const invalid of [undefined, -1, 0.5, "475000"]) assert.throws(() => parse({ ...normal, tokenUsage: { ...normal.tokenUsage, modelContextWindow: invalid } }), ProtocolError);
assert.throws(() => parse({ ...normal, turnId: " " }), ProtocolError);
assert.throws(() => parse({ ...normal, threadId: 1 }), ProtocolError);
assert.deepEqual(parse({ ...normal, secretExtra: "discarded", tokenUsage: { ...normal.tokenUsage, secretExtra: true, total: { ...counter, secretExtra: true } } }), normal, "unknown fields never pass through");
console.log("[token-usage] passed strict parsing, null window, invalid fields, duplicate and resume fixtures");
