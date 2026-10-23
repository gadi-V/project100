"use client";

import { useEffect, useRef } from "react";
import {
  createDailyTransport,
  readDailyRemotePeerCount,
  subscribeDailyAppSession,
  type BoardDeltaMessage,
  type BoardSyncMessage,
  type DailyBoardTransport,
  type DailyElement,
} from "./daily-transport";
import { createDailyPeerSync, type DailyPeerSync, type LiveBoard } from "./daily-peer-sync";
import {
  applyLaserUpdate,
  createLaserPointer,
  laserOpacity,
  visibleLasers,
  type LaserPointer,
  type RemoteLaser,
} from "./laser-pointer";
import { planBoardDelivery } from "./transport-policy";

const LASER_COLOR = "#ef4444";

export type DailyWhiteboardLink = {
  notifyMove(x: number, y: number, pageIndex: number): void;
  notifyRelease(): void;
  forwardPayload(payload: Record<string, unknown>): void;
  /** True only while a joined Daily call is the live app-message transport. */
  isDailyActive(): boolean;
  remotePeerCount(): number;
};

function boardSyncFromPayload(
  payload: Record<string, unknown>,
  senderId: string,
  senderKey: string,
): BoardSyncMessage {
  const message: BoardSyncMessage = { type: "board_sync", senderId, senderKey, v: 6 };
  if (typeof payload.seq === "number" && Number.isInteger(payload.seq) && payload.seq >= 1) message.seq = payload.seq;
  if (typeof payload.action === "string") message.action = payload.action;
  if (payload.add && typeof payload.add === "object") message.add = payload.add as DailyElement;
  if (Array.isArray(payload.remove)) {
    message.remove = payload.remove.filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  if (typeof payload.strokePart === "number" && Number.isInteger(payload.strokePart) && payload.strokePart >= 0) {
    message.strokePart = payload.strokePart;
  }
  if (payload.historyOp != null) message.historyOp = payload.historyOp;
  if (payload.direction === "forward" || payload.direction === "backward") message.direction = payload.direction;
  if (payload.historyPart && typeof payload.historyPart === "object") {
    message.historyPart = payload.historyPart as BoardSyncMessage["historyPart"];
  }
  if (typeof payload.pageCount === "number") message.pageCount = payload.pageCount;
  if (typeof payload.paperStyle === "string") message.paperStyle = payload.paperStyle;
  if (payload.layerOrder && typeof payload.layerOrder === "object") {
    message.layerOrder = payload.layerOrder as BoardSyncMessage["layerOrder"];
  }
  return message;
}

export function useDailyWhiteboard(options: {
  userId: string;
  readBoard: () => LiveBoard;
  onLiveSnapshot: (board: LiveBoard) => void;
  onBoardDelta: (delta: BoardDeltaMessage) => void;
  onBoardSync?: (message: BoardSyncMessage) => void;
  claimSnapshotRequest?: (senderKey: string, token: number) => boolean;
  onLasers: (lasers: RemoteLaser[]) => void;
  onLocalLaserIdle: () => void;
}): DailyWhiteboardLink {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const transportRef = useRef<DailyBoardTransport | null>(null);
  const laserRef = useRef<LaserPointer | null>(null);
  const peerRef = useRef<DailyPeerSync | null>(null);
  const lasersRef = useRef<RemoteLaser[]>([]);
  const allowLaser = (): boolean =>
    planBoardDelivery(
      { type: "laser_update" },
      { dailyJoined: transportRef.current != null, remoteParticipants: readDailyRemotePeerCount() },
    ).daily;

  useEffect(() => {
    let transport: DailyBoardTransport | null = null;
    let peerClose: (() => void) | null = null;
    let laser: LaserPointer | null = null;

    const stop = subscribeDailyAppSession((session) => {
      peerClose?.();
      laser?.dispose();
      transport?.close();
      peerClose = null;
      laser = null;
      transport = null;
      transportRef.current = null;
      laserRef.current = null;
      peerRef.current = null;
      if (!session) return;

      transport = createDailyTransport(session);
      transportRef.current = transport;
      const userId = optionsRef.current.userId;
      const peer = createDailyPeerSync({
        transport,
        userId,
        readBoard: () => optionsRef.current.readBoard(),
        applyLive: (board) => optionsRef.current.onLiveSnapshot(board),
        applyDelta: (delta) => optionsRef.current.onBoardDelta(delta),
        onBoardSync: (message) => optionsRef.current.onBoardSync?.(message),
        claimSnapshotRequest: (senderKey, token) =>
          optionsRef.current.claimSnapshotRequest?.(senderKey, token) ?? true,
        onLaser: (update) => {
          const now = Date.now();
          lasersRef.current = applyLaserUpdate(lasersRef.current, update, now);
          optionsRef.current.onLasers(visibleLasers(lasersRef.current, now));
        },
      });
      peerClose = () => peer.close();
      peerRef.current = peer;
      laser = createLaserPointer({
        userId,
        senderKey: userId,
        color: LASER_COLOR,
        send: (update) => {
          if (!allowLaser()) return;
          transport?.send(update);
        },
        onIdle: () => optionsRef.current.onLocalLaserIdle(),
      });
      laserRef.current = laser;
    });

    return () => {
      stop();
      peerClose?.();
      laser?.dispose();
      transport?.close();
      transportRef.current = null;
      laserRef.current = null;
      peerRef.current = null;
    };
  }, [options.userId]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const next = visibleLasers(lasersRef.current, now);
      const signature = (lasers: readonly RemoteLaser[]) =>
        lasers.map((laser) => `${laser.userId}:${Math.round(laserOpacity(laser, now) * 20)}`).join("|");
      if (signature(next) === signature(lasersRef.current)) return;
      lasersRef.current = next;
      optionsRef.current.onLasers(next);
    }, 50);
    return () => clearInterval(timer);
  }, []);

  return {
    notifyMove(x, y, pageIndex) {
      if (!allowLaser()) return;
      laserRef.current?.move({ x, y, pageIndex });
    },
    notifyRelease() {
      if (!allowLaser()) return;
      laserRef.current?.release();
    },
    forwardPayload(payload) {
      const transport = transportRef.current;
      if (!transport) return;
      const senderId =
        typeof payload.senderId === "string" && payload.senderId.length > 0
          ? payload.senderId
          : optionsRef.current.userId;
      const senderKey =
        typeof payload.senderKey === "string" && payload.senderKey.length > 0 ? payload.senderKey : senderId;
      if (payload.action === "request_snapshot" || payload.type === "request_snapshot") {
        const timestamp = typeof payload.timestamp === "number" ? payload.timestamp : Date.now();
        transport.send({ type: "request_snapshot", senderId, senderKey, timestamp });
        return;
      }
      transport.send(boardSyncFromPayload(payload, senderId, senderKey));
    },
    isDailyActive() {
      return transportRef.current != null;
    },
    remotePeerCount() {
      return readDailyRemotePeerCount();
    },
  };
}
