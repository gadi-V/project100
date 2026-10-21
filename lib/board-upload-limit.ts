const WINDOW_MS = 60_000;
const LIMIT = 10;

const hits = new Map<string, number[]>();

export function resetBoardUploadLimits(): void {
  hits.clear();
}

/** 10 board-image uploads per user per minute. Enforced in this process. */
export function consumeBoardUpload(userId: string, now = Date.now()): { ok: boolean; retryAfter: number } {
  const recent = (hits.get(userId) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= LIMIT) {
    hits.set(userId, recent);
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - recent[0])) / 1000));
    return { ok: false, retryAfter };
  }
  recent.push(now);
  hits.set(userId, recent);
  return { ok: true, retryAfter: 0 };
}
