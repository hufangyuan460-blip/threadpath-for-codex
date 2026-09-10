import type { ConversationItemView, ConversationThreadView, ConversationTurnView, ConversationUpdate } from "./api.ts";
import { buildTurnOutline } from "./outline.ts";

export function conversationUpdateKey(update: ConversationUpdate): string {
  return JSON.stringify(update);
}

export function applyConversationUpdate(thread: ConversationThreadView, update: ConversationUpdate): ConversationThreadView {
  if (update.threadId !== thread.id) return thread;
  const turnIndex = thread.turns.findIndex((turn) => turn.id === update.turnId);
  const existingTurn = turnIndex < 0 ? undefined : thread.turns[turnIndex];
  const turn = existingTurn ?? { id: update.turnId, index: thread.turns.length + 1, status: "running", items: [] };
  const nextTurn = updateTurn(turn, update);
  if (existingTurn !== undefined && nextTurn === existingTurn) return thread;
  const turns = [...thread.turns];
  if (turnIndex < 0) turns.push(nextTurn);
  else turns[turnIndex] = nextTurn;
  const nextThread = {
    ...thread,
    turns,
    outline: buildTurnOutline(turns),
    paging: { ...thread.paging, orderedTurnIds: turns.map((item) => item.id) },
  };
  if (update.type === "turn/started") return { ...nextThread, remoteActive: true, remoteActiveTurnId: update.turnId };
  if (update.type === "turn/completed" || update.type === "turn/failed" || update.type === "turn/interrupted") {
    if (thread.remoteActiveTurnId !== update.turnId && thread.remoteActive !== true) return nextThread;
    const { remoteActiveTurnId: _remoteActiveTurnId, remoteActive: _remoteActive, ...inactiveThread } = nextThread;
    return inactiveThread;
  }
  return nextThread;
}

function updateTurn(turn: ConversationTurnView, update: ConversationUpdate): ConversationTurnView {
  if (update.type === "turn/started") return turn.status === "running" ? turn : { ...turn, status: "running" };
  if (update.type === "turn/completed" || update.type === "turn/failed" || update.type === "turn/interrupted") {
    const status = update.type.slice("turn/".length);
    if (turn.status === status) return turn;
    const message = update.message;
    const items = message === undefined ? turn.items : addStatusItem(turn.items, `${turn.id}:terminal`, message);
    return { ...turn, status, items };
  }
  if (update.type === "item/agentMessage/delta") {
    if (update.delta === "") return turn;
    const itemIndex = turn.items.findIndex((item) => item.id === update.itemId);
    if (itemIndex < 0) return { ...turn, items: [...turn.items, { kind: "text", id: update.itemId, role: "assistant", text: update.delta }] };
    const item = turn.items[itemIndex];
    const nextItem: ConversationItemView = item.kind === "text" && item.role === "assistant"
      ? { ...item, text: item.text === "(No text provided)" ? update.delta : item.text + update.delta }
      : { kind: "text", id: update.itemId, role: "assistant", text: update.delta };
    return replaceItem(turn, itemIndex, nextItem);
  }
  if (update.type === "item/started") {
    if (turn.items.some((item) => item.id === update.itemId)) return turn;
    if (isToolUpdate(update.itemType, update.itemName)) return { ...turn, items: [...turn.items, { kind: "tool", id: update.itemId, name: update.itemName ?? update.itemType ?? "Tool", status: "running" }] };
    return { ...turn, items: [...turn.items, { kind: "status", id: update.itemId, text: "Item started." }] };
  }
  if (update.type !== "item/completed") return turn;
  if (turn.items.some((item) => item.id === update.itemId && item.kind === "tool" && item.status === update.status)) return turn;
  const itemIndex = turn.items.findIndex((item) => item.id === update.itemId);
  const existingItem = itemIndex < 0 ? undefined : turn.items[itemIndex];
  if (existingItem?.kind === "text" && !isToolUpdate(update.itemType, update.itemName)) return turn;
  const nextItem: ConversationItemView = isToolUpdate(update.itemType, update.itemName) || itemIndex >= 0 && turn.items[itemIndex]?.kind === "tool"
    ? { kind: "tool", id: update.itemId, name: update.itemName ?? update.itemType ?? "Tool", status: update.status, ...(update.summary === undefined ? {} : { summary: update.summary }) }
    : { kind: "status", id: update.itemId, text: "Item completed." };
  return itemIndex < 0 ? { ...turn, items: [...turn.items, nextItem] } : replaceItem(turn, itemIndex, nextItem);
}

function replaceItem(turn: ConversationTurnView, itemIndex: number, item: ConversationItemView): ConversationTurnView {
  const items = [...turn.items];
  items[itemIndex] = item;
  return { ...turn, items };
}

function addStatusItem(items: readonly ConversationItemView[], id: string, text: string): readonly ConversationItemView[] {
  if (items.some((item) => item.id === id)) return items;
  return [...items, { kind: "status", id, text }];
}

function isToolUpdate(itemType: string | undefined, itemName: string | undefined): boolean {
  return itemName !== undefined || itemType !== undefined && /tool|command|execution|function|search/i.test(itemType);
}
