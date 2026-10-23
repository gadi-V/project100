/**
 * Daily app-message adapter for the classroom board.
 * Payloads stay under 2KB and never carry data URLs or signed URLs.
 * Laser, selection, and undo state are not part of these messages' persisted form.
 */

export const DAILY_EVENT_MAX_BYTES = 2048;

/**
 * Payload ceiling enforced by the installed `@daily-co/daily-js` 0.91.0 client.
 * Verified in `node_modules/@daily-co/daily-js/dist/daily.js` (single-line bundle):
 * `ko=4096` is the default `_maxAppMessageSize`, and `sendAppMessage` throws when
 * `JSON.stringify(data).length` exceeds it. A joined call may replace the default
 * from `event.internal._maxAppMessageSize`. The type signature at
 * `node_modules/@daily-co/daily-js/index.d.ts:2479` does not document a size.
 * Events here stay at 2048 bytes so the same delta also fits a Stream custom event.
 *
 * Rate limit: not declared in that bundle or in the typings. Unverified.
 */
export const DAILY_CLIENT_MAX_APP_MESSAGE_CHARS = 4096;

const PAPER_STYLES = new Set(["grid", "ruled", "dotted", "blank"]);
const DROPPED_KEYS = new Set([
  "url",
  "src",
  "dataUrl",
  "signedUrl",
  "href",
  "undo",
  "redo",
  "undoStack",
  "redoStack",
  "selected",
  "selectedIds",
  "selection",
  "laser",
  "laserPts",
  "cursor",
  "cursorPt",
]);

export type DailyElement = Record<string, unknown> & { id: string };

export type BoardDeltaMessage = {
  type: "board_delta";
  op: "add" | "remove";
  senderId: string;
  /** Session-scoped sender key. Echo suppression prefers this over `senderId`. */
  senderKey?: string;
  id: string;
  element?: DailyElement;
  /** Stroke piece index. `0` is a real part, not "absent". */
  part?: number;
  /** Per-sender event sequence. Retries reuse the same value. */
  seq?: number;
};

export type RequestSnapshotMessage = {
  type: "request_snapshot";
  senderId: string;
  senderKey?: string;
  timestamp: number;
};

export type SnapshotResponseMessage = {
  type: "snapshot_response";
  senderId: string;
  senderKey?: string;
  snapshotId: string;
  chunkIndex: number;
  totalChunks: number;
  paperStyle: string;
  elements: DailyElement[];
};

export type LaserUpdateMessage = {
  type: "laser_update";
  x: number;
  y: number;
  color: string;
  userId: string;
  /** Session-scoped sender key. A second tab of the same user is not an echo. */
  senderKey?: string;
  active: boolean;
  pageIndex?: number;
};

export type BoardSyncMessage = {
  type: "board_sync";
  senderId: string;
  senderKey?: string;
  v?: number;
  seq?: number;
  action?: string;
  add?: DailyElement;
  remove?: string[];
  strokePart?: number;
  paperStyle?: string;
  pageCount?: number;
  direction?: "forward" | "backward";
  historyOp?: unknown;
  historyPart?: { index: number; total: number; opId: string };
  layerOrder?: { pageIndex: number; ids: string[] };
  timestamp?: number;
  snapshotId?: string;
  chunkIndex?: number;
  totalChunks?: number;
  elementsChunk?: DailyElement[];
};

export type DailyBoardMessage =
  | BoardDeltaMessage
  | RequestSnapshotMessage
  | SnapshotResponseMessage
  | LaserUpdateMessage
  | BoardSyncMessage;

export type DailyMessageHandler = (message: DailyBoardMessage, fromId: string | null) => void;

export type DailyAppMessageEvent = {
  data?: unknown;
  fromId?: string;
};

export interface DailyAppSession {
  sendAppMessage(data: unknown, to?: string): void;
  on(event: "app-message", handler: (event: DailyAppMessageEvent) => void): void;
  off(event: "app-message", handler: (event: DailyAppMessageEvent) => void): void;
}

export type DailyBoardTransport = {
  send(message: DailyBoardMessage): boolean;
  subscribe(handler: DailyMessageHandler): () => void;
  close(): void;
};

