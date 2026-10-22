/**
 * Peer-snapshot transfer.
 * Chunks have a deadline. Live deltas that arrive while the snapshot is in
 * flight are held and applied only after the snapshot is mounted, or onto the
 * server baseline if the transfer is abandoned.
 */

export const SNAPSHOT_CHUNK_TIMEOUT_MS = 6_000;
/** First attempt plus one re-request. */
export const SNAPSHOT_MAX_ATTEMPTS = 2;

export type SnapshotWait<T> = {
  active: boolean;
  attempt: number;
  deltas: T[];
};

export function createSnapshotWait<T>(): SnapshotWait<T> {
  return { active: false, attempt: 0, deltas: [] };
}

export function beginSnapshotWait<T>(wait: SnapshotWait<T> = createSnapshotWait()): SnapshotWait<T> {
  wait.active = true;
  wait.attempt = 1;
  wait.deltas = [];
  return wait;
}

/** Returns true when the delta was held instead of applied. */
export function bufferSnapshotDelta<T>(wait: SnapshotWait<T>, delta: T): boolean {
  if (!wait.active) return false;
  wait.deltas.push(delta);
  return true;
}

export function snapshotTimeoutStep(attempt: number, maxAttempts = SNAPSHOT_MAX_ATTEMPTS): "retry" | "fallback" {
  return attempt < maxAttempts ? "retry" : "fallback";
}

/** Ask again. Deltas already buffered stay buffered. */
export function noteSnapshotRetry<T>(wait: SnapshotWait<T>): void {
  wait.attempt += 1;
  wait.active = true;
}

/** Ends the wait and returns deltas in arrival order. */
export function finishSnapshotWait<T>(wait: SnapshotWait<T>): T[] {
  wait.active = false;
  const deltas = wait.deltas;
  wait.deltas = [];
  return deltas;
}
