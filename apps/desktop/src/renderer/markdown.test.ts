import assert from "node:assert/strict";
import { parseMarkdown } from "./markdown.ts";

const tokens = parseMarkdown("# Title\n\n**bold** and `code`\n\n- [x] done\n- open\n\n> quote\n\n```ts\nconst value = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |");
const contentTokens = tokens.filter((token) => token.type !== "space");
const types = contentTokens.map((token) => token.type);
assert.deepEqual(types, ["heading", "paragraph", "list", "blockquote", "code", "table"]);
assert.equal(contentTokens[0]?.type, "heading");
assert.equal(contentTokens[2]?.type, "list");
assert.equal(contentTokens[2]?.type === "list" ? contentTokens[2].items[0]?.task : false, true);
assert.equal(contentTokens[2]?.type === "list" ? contentTokens[2].items[0]?.checked : false, true);
assert.equal(contentTokens[4]?.type === "code" ? contentTokens[4].lang : undefined, "ts");
assert.equal(contentTokens[5]?.type, "table");

const unsafe = parseMarkdown("<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))");
assert.ok(unsafe.some((token) => token.type === "html"));
assert.ok(unsafe.some((token) => token.type === "paragraph"));
console.log("[desktop-test] markdown checks passed");
