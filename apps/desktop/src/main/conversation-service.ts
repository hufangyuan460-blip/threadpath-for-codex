import { type JsonValue, type Thread, type Turn, type TurnItem } from "../../../../threadpath-protocol/src/protocol.ts";
import type { ConversationItemView, ConversationThreadView, ConversationTurnView } from "../shared/api";
import { type ThreadClientProvider, validateThreadId } from "./thread-service.ts";

const MAX_DISPLAY_SUMMARY_LENGTH = 500;

export class ConversationService {
  private readonly clientProvider: ThreadClientProvider;

  constructor(clientProvider: ThreadClientProvider) {
    this.clientProvider = clientProvider;
  }

  async readThread(threadId: unknown): Promise<ConversationThreadView> {
    const validThreadId = validateThreadId(threadId);
    const thread = await this.clientProvider.getReadyClient().readThread(validThreadId);
    return toConversationThreadView(thread);
  }
}

export function toConversationThreadView(thread: Thread): ConversationThreadView {
  return {
    id: thread.id,
    title: thread.title?.trim() || "Untitled thread",
    status: thread.status?.trim() || "unknown",
    turns: (thread.turns ?? []).map((turn, index) => toConversationTurnView(turn, index)),
  };
}

function toConversationTurnView(turn: Turn, index: number): ConversationTurnView {
  return {
    id: turn.id,
    index: index + 1,
    status: turn.status?.trim() || "unknown",
    ...(turn.createdAt === undefined ? {} : { createdAt: turn.createdAt }),
    items: (turn.items ?? []).map((item, itemIndex) => toConversationItemView(item, turn.id, itemIndex)),
  };
}

function toConversationItemView(item: TurnItem, turnId: string, itemIndex: number): ConversationItemView {
  const id = item.id?.trim() || `${turnId}:item-${itemIndex + 1}`;
  const type = item.type?.trim().toLowerCase() ?? "";
  const text = displayText(item.text ?? item.content);
  const role = textRole(item, type);

  if (role !== undefined) return { kind: "text", id, role, text: text || "(No text provided)" };

  if (isToolItem(item, type)) {
    const status = toolStatus(item.status);
    const name = item.name?.trim() || toolName(type);
    const summary = displayText(item.summary ?? item.aggregatedOutput);
    return {
      kind: "tool",
      id,
      name,
      status,
      ...(summary === "" ? {} : { summary: limitDisplayText(summary) }),
    };
  }

  const description = text || (type === "" ? "Unknown conversation item" : `Unsupported item type: ${type}`);
  return { kind: "status", id, text: limitDisplayText(description) };
}

function textRole(item: TurnItem, type: string): "user" | "assistant" | "system" | undefined {
  const role = item.role?.trim().toLowerCase();
  if (role === "user" || role === "assistant" || role === "system") return role;
  if (type.includes("user")) return "user";
  if (type.includes("agent") || type.includes("assistant")) return "assistant";
  if (type.includes("system")) return "system";
  return undefined;
}

function isToolItem(item: TurnItem, type: string): boolean {
  return item.name !== undefined || item.command !== undefined || /tool|command|execution|function|search/.test(type);
}

function toolName(type: string): string {
  return type === "" ? "Tool" : type;
}

function toolStatus(value: string | undefined): "running" | "completed" | "failed" | "unknown" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "running" || normalized === "in_progress") return "running";
  if (normalized === "completed" || normalized === "complete" || normalized === "succeeded") return "completed";
  if (normalized === "failed" || normalized === "error") return "failed";
  return "unknown";
}

function displayText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => displayText(item)).filter((item) => item !== "").join("\n");
  if (value !== null && typeof value === "object") {
    const text = displayText(value.text);
    if (text !== "") return text;
    return displayText(value.content);
  }
  return "";
}

function limitDisplayText(value: string): string {
  return value.length <= MAX_DISPLAY_SUMMARY_LENGTH ? value : `${value.slice(0, MAX_DISPLAY_SUMMARY_LENGTH)}…`;
}
