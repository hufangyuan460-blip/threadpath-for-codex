import assert from "node:assert/strict";
import { branchGraph } from "./branch-graph.ts";
import type { ThreadBranch } from "./api.ts";
function branch(threadId: string, sourceThreadId: string): ThreadBranch { return { threadId, sourceThreadId, forkTurnId: "cutoff", forkLabel: "Synthetic context", createdAt: "2026-10-12T00:00:00Z", readOnly: true }; }
const graph = branchGraph([branch("a", "root"), branch("b", "root"), branch("nested", "a"), branch("unrelated", "other")], "nested");
assert.deepEqual(graph.nodes.map((node) => node.id), ["root", "a", "nested", "b"]);
assert.deepEqual([...graph.pathIds], ["nested", "a", "root"]);
assert.deepEqual(graph.edges.filter((edge) => edge.onPath).map((edge) => edge.target), ["a", "nested"]);
assert.equal(new Set(graph.nodes.map((node) => `${node.x}:${node.y}`)).size, graph.nodes.length);
assert.deepEqual(branchGraph([], "single").nodes.map((node) => node.id), ["single"]);
assert.equal(branchGraph([branch("a", "b"), branch("b", "a")], "a").nodes.length, 2, "malformed persisted cycles must terminate");
assert.equal(branchGraph(Array.from({ length: 3000 }, (_, i) => branch(`node-${i + 1}`, `node-${i}`)), "node-3000").nodes.length, 3001);
console.log("[desktop-test] branch graph ancestry, isolation and corrupt-cycle checks passed");