export type DailyMessageRoutes = {
  board_delta?: (message: BoardDeltaMessage) => void;
  request_snapshot?: (message: RequestSnapshotMessage) => void;
  snapshot_response?: (message: SnapshotResponseMessage) => void;
  laser_update?: (message: LaserUpdateMessage) => void;
  board_sync?: (message: BoardSyncMessage) => void;
};

type SessionListener = (session: DailyAppSession | null) => void;

let currentSession: DailyAppSession | null = null;
let remotePeerCount = 0;
const sessionListeners = new Set<SessionListener>();
const remotePeerListeners = new Set<(count: number) => void>();

export function countRemoteParticipants(participants: { [id: string]: { local?: boolean } | undefined }): number {
  let count = 0;
  for (const [id, participant] of Object.entries(participants)) {
    if (id === "local" || !participant || participant.local) continue;
    count += 1;
  }
  return count;
}

export function publishDailyRemotePeerCount(count: number): void {
  remotePeerCount = Math.max(0, Math.floor(count));
  for (const listener of remotePeerListeners) listener(remotePeerCount);
}

export function readDailyRemotePeerCount(): number {
  return remotePeerCount;
}

export function publishDailyAppSession(session: DailyAppSession | null): void {
  currentSession = session;
  if (session === null && remotePeerCount !== 0) {
    remotePeerCount = 0;
    for (const listener of remotePeerListeners) listener(0);
  }
  for (const listener of sessionListeners) listener(session);
}

export function subscribeDailyAppSession(listener: SessionListener): () => void {
  listener(currentSession);
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

function isEphemeralUrl(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("blob:") || /^https?:\/\//i.test(value);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return isEphemeralUrl(value) ? undefined : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    for (const item of value) {
      const clean = sanitizeValue(item);
      if (clean !== undefined) next.push(clean);
    }
    return next;
  }
  if (!value || typeof value !== "object") return undefined;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key)) continue;
    const clean = sanitizeValue(item);
    if (clean !== undefined) next[key] = clean;
  }
  return next;
}

export function sanitizeDailyElement(value: unknown): DailyElement | null {
  const clean = sanitizeValue(value);
  if (!clean || typeof clean !== "object" || Array.isArray(clean)) return null;
  const record = clean as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 128) return null;
  return record as DailyElement;
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

function readSenderKey(value: unknown): string | undefined {
  return readId(value) ?? undefined;
}

function readPaper(value: unknown): string {
  return typeof value === "string" && PAPER_STYLES.has(value) ? value : "grid";
}

function messageBytes(message: DailyBoardMessage): number {
  return new TextEncoder().encode(JSON.stringify(message)).length;
}

function normalize(message: DailyBoardMessage): DailyBoardMessage | null {
  if (message.type === "board_delta") {
    const senderId = readId(message.senderId);
    const id = readId(message.id);
    if (!senderId || !id || (message.op !== "add" && message.op !== "remove")) return null;
    if (message.op === "remove") {
      const remove: BoardDeltaMessage = { type: "board_delta", op: "remove", senderId, id };
      const senderKey = readSenderKey(message.senderKey);
      if (senderKey) remove.senderKey = senderKey;
      if (typeof message.seq === "number" && Number.isInteger(message.seq) && message.seq >= 1) {
        remove.seq = message.seq;
      }
      return remove;
    }
    const element = sanitizeDailyElement(message.element);
    if (!element || element.id !== id) return null;
    const next: BoardDeltaMessage = { type: "board_delta", op: "add", senderId, id, element };
    const senderKey = readSenderKey(message.senderKey);
    if (senderKey) next.senderKey = senderKey;
    if (typeof message.part === "number" && Number.isInteger(message.part) && message.part >= 0) {
      next.part = message.part;
    }
    if (typeof message.seq === "number" && Number.isInteger(message.seq) && message.seq >= 1) {
      next.seq = message.seq;
    }
    return next;
  }
  if (message.type === "request_snapshot") {
    const senderId = readId(message.senderId);
    if (!senderId || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) return null;
    const request: RequestSnapshotMessage = { type: "request_snapshot", senderId, timestamp: message.timestamp };
    const senderKey = readSenderKey(message.senderKey);
    if (senderKey) request.senderKey = senderKey;
    return request;
  }
  if (message.type === "snapshot_response") {
    const senderId = readId(message.senderId);
    const snapshotId = readId(message.snapshotId);
    if (!senderId || !snapshotId) return null;
    if (!Number.isInteger(message.chunkIndex) || message.chunkIndex < 0) return null;
    if (!Number.isInteger(message.totalChunks) || message.totalChunks < 1) return null;
    if (message.chunkIndex >= message.totalChunks) return null;
    const elements: DailyElement[] = [];
    for (const item of message.elements) {
      const element = sanitizeDailyElement(item);
      if (element) elements.push(element);
    }
    const response: SnapshotResponseMessage = {
      type: "snapshot_response",
      senderId,
      snapshotId,
      chunkIndex: message.chunkIndex,
      totalChunks: message.totalChunks,
      paperStyle: readPaper(message.paperStyle),
      elements,
    };
    const senderKey = readSenderKey(message.senderKey);
    if (senderKey) response.senderKey = senderKey;
    return response;
  }
  if (message.type === "laser_update") {
    const userId = readId(message.userId);
    if (!userId || typeof message.active !== "boolean") return null;
    if (typeof message.x !== "number" || typeof message.y !== "number") return null;
    if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) return null;
    if (typeof message.color !== "string" || message.color.length === 0 || message.color.length > 32) return null;
    if (isEphemeralUrl(message.color)) return null;
    const next: LaserUpdateMessage = {
      type: "laser_update",
      x: round1(message.x),
      y: round1(message.y),
      color: message.color,
      userId,
      active: message.active,
    };
    const senderKey = readSenderKey(message.senderKey);
    if (senderKey) next.senderKey = senderKey;
    if (typeof message.pageIndex === "number" && Number.isInteger(message.pageIndex) && message.pageIndex >= 0) {
      next.pageIndex = message.pageIndex;
    }
    return next;
  }
  if (message.type === "board_sync") return normalizeBoardSync(message);
  return null;
}

