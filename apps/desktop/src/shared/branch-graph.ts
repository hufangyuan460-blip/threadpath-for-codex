import type { ThreadBranch } from "./api.ts";

export interface BranchGraphNode { readonly id: string; readonly x: number; readonly y: number; }
export interface BranchGraphEdge { readonly source: string; readonly target: string; readonly onPath: boolean; }
export interface BranchGraph { readonly nodes: readonly BranchGraphNode[]; readonly edges: readonly BranchGraphEdge[]; readonly pathIds: ReadonlySet<string>; readonly width: number; readonly height: number; }

/** A deterministic tree projection of explicit fork facts, never inferred from timestamps or sessionId. */
export function branchGraph(branches: readonly ThreadBranch[], selectedId: string): BranchGraph {
  const byChild = new Map(branches.filter((branch) => branch.threadId !== branch.sourceThreadId).map((branch) => [branch.threadId, branch]));
  const neighbors = new Map<string, Set<string>>();
  for (const branch of byChild.values()) {
    for (const [from, to] of [[branch.sourceThreadId, branch.threadId], [branch.threadId, branch.sourceThreadId]]) {
      const related = neighbors.get(from) ?? new Set<string>();
      related.add(to);
      neighbors.set(from, related);
    }
  }
  const connected = new Set<string>([selectedId]);
  const pending = [selectedId];
  for (let index = 0; index < pending.length; index++) {
    for (const id of neighbors.get(pending[index]) ?? []) if (!connected.has(id)) { connected.add(id); pending.push(id); }
  }
  const pathIds = new Set<string>();
  let root = selectedId;
  while (!pathIds.has(root)) {
    pathIds.add(root);
    const source = byChild.get(root)?.sourceThreadId;
    if (source === undefined || pathIds.has(source)) break;
    root = source;
  }
  const children = new Map<string, string[]>();
  for (const branch of [...byChild.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.threadId.localeCompare(b.threadId))) {
    if (!connected.has(branch.threadId)) continue;
    const entries = children.get(branch.sourceThreadId) ?? [];
    entries.push(branch.threadId);
    children.set(branch.sourceThreadId, entries);
  }
  const nodes: BranchGraphNode[] = [];
  const edges: BranchGraphEdge[] = [];
  const seen = new Set<string>();
  // Iterative traversal avoids recursion limits on long nested branch histories.
  const work: Array<{ id: string; depth: number; source?: string }> = [{ id: root, depth: 0 }];
  while (work.length > 0) {
    const entry = work.pop()!;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    nodes.push({ id: entry.id, x: entry.depth * 240 + 12, y: 0 });
    if (entry.source !== undefined) edges.push({ source: entry.source, target: entry.id, onPath: pathIds.has(entry.source) && pathIds.has(entry.id) });
    for (const id of [...(children.get(entry.id) ?? [])].reverse()) if (!seen.has(id)) work.push({ id, depth: entry.depth + 1, source: entry.id });
  }
  const projectedChildren = new Map<string, string[]>();
  for (const edge of edges) {
    const entries = projectedChildren.get(edge.source) ?? [];
    entries.push(edge.target);
    projectedChildren.set(edge.source, entries);
  }
  const vertical = new Map<string, number>();
  let leaf = nodes.filter((node) => !projectedChildren.has(node.id)).length - 1;
  for (const node of [...nodes].reverse()) {
    const childIds = projectedChildren.get(node.id) ?? [];
    vertical.set(node.id, childIds.length === 0 ? leaf-- * 132 + 12 : (vertical.get(childIds[0])! + vertical.get(childIds.at(-1)!)!) / 2);
  }
  // Align a parent between its children; a long single route occupies one row.
  const positioned = nodes.map((node) => ({ ...node, y: vertical.get(node.id)! }));
  return { nodes: positioned, edges, pathIds, width: Math.max(220, ...positioned.map((node) => node.x + 220)), height: Math.max(128, ...positioned.map((node) => node.y + 128)) };
}
