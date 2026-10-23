/**
 * Idempotent live-delta intake.
 *
 * Identity is a per-mount sender key: `userId:sessionId` for a signed-in
 * participant, otherwise the tab's client id. A second tab of the same user
 * is a different sender. Each accepted event is `senderKey:seq`.
 *
 * Delivery may duplicate an event across Daily and Stream and may reorder it.
 * The receiver keeps a sliding window of seen event ids and applies anything
 * it has not seen yet. Exact duplicates are ignored. There is no monotonic
 * cursor, so a fresh session may restart at seq 1 and a late lower seq still
 * applies.
 *
 * Deletes leave a tombstone. An add for that id is ignored until it expires,
 * so a delayed create cannot resurrect a stroke that was already removed.
 */

export const TOMBSTONE_TTL_MS = 20_000;
/** Last seen event ids. Older ids can be delivered again after they slide out. */
export const SEEN_EVENT_LIMIT = 2_000;
/** Oldest sender keys are dropped once tracking would pass this many senders. */
export const MAX_TRACKED_SENDERS = 50;

export type RemoteBoardOp = {
  op: "add" | "remove";
  id: string;
  element?: unknown;
  part?: number;
};

export type RemoteBoardEvent = {
  /** Session-scoped sender key, or a legacy sender id. */
  senderId: string;
  seq?: number;
  ops: RemoteBoardOp[];
};

export type DeltaApplyState = {
  outgoingSeq: number;
  tombstones: Map<string, number>;
  /** Oldest sender key first. Presence only; dedup lives in `seen`. */
  senders: Map<string, true>;
  /** Oldest event id first. */
  seenOrder: string[];
  seen: Set<string>;
};

export function createDeltaApplyState(): DeltaApplyState {
  return {
    outgoingSeq: 0,
    tombstones: new Map(),
    senders: new Map(),
    seenOrder: [],
    seen: new Set(),
  };
}

/** One id for Stream and Daily. A signed-in participant uses `user.id`; otherwise the tab id. */
export function resolveBoardSenderId(userId: string | null | undefined, clientId: string): string {
  if (typeof userId === "string" && userId.length > 0) return userId;
  return clientId;
}

/**
 * Per-mount sender key. The session token makes a second tab, and a reloaded
 * tab, a new sender so its seq space starts at 1 without looking stale.
 * Anonymous tabs are already unique via `clientId`.
 */
export function resolveBoardSenderKey(
  userId: string | null | undefined,
  clientId: string,
  sessionId: string,
): string {
  if (typeof userId === "string" && userId.length > 0) return `${userId}:${sessionId}`;
  return clientId;
}

export function boardEventId(senderKey: string, seq: number): string {
  return `${senderKey}:${seq}`;
}

/** True only when the incoming key is this mount. A sibling tab is not an echo. */
export function isOwnBoardEcho(incomingSenderKey: string | null | undefined, localSenderKey: string): boolean {
  return typeof incomingSenderKey === "string" && incomingSenderKey.length > 0 && incomingSenderKey === localSenderKey;
}

export function readIncomingSenderKey(value: { senderKey?: unknown; senderId?: unknown; userId?: unknown }): string {
  if (typeof value.senderKey === "string" && value.senderKey.length > 0) return value.senderKey;
  if (typeof value.senderId === "string" && value.senderId.length > 0) return value.senderId;
  if (typeof value.userId === "string" && value.userId.length > 0) return value.userId;
  return "";
}

export function nextDeltaSeq(state: DeltaApplyState): number {
  state.outgoingSeq += 1;
  return state.outgoingSeq;
}

function trackSender(state: DeltaApplyState, senderKey: string): void {
  if (state.senders.has(senderKey)) return;
  while (state.senders.size >= MAX_TRACKED_SENDERS) {
    const oldest = state.senders.keys().next().value;
    if (oldest === undefined) break;
    state.senders.delete(oldest);
  }
  state.senders.set(senderKey, true);
}

/**
 * Records `senderKey:seq` if it is new.
 * Returns false for an exact duplicate still inside the window.
 * Invalid seqs are not tracked and are treated as unseen so legacy events apply.
 */
export function rememberBoardEvent(state: DeltaApplyState, senderKey: string, seq: number): boolean {
  if (!Number.isInteger(seq) || seq < 1 || senderKey.length === 0) return true;
  const eventId = boardEventId(senderKey, seq);
  if (state.seen.has(eventId)) return false;
  trackSender(state, senderKey);
  state.seen.add(eventId);
  state.seenOrder.push(eventId);
  while (state.seenOrder.length > SEEN_EVENT_LIMIT) {
    const dropped = state.seenOrder.shift();
    if (dropped !== undefined) state.seen.delete(dropped);
  }
  return true;
}

/**
 * Accept any unseen event id immediately, including a lower seq than one
 * already applied. Exact duplicates return nothing.
 * Events with no seq apply immediately and are not tracked (legacy peers).
 */
export function pushSenderDelta(state: DeltaApplyState, event: RemoteBoardEvent, _now: number): RemoteBoardEvent[] {
  if (event.seq === undefined || !Number.isInteger(event.seq) || event.seq < 1) return [event];
  if (!rememberBoardEvent(state, event.senderId, event.seq)) return [];
  return [event];
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
