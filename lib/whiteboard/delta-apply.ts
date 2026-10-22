/**
 * Idempotent live-delta intake.
 *
 * Each sender stamps a monotonic `seq` on every delta. The receiver holds a
 * short reorder window so an inverted pair is applied in seq order, drops a
 * seq it has already released, and skips a gap that never arrives.
 * Stroke parts are a separate idempotency key — see stroke-parts.ts.
 *
 * Deletes leave a tombstone. An add for that id is ignored until it expires,
 * so a delayed create cannot resurrect a stroke that was already removed.
 */

export const TOMBSTONE_TTL_MS = 20_000;
export const SEQ_REORDER_MS = 50;

export type RemoteBoardOp = {
  op: "add" | "remove";
  id: string;
  element?: unknown;
  part?: number;
};

export type RemoteBoardEvent = {
  senderId: string;
  seq?: number;
  ops: RemoteBoardOp[];
};

type SenderCursor = {
  /** Next seq to release. Unset until the first reorder window opens. */
  next?: number;
  openedAt?: number;
  /** When the current gap (missing `next`) started. */
  gapSince?: number;
  hold: Map<number, RemoteBoardEvent>;
};

export type DeltaApplyState = {
  outgoingSeq: number;
  tombstones: Map<string, number>;
  senders: Map<string, SenderCursor>;
};

export function createDeltaApplyState(): DeltaApplyState {
  return {
    outgoingSeq: 0,
    tombstones: new Map(),
    senders: new Map(),
  };
}

/** One id for Stream and Daily. A signed-in participant uses `user.id`; otherwise the tab id. */
export function resolveBoardSenderId(userId: string | null | undefined, clientId: string): string {
  if (typeof userId === "string" && userId.length > 0) return userId;
  return clientId;
}

export function nextDeltaSeq(state: DeltaApplyState): number {
  state.outgoingSeq += 1;
  return state.outgoingSeq;
}

function cursorFor(state: DeltaApplyState, senderId: string): SenderCursor {
  let cursor = state.senders.get(senderId);
  if (!cursor) {
    cursor = { hold: new Map() };
    state.senders.set(senderId, cursor);
  }
  return cursor;
}

function releaseSender(cursor: SenderCursor, now: number): RemoteBoardEvent[] {
  const ready: RemoteBoardEvent[] = [];
  if (cursor.hold.size === 0) return ready;

  if (cursor.next === undefined) {
    const opened = cursor.openedAt ?? now;
    if (now - opened < SEQ_REORDER_MS) return ready;
    cursor.next = Math.min(...cursor.hold.keys());
  }

  while (cursor.next !== undefined) {
    const event = cursor.hold.get(cursor.next);
    if (!event) {
      const higher = [...cursor.hold.keys()].filter((seq) => seq > cursor.next!).sort((a, b) => a - b)[0];
      if (higher === undefined) return ready;
      if (cursor.gapSince === undefined) cursor.gapSince = now;
      if (now - cursor.gapSince < SEQ_REORDER_MS) return ready;
      cursor.next = higher;
      cursor.gapSince = undefined;
      continue;
    }
    cursor.gapSince = undefined;
    cursor.hold.delete(cursor.next);
    ready.push(event);
    cursor.next += 1;
  }
  return ready;
}

/**
 * Park `event` until it is the next seq for its sender.
 * Events with no seq apply immediately (legacy peers).
 * A seq already released, or already waiting, is ignored.
 */
export function pushSenderDelta(state: DeltaApplyState, event: RemoteBoardEvent, now: number): RemoteBoardEvent[] {
  if (event.seq === undefined || !Number.isInteger(event.seq) || event.seq < 1) return [event];
  const cursor = cursorFor(state, event.senderId);
  if (cursor.next !== undefined && event.seq < cursor.next) return [];
  if (cursor.hold.has(event.seq)) return [];
  cursor.hold.set(event.seq, event);
  if (cursor.openedAt === undefined) cursor.openedAt = now;
  return releaseSender(cursor, now);
}

/** Release anything the reorder window or a gap timeout has unblocked. */
export function flushSenderDeltas(state: DeltaApplyState, now: number): RemoteBoardEvent[] {
  const ready: RemoteBoardEvent[] = [];
  for (const cursor of state.senders.values()) ready.push(...releaseSender(cursor, now));
  return ready;
}

export function hasHeldDeltas(state: DeltaApplyState): boolean {
  for (const cursor of state.senders.values()) {
    if (cursor.hold.size > 0) return true;
  }
  return false;
}

export function tombstoneElement(state: DeltaApplyState, id: string, now: number): void {
  state.tombstones.set(id, now + TOMBSTONE_TTL_MS);
}

export function isTombstoned(state: DeltaApplyState, id: string, now: number): boolean {
  const expires = state.tombstones.get(id);
  if (expires === undefined) return false;
  if (now >= expires) {
    state.tombstones.delete(id);
    return false;
  }
  return true;
}

/** Removes are recorded. Adds for a live tombstone are dropped. */
export function guardIncomingOp(state: DeltaApplyState, op: RemoteBoardOp, now: number): RemoteBoardOp | null {
  if (op.op === "remove") {
    tombstoneElement(state, op.id, now);
    return op;
  }
  if (isTombstoned(state, op.id, now)) return null;
  return op;
}
