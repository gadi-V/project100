"use client";

import { useEffect, useRef } from "react";
import {
  createDailyTransport,
  subscribeDailyAppSession,
  type BoardDeltaMessage,
  type DailyBoardMessage,
  type DailyBoardTransport,
} from "./daily-transport";
import { createDailyPeerSync, type DailyPeerSync, type LiveBoard } from "./daily-peer-sync";
import {
  applyLaserUpdate,
  createLaserPointer,
  visibleLasers,
  type LaserPointer,
  type RemoteLaser,
} from "./laser-pointer";
import { selectTransport } from "./transport-policy";

const LASER_COLOR = "#ef4444";

export type DailyWhiteboardLink = {
  notifyMove(x: number, y: number, pageIndex: number): void;
  notifyRelease(): void;
  forwardPayload(payload: Record<string, unknown>): void;
  /** True only while a joined Daily call is the live app-message transport. */
  isDailyActive(): boolean;
};

function deltasFromPayload(payload: Record<string, unknown>, senderId: string): DailyBoardMessage[] {
  const messages: DailyBoardMessage[] = [];
  if (payload.add && typeof payload.add === "object") {
    const element = payload.add as Record<string, unknown>;
    const id = typeof element.id === "string" ? element.id : "";
    const message: BoardDeltaMessage = {
      type: "board_delta",
      op: "add",
      senderId,
      id,
      element: element as BoardDeltaMessage["element"],
    };
    if (typeof payload.strokePart === "number" && Number.isInteger(payload.strokePart) && payload.strokePart >= 0) {
      message.part = payload.strokePart;
    }
    if (typeof payload.seq === "number" && Number.isInteger(payload.seq) && payload.seq >= 1) {
      message.seq = payload.seq;
    }
    messages.push(message);
  }
  if (Array.isArray(payload.remove)) {
    for (const id of payload.remove) {
      if (typeof id !== "string" || id.length === 0) continue;
      const remove: BoardDeltaMessage = { type: "board_delta", op: "remove", senderId, id };
      if (typeof payload.seq === "number" && Number.isInteger(payload.seq) && payload.seq >= 1) {
        remove.seq = payload.seq;
      }
      messages.push(remove);
    }
  }
  return messages;
}

export function useDailyWhiteboard(options: {
  userId: string;
  readBoard: () => LiveBoard;
  onLiveSnapshot: (board: LiveBoard) => void;
  onBoardDelta: (delta: BoardDeltaMessage) => void;
  onLasers: (lasers: RemoteLaser[]) => void;
  onLocalLaserIdle: () => void;
}): DailyWhiteboardLink {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const transportRef = useRef<DailyBoardTransport | null>(null);
  const laserRef = useRef<LaserPointer | null>(null);
  const peerRef = useRef<DailyPeerSync | null>(null);
  const lasersRef = useRef<RemoteLaser[]>([]);

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
        color: LASER_COLOR,
        send: (update) => {
          // Laser stays on Daily. Stream is not a pointer channel.
          if (selectTransport("laser_update", transportRef.current != null) !== "daily") return;
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
      if (next.length === lasersRef.current.length) return;
      lasersRef.current = next;
      optionsRef.current.onLasers(next);
    }, 200);
    return () => clearInterval(timer);
  }, []);

  return {
    notifyMove(x, y, pageIndex) {
      if (selectTransport("laser_update", transportRef.current != null) !== "daily") return;
      laserRef.current?.move({ x, y, pageIndex });
    },
    notifyRelease() {
      if (selectTransport("laser_update", transportRef.current != null) !== "daily") return;
      laserRef.current?.release();
    },
    forwardPayload(payload) {
      const transport = transportRef.current;
      if (!transport) return;
      if (!planAllowsDaily(payload)) return;
      for (const message of deltasFromPayload(payload, optionsRef.current.userId)) {
        transport.send(message);
      }
    },
    isDailyActive() {
      return transportRef.current != null;
    },
  };
}

function planAllowsDaily(payload: Record<string, unknown>): boolean {
  return selectTransport(
    payload.add != null || payload.remove != null ? "board_delta" : "history_op",
    true,
  ) === "daily";
}
