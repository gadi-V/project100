/**
 * Daily app-message adapter for the classroom board.
 * Payloads stay under 2KB and never carry data URLs or signed URLs.
 * Laser, selection, and undo state are not part of these messages' persisted form.
 */

export const DAILY_EVENT_MAX_BYTES = 2048;

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
  id: string;
  element?: DailyElement;
  part?: number;
};

export type RequestSnapshotMessage = {
  type: "request_snapshot";
  senderId: string;
  timestamp: number;
};

export type SnapshotResponseMessage = {
  type: "snapshot_response";
  senderId: string;
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
  active: boolean;
  pageIndex?: number;
};

export type DailyBoardMessage =
  | BoardDeltaMessage
  | RequestSnapshotMessage
  | SnapshotResponseMessage
  | LaserUpdateMessage;

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
};

type SessionListener = (session: DailyAppSession | null) => void;

let currentSession: DailyAppSession | null = null;
const sessionListeners = new Set<SessionListener>();

export function publishDailyAppSession(session: DailyAppSession | null): void {
  currentSession = session;
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
      return { type: "board_delta", op: "remove", senderId, id };
    }
    const element = sanitizeDailyElement(message.element);
    if (!element || element.id !== id) return null;
    const next: BoardDeltaMessage = { type: "board_delta", op: "add", senderId, id, element };
    if (typeof message.part === "number" && Number.isInteger(message.part) && message.part > 0) {
      next.part = message.part;
    }
    return next;
  }
  if (message.type === "request_snapshot") {
    const senderId = readId(message.senderId);
    if (!senderId || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) return null;
    return { type: "request_snapshot", senderId, timestamp: message.timestamp };
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
    return {
      type: "snapshot_response",
      senderId,
      snapshotId,
      chunkIndex: message.chunkIndex,
      totalChunks: message.totalChunks,
      paperStyle: readPaper(message.paperStyle),
      elements,
    };
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
    if (typeof message.pageIndex === "number" && Number.isInteger(message.pageIndex) && message.pageIndex >= 0) {
      next.pageIndex = message.pageIndex;
    }
    return next;
  }
  return null;
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
    record.type !== "laser_update"
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
    default:
      return;
  }
}

export function packSnapshotResponse(input: {
  senderId: string;
  snapshotId: string;
  paperStyle: string;
  elements: readonly unknown[];
}): SnapshotResponseMessage[] {
  const clean = input.elements
    .map((element) => sanitizeDailyElement(element))
    .filter((element): element is DailyElement => element !== null);
  if (clean.length === 0) return [];

  const fits = (elements: DailyElement[]): boolean =>
    encodeDailyMessage({
      type: "snapshot_response",
      senderId: input.senderId,
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
