import {
  packSnapshotResponse,
  type BoardDeltaMessage,
  type DailyBoardTransport,
  type LaserUpdateMessage,
  type SnapshotResponseMessage,
} from "./daily-transport";

export type LiveBoardElement = Record<string, unknown> & { id: string };

export type LiveBoard = {
  elements: LiveBoardElement[];
  paperStyle: string;
};

export type DailyPeerSync = {
  onServerBaselineReady(): void;
  close(): void;
};

type PendingSnapshot = {
  snapshotId: string;
  totalChunks: number;
  paperStyle: string;
  parts: Map<number, LiveBoardElement[]>;
};

function asElements(value: readonly Record<string, unknown>[]): LiveBoardElement[] {
  return value.filter((element): element is LiveBoardElement => typeof element.id === "string");
}

export function createDailyPeerSync(options: {
  transport: DailyBoardTransport;
  userId: string;
  now?: () => number;
  readBoard: () => LiveBoard;
  applyLive: (board: LiveBoard) => void;
  applyDelta?: (delta: BoardDeltaMessage) => void;
  onLaser?: (update: LaserUpdateMessage) => void;
}): DailyPeerSync {
  const now = options.now ?? (() => Date.now());
  let requested = false;
  let closed = false;
  let pending: PendingSnapshot | null = null;

  const acceptSnapshot = (message: SnapshotResponseMessage): LiveBoard | null => {
    if (message.senderId === options.userId || !requested) return null;
    if (message.totalChunks === 1) {
      return { elements: asElements(message.elements), paperStyle: message.paperStyle };
    }
    if (!pending || pending.snapshotId !== message.snapshotId) {
      pending = {
        snapshotId: message.snapshotId,
        totalChunks: message.totalChunks,
        paperStyle: message.paperStyle,
        parts: new Map(),
      };
    }
    pending.parts.set(message.chunkIndex, asElements(message.elements));
    pending.paperStyle = message.paperStyle;
    if (pending.parts.size < pending.totalChunks) return null;
    const elements: LiveBoardElement[] = [];
    for (let index = 0; index < pending.totalChunks; index += 1) {
      const part = pending.parts.get(index);
      if (!part) return null;
      elements.push(...part);
    }
    const paperStyle = pending.paperStyle;
    pending = null;
    return { elements, paperStyle };
  };

  const unsubscribe = options.transport.subscribe((message) => {
    if (closed) return;
    if (message.type === "request_snapshot") {
      if (message.senderId === options.userId) return;
      const board = options.readBoard();
      if (board.elements.length === 0) return;
      const chunks = packSnapshotResponse({
        senderId: options.userId,
        snapshotId: `${options.userId}-${now()}`,
        paperStyle: board.paperStyle,
        elements: board.elements,
      });
      for (const chunk of chunks) options.transport.send(chunk);
      return;
    }
    if (message.type === "snapshot_response") {
      const ready = acceptSnapshot(message);
      if (!ready || ready.elements.length === 0) return;
      options.applyLive(ready);
      return;
    }
    if (message.type === "board_delta") {
      if (message.senderId === options.userId) return;
      options.applyDelta?.(message);
      return;
    }
    if (message.type === "laser_update") {
      if (message.userId === options.userId) return;
      options.onLaser?.(message);
    }
  });

  return {
    onServerBaselineReady() {
      if (closed || requested) return;
      requested = true;
      options.transport.send({
        type: "request_snapshot",
        senderId: options.userId,
        timestamp: now(),
      });
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
    },
  };
}
