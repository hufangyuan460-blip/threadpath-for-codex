import type { SearchResult } from "../shared/api.ts";

export function moveSearchSelection(current: number, count: number, direction: "next" | "previous"): number {
  if (count === 0) return -1;
  if (direction === "next") return Math.min(Math.max(current, -1) + 1, count - 1);
  return current <= 0 ? 0 : Math.min(current - 1, count - 1);
}

export function searchNavigationTarget(results: readonly SearchResult[], selectedIndex: number): string | undefined {
  return selectedIndex >= 0 ? results[selectedIndex]?.turnId : undefined;
}
