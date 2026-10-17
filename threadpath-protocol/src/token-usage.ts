import { ProtocolError, isJsonObject } from "./protocol.ts";

/** Explicit projection of the checked-in app-server v2 schema. */
export interface TokenUsageBreakdown {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  readonly total: TokenUsageBreakdown;
  readonly last: TokenUsageBreakdown;
  readonly modelContextWindow: number | null;
}

export interface ThreadTokenUsageUpdatedNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly tokenUsage: ThreadTokenUsage;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolError(`Invalid token usage field: ${field}`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProtocolError(`Invalid token usage field: ${field}`);
  }
  return value;
}

export function parseTokenUsageBreakdown(value: unknown): TokenUsageBreakdown {
  if (!isJsonObject(value)) throw new ProtocolError("Invalid token usage breakdown");
  return {
    totalTokens: count(value.totalTokens, "totalTokens"),
    inputTokens: count(value.inputTokens, "inputTokens"),
    cachedInputTokens: count(value.cachedInputTokens, "cachedInputTokens"),
    cacheWriteInputTokens: count(value.cacheWriteInputTokens, "cacheWriteInputTokens"),
    outputTokens: count(value.outputTokens, "outputTokens"),
    reasoningOutputTokens: count(value.reasoningOutputTokens, "reasoningOutputTokens"),
  };
}

export function parseThreadTokenUsageUpdatedNotification(value: unknown): ThreadTokenUsageUpdatedNotification {
  if (!isJsonObject(value) || !isJsonObject(value.tokenUsage)) throw new ProtocolError("Invalid token usage notification");
  const usage = value.tokenUsage;
  return {
    threadId: identifier(value.threadId, "threadId"),
    turnId: identifier(value.turnId, "turnId"),
    tokenUsage: {
      total: parseTokenUsageBreakdown(usage.total),
      last: parseTokenUsageBreakdown(usage.last),
      modelContextWindow: usage.modelContextWindow === null ? null : count(usage.modelContextWindow, "modelContextWindow"),
    },
  };
}