function normalizeBoardSync(message: BoardSyncMessage): BoardSyncMessage | null {
  const senderId = readId(message.senderId);
  if (!senderId) return null;
  const next: BoardSyncMessage = { type: "board_sync", senderId };
  const senderKey = readSenderKey(message.senderKey);
  if (senderKey) next.senderKey = senderKey;
  if (typeof message.v === "number" && Number.isInteger(message.v)) next.v = message.v;
  if (typeof message.seq === "number" && Number.isInteger(message.seq) && message.seq >= 1) next.seq = message.seq;
  if (typeof message.action === "string" && message.action.length > 0 && message.action.length <= 64) {
    next.action = message.action;
  }
  if (message.add) {
    const element = sanitizeDailyElement(message.add);
    if (element) next.add = element;
  }
  if (Array.isArray(message.remove)) {
    const ids = message.remove.filter((id): id is string => readId(id) !== null);
    if (ids.length > 0) next.remove = ids;
  }
  if (typeof message.strokePart === "number" && Number.isInteger(message.strokePart) && message.strokePart >= 0) {
    next.strokePart = message.strokePart;
  }
  if (typeof message.paperStyle === "string") next.paperStyle = readPaper(message.paperStyle);
  if (typeof message.pageCount === "number" && Number.isInteger(message.pageCount) && message.pageCount > 0) {
    next.pageCount = message.pageCount;
  }
  if (message.direction === "forward" || message.direction === "backward") next.direction = message.direction;
  if (message.historyOp && typeof message.historyOp === "object") {
    const clean = sanitizeValue(message.historyOp);
    if (clean && typeof clean === "object") next.historyOp = clean;
  }
  const part = message.historyPart;
  if (
    part &&
    Number.isInteger(part.index) &&
    Number.isInteger(part.total) &&
    part.index >= 0 &&
    part.total >= 1 &&
    part.index < part.total &&
    readId(part.opId)
  ) {
    next.historyPart = { index: part.index, total: part.total, opId: part.opId };
  }
  if (message.layerOrder && Number.isInteger(message.layerOrder.pageIndex) && message.layerOrder.pageIndex >= 0) {
    const ids = Array.isArray(message.layerOrder.ids)
      ? message.layerOrder.ids.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    next.layerOrder = { pageIndex: message.layerOrder.pageIndex, ids };
  }
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) next.timestamp = message.timestamp;
  const snapshotId = readId(message.snapshotId);
  if (snapshotId) next.snapshotId = snapshotId;
  if (typeof message.chunkIndex === "number" && Number.isInteger(message.chunkIndex) && message.chunkIndex >= 0) {
    next.chunkIndex = message.chunkIndex;
  }
  if (typeof message.totalChunks === "number" && Number.isInteger(message.totalChunks) && message.totalChunks >= 1) {
    next.totalChunks = message.totalChunks;
  }
  if (Array.isArray(message.elementsChunk)) {
    const elements: DailyElement[] = [];
    for (const item of message.elementsChunk) {
      const element = sanitizeDailyElement(item);
      if (element) elements.push(element);
    }
    if (elements.length > 0) next.elementsChunk = elements;
  }
  return next;
}

