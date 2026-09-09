export function preserveScrollTop(beforeTop: number, beforeHeight: number, afterHeight: number): number {
  if (!Number.isFinite(beforeTop) || !Number.isFinite(beforeHeight) || !Number.isFinite(afterHeight)) return beforeTop;
  return Math.max(0, beforeTop + afterHeight - beforeHeight);
}
