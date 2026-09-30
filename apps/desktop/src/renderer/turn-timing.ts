export interface TurnTiming {
  readonly threadId: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

export function formatElapsedTime(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