export function encodeDailyMessage(message: DailyBoardMessage): string | null {
  const normalized = normalize(message);
  if (!normalized) return null;
  if (messageBytes(normalized) >= DAILY_EVENT_MAX_BYTES) return null;
  return JSON.stringify(normalized);
}

export function decodeDailyMessage(data: unknown): DailyBoardMessage | null {
  let value = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<DailyBoardMessage>;
  if (
    record.type !== "board_delta" &&
    record.type !== "request_snapshot" &&
    record.type !== "snapshot_response" &&
    record.type !== "laser_update" &&
    record.type !== "board_sync"
  ) {
    return null;
  }
  return normalize(record as DailyBoardMessage);
}

export function routeDailyMessage(message: DailyBoardMessage, routes: DailyMessageRoutes): void {
  switch (message.type) {
    case "board_delta":
      routes.board_delta?.(message);
      return;
    case "request_snapshot":
      routes.request_snapshot?.(message);
      return;
    case "snapshot_response":
      routes.snapshot_response?.(message);
      return;
    case "laser_update":
      routes.laser_update?.(message);
      return;
    case "board_sync":
      routes.board_sync?.(message);
      return;
    default:
      return;
  }
}

export function packSnapshotResponse(input: {
  senderId: string;
  senderKey?: string;
  snapshotId: string;
  paperStyle: string;
  elements: readonly unknown[];
}): SnapshotResponseMessage[] {
  const clean = input.elements
    .map((element) => sanitizeDailyElement(element))
    .filter((element): element is DailyElement => element !== null);
  if (clean.length === 0) return [];

  const senderKey = readSenderKey(input.senderKey);
  const fits = (elements: DailyElement[]): boolean =>
    encodeDailyMessage({
      type: "snapshot_response",
      senderId: input.senderId,
      ...(senderKey ? { senderKey } : {}),
      snapshotId: input.snapshotId,
      chunkIndex: 0,
      totalChunks: 99,
      paperStyle: input.paperStyle,
      elements,
    }) !== null;

  const groups: DailyElement[][] = [];
  let current: DailyElement[] = [];
  for (const element of clean) {
    if (fits([...current, element])) {
      current = [...current, element];
      continue;
    }
    if (current.length > 0) groups.push(current);
    current = fits([element]) ? [element] : [];
  }
  if (current.length > 0) groups.push(current);

  const packed: SnapshotResponseMessage[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const encoded = encodeDailyMessage({
      type: "snapshot_response",
      senderId: input.senderId,
      ...(senderKey ? { senderKey } : {}),
      snapshotId: input.snapshotId,
      chunkIndex: index,
      totalChunks: groups.length,
      paperStyle: input.paperStyle,
      elements: groups[index],
    });
    if (!encoded) continue;
    const decoded = decodeDailyMessage(encoded);
    if (decoded?.type === "snapshot_response") packed.push(decoded);
  }
  return packed;
}

export function createDailyTransport(session: DailyAppSession): DailyBoardTransport {
  const handlers = new Set<DailyMessageHandler>();
  const onAppMessage = (event: DailyAppMessageEvent): void => {
    const message = decodeDailyMessage(event.data);
    if (!message) return;
    for (const handler of handlers) handler(message, event.fromId ?? null);
  };
  session.on("app-message", onAppMessage);
  let closed = false;
  return {
    send(message) {
      if (closed) return false;
      const encoded = encodeDailyMessage(message);
      if (!encoded) return false;
      try {
        session.sendAppMessage(JSON.parse(encoded) as unknown);
      } catch {
        return false;
      }
      return true;
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      handlers.clear();
      session.off("app-message", onAppMessage);
    },
  };
}
