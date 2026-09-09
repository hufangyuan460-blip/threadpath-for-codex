export const VIRTUOSO_FIRST_ITEM_INDEX = 1_000_000;

export function firstItemIndexForTurnCount(turnCount: number): number {
  return Math.max(1, VIRTUOSO_FIRST_ITEM_INDEX - Math.max(0, turnCount));
}

export function visibleTurnIds(turnIds: readonly string[], startIndex: number, endIndex: number): string[] {
  const start = Math.max(0, startIndex);
  const end = Math.min(turnIds.length - 1, endIndex);
  return end < start ? [] : turnIds.slice(start, end + 1);
}
