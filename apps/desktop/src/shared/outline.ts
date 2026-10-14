import type { ConversationItemView, ConversationTurnView, TurnOutlineEntry } from "./api.ts";

const MAX_OUTLINE_LABEL_LENGTH = 80;

export interface MessageOutlineEntry extends TurnOutlineEntry {
  readonly itemId?: string;
  readonly role: "user" | "assistant" | "status";
}

// Keep the turn summaries used by search and branch labels separate from the message directory.
export function buildMessageOutline(turns: readonly ConversationTurnView[]): MessageOutlineEntry[] {
  return turns.flatMap((turn) => {
    const entries: MessageOutlineEntry[] = [];
    let assistantIndex: number | undefined;
    for (const item of turn.items) {
      if (item.kind !== "text" || (item.role !== "user" && item.role !== "assistant") || item.text.trim() === "") continue;
      const entry: MessageOutlineEntry = { turnId: turn.id, itemId: item.id, index: turn.index, role: item.role, label: compactLabel(item.text), status: turn.status };
      // A response may contain progress messages and tool cycles. Its last non-empty
      // model message represents the whole response, including after history reload.
      if (item.role === "assistant" && assistantIndex !== undefined) entries[assistantIndex] = entry;
      else {
        if (item.role === "assistant") assistantIndex = entries.length;
        entries.push(entry);
      }
    }
    return entries.length > 0 ? entries : [{ turnId: turn.id, index: turn.index, role: "status", label: outlineLabel(turn), status: turn.status }];
  });
}

export function buildTurnOutline(turns: readonly ConversationTurnView[]): TurnOutlineEntry[] {
  return turns.map((turn) => ({
    turnId: turn.id,
    index: turn.index,
    label: outlineLabel(turn),
    status: turn.status,
  }));
}

function outlineLabel(turn: ConversationTurnView): string {
  const userText = firstText(turn.items, "user");
  if (userText !== undefined) return compactLabel(userText);
  const assistantText = firstText(turn.items, "assistant");
  if (assistantText !== undefined) return compactLabel(assistantText);
  const statusText = turn.items.find((item): item is Extract<ConversationItemView, { kind: "status" }> => item.kind === "status")?.text;
  if (statusText !== undefined && statusText.trim() !== "") return compactLabel(statusText);
  return `Turn ${turn.index}`;
}

function firstText(items: readonly ConversationItemView[], role: "user" | "assistant"): string | undefined {
  return items.find((item): item is Extract<ConversationItemView, { kind: "text" }> => item.kind === "text" && item.role === role)?.text;
}

function compactLabel(value: string): string {
  const cleaned = value.replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length <= MAX_OUTLINE_LABEL_LENGTH) return cleaned || "Untitled turn";
  return `${cleaned.slice(0, MAX_OUTLINE_LABEL_LENGTH - 1).trimEnd()}…`;
}
