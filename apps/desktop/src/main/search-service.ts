import type { ConversationItemView, ConversationThreadView, SearchMatchKind, SearchResult } from "../shared/api";

const MAX_SNIPPET_LENGTH = 160;

export function searchLoadedTurns(thread: ConversationThreadView, query: string): SearchResult[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery === "") return [];
  const results = thread.turns.flatMap((turn) => {
    const scored = turnCandidates(thread, turn).map((candidate) => scoreCandidate(candidate, normalizedQuery)).filter((candidate): candidate is ScoredCandidate => candidate !== undefined);
    const best = scored.sort((left, right) => right.score - left.score || left.priority - right.priority)[0];
    if (best === undefined) return [];
    return [{ turnId: turn.id, index: turn.index, label: thread.outline.find((entry) => entry.turnId === turn.id)?.label ?? `Turn ${turn.index}`, snippet: toSnippet(best.value), matchKind: best.kind, score: best.score }];
  });
  return results.sort((left, right) => right.score - left.score || left.index - right.index || left.turnId.localeCompare(right.turnId));
}

interface SearchCandidate { kind: SearchMatchKind; value: string; priority: number; }
interface ScoredCandidate extends SearchCandidate { score: number; }

function turnCandidates(thread: ConversationThreadView, turn: ConversationThreadView["turns"][number]): SearchCandidate[] {
  const userText = textForRole(turn.items, "user");
  const assistantText = textForRole(turn.items, "assistant");
  const statusText = turn.items.map((item) => item.kind === "status" ? item.text : item.kind === "tool" ? `${item.name} ${item.status}` : "").filter((value) => value !== "").join(" ");
  const label = thread.outline.find((entry) => entry.turnId === turn.id)?.label ?? `Turn ${turn.index}`;
  return [
    { kind: "title", value: label, priority: 4 },
    ...(userText === undefined ? [] : [{ kind: "user" as const, value: userText, priority: 4 }]),
    ...(assistantText === undefined ? [] : [{ kind: "assistant" as const, value: assistantText, priority: 2 }]),
    { kind: "status", value: `${turn.status} ${statusText}`.trim(), priority: 1 },
  ];
}

function textForRole(items: readonly ConversationItemView[], role: "user" | "assistant"): string | undefined {
  const value = items.filter((item): item is Extract<ConversationItemView, { kind: "text" }> => item.kind === "text" && item.role === role).map((item) => item.text).join(" ").trim();
  return value === "" ? undefined : value;
}

function scoreCandidate(candidate: SearchCandidate, query: string): ScoredCandidate | undefined {
  const value = candidate.value.toLocaleLowerCase();
  const position = value.indexOf(query);
  if (position < 0) return undefined;
  const matchWeight = value === query ? 300 : position === 0 ? 200 : 100;
  return { ...candidate, score: candidate.priority * 1_000 + matchWeight - position };
}

function toSnippet(value: string): string {
  const cleaned = value.replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length <= MAX_SNIPPET_LENGTH ? cleaned : `${cleaned.slice(0, MAX_SNIPPET_LENGTH - 1).trimEnd()}…`;
}
