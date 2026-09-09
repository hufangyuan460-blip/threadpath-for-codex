export interface TurnRectSnapshot {
  readonly turnId: string;
  readonly top: number;
  readonly bottom: number;
}

export interface VirtualTurnRange {
  readonly startIndex: number;
  readonly endIndex: number;
}

export function chooseActiveTurnId(turns: readonly TurnRectSnapshot[], viewportTop: number, viewportBottom: number): string | undefined {
  if (turns.length === 0 || viewportBottom <= viewportTop) return undefined;
  const fullyVisible = turns.filter((turn) => turn.top >= viewportTop && turn.bottom <= viewportBottom);
  const visible = turns.filter((turn) => turn.bottom > viewportTop && turn.top < viewportBottom);
  const candidates = fullyVisible.length > 0 ? fullyVisible : visible;
  if (candidates.length > 0) return nearestToTop(candidates, viewportTop);
  return turns.reduce((nearest, turn) => distanceToViewport(turn, viewportTop, viewportBottom) < distanceToViewport(nearest, viewportTop, viewportBottom) ? turn : nearest).turnId;
}

export function chooseActiveTurnIdFromRange(turnIds: readonly string[], range: VirtualTurnRange): string | undefined {
  if (turnIds.length === 0 || range.endIndex < range.startIndex) return undefined;
  const index = Math.min(Math.max(range.startIndex, 0), turnIds.length - 1);
  return turnIds[index];
}

function nearestToTop(turns: readonly TurnRectSnapshot[], viewportTop: number): string {
  return turns.reduce((nearest, turn) => Math.abs(turn.top - viewportTop) < Math.abs(nearest.top - viewportTop) ? turn : nearest).turnId;
}

function distanceToViewport(turn: TurnRectSnapshot, viewportTop: number, viewportBottom: number): number {
  if (turn.bottom < viewportTop) return viewportTop - turn.bottom;
  if (turn.top > viewportBottom) return turn.top - viewportBottom;
  return 0;
}
