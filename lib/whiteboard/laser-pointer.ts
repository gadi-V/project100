import type { LaserUpdateMessage } from "./daily-transport";

export const LASER_BROADCAST_INTERVAL_MS = 40;
export const LASER_IDLE_MS = 1500;
/** Local and remote pointers fade from opaque to clear over this long. */
export const LASER_FADE_MS = 800;

export type { LaserUpdateMessage };

export type LaserPoint = {
  x: number;
  y: number;
  pageIndex?: number;
};

export type RemoteLaser = {
  userId: string;
  x: number;
  y: number;
  color: string;
  pageIndex: number;
  active: boolean;
  updatedAt: number;
  /** Set when the pointer is released. Opacity runs to 0 over LASER_FADE_MS. */
  fadeStartedAt?: number;
};

export type LaserPointer = {
  move(point: LaserPoint): void;
  release(): void;
  leave(): void;
  dispose(): void;
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function laserFadeAlpha(elapsedMs: number, durationMs = LASER_FADE_MS): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  if (elapsedMs >= durationMs) return 0;
  return 1 - elapsedMs / durationMs;
}

export function laserOpacity(
  laser: RemoteLaser,
  now: number,
  fadeMs = LASER_FADE_MS,
  idleMs = LASER_IDLE_MS,
): number {
  if (laser.fadeStartedAt != null) return laserFadeAlpha(now - laser.fadeStartedAt, fadeMs);
  if (!laser.active) return 0;
  const idleFor = now - laser.updatedAt;
  if (idleFor < idleMs) return 1;
  return laserFadeAlpha(idleFor - idleMs, fadeMs);
}

export function applyLaserUpdate(
  current: readonly RemoteLaser[],
  update: LaserUpdateMessage,
  now: number,
): RemoteLaser[] {
  const existing = current.find((laser) => laser.userId === update.userId);
  const rest = current.filter((laser) => laser.userId !== update.userId);
  if (!update.active) {
    if (!existing) return rest;
    return [...rest, { ...existing, active: false, updatedAt: now, fadeStartedAt: now }];
  }
  return [
    ...rest,
    {
      userId: update.userId,
      x: update.x,
      y: update.y,
      color: update.color,
      pageIndex: update.pageIndex ?? existing?.pageIndex ?? 0,
      active: true,
      updatedAt: now,
    },
  ];
}

export function visibleLasers(
  current: readonly RemoteLaser[],
  now: number,
  idleMs = LASER_IDLE_MS,
): RemoteLaser[] {
  return current.filter((laser) => laserOpacity(laser, now, LASER_FADE_MS, idleMs) > 0);
}

export function createLaserPointer(options: {
  userId: string;
  /** Session-scoped sender key. Attached so a second tab is not treated as this pointer. */
  senderKey?: string;
  color: string;
  now?: () => number;
  send: (update: LaserUpdateMessage) => void;
  onIdle?: () => void;
  intervalMs?: number;
  idleMs?: number;
}): LaserPointer {
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? LASER_BROADCAST_INTERVAL_MS;
  const idleMs = options.idleMs ?? LASER_IDLE_MS;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let lastPoint: LaserPoint | null = null;
  let pending: LaserPoint | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let disposed = false;

  const clearThrottle = (): void => {
    if (throttleTimer === null) return;
    clearTimeout(throttleTimer);
    throttleTimer = null;
  };

  const clearIdle = (): void => {
    if (idleTimer === null) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const emit = (point: LaserPoint | null, isActive: boolean): void => {
    const update: LaserUpdateMessage = {
      type: "laser_update",
      x: point ? round1(point.x) : 0,
      y: point ? round1(point.y) : 0,
      color: options.color,
      userId: options.userId,
      active: isActive,
    };
    if (point?.pageIndex != null) update.pageIndex = point.pageIndex;
    if (options.senderKey) update.senderKey = options.senderKey;
    options.send(update);
    active = isActive;
    if (isActive) lastSentAt = now();
  };

  const armIdle = (): void => {
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!active || disposed) return;
      pending = null;
      clearThrottle();
      emit(lastPoint, false);
      options.onIdle?.();
    }, idleMs);
  };

  const flushPending = (): void => {
    throttleTimer = null;
    if (disposed || !pending) return;
    const point = pending;
    pending = null;
    emit(point, true);
    armIdle();
  };

  return {
    move(point) {
      if (disposed) return;
      lastPoint = point;
      const elapsed = now() - lastSentAt;
      if (!active || elapsed >= intervalMs) {
        clearThrottle();
        pending = null;
        emit(point, true);
        armIdle();
        return;
      }
      pending = point;
      if (throttleTimer === null) {
        throttleTimer = setTimeout(flushPending, Math.max(0, intervalMs - elapsed));
      }
      armIdle();
    },
    release() {
      if (disposed) return;
      clearThrottle();
      clearIdle();
      pending = null;
      if (!active) return;
      emit(lastPoint, false);
    },
    leave() {
      this.release();
    },
    dispose() {
      if (disposed) return;
      this.release();
      disposed = true;
    },
  };
}
