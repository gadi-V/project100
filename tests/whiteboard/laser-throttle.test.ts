import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LASER_BROADCAST_INTERVAL_MS,
  LASER_IDLE_MS,
  applyLaserUpdate,
  createLaserPointer,
  visibleLasers,
  type LaserUpdateMessage,
} from "../../lib/whiteboard/laser-pointer";

describe("broadcast laser pointer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throttles moves into a 30–50ms interval and keeps the latest point", () => {
    expect(LASER_BROADCAST_INTERVAL_MS).toBeGreaterThanOrEqual(30);
    expect(LASER_BROADCAST_INTERVAL_MS).toBeLessThanOrEqual(50);
    vi.useFakeTimers();
    let now = 10_000;
    const sent: LaserUpdateMessage[] = [];
    const pointer = createLaserPointer({
      userId: "teacher-1",
      color: "#ef4444",
      now: () => now,
      send: (update) => sent.push(update),
    });

    pointer.move({ x: 10, y: 20, pageIndex: 1 });
    expect(sent).toEqual([
      { type: "laser_update", x: 10, y: 20, color: "#ef4444", userId: "teacher-1", active: true, pageIndex: 1 },
    ]);

    now += 10;
    pointer.move({ x: 11.04, y: 21, pageIndex: 1 });
    pointer.move({ x: 18.26, y: 30, pageIndex: 1 });
    expect(sent).toHaveLength(1);

    now += LASER_BROADCAST_INTERVAL_MS - 10;
    vi.advanceTimersByTime(LASER_BROADCAST_INTERVAL_MS - 10);
    expect(sent).toEqual([
      { type: "laser_update", x: 10, y: 20, color: "#ef4444", userId: "teacher-1", active: true, pageIndex: 1 },
      { type: "laser_update", x: 18.3, y: 30, color: "#ef4444", userId: "teacher-1", active: true, pageIndex: 1 },
    ]);

    now += LASER_BROADCAST_INTERVAL_MS;
    pointer.move({ x: 40, y: 50, pageIndex: 0 });
    expect(sent.at(-1)).toMatchObject({ x: 40, y: 50, active: true, pageIndex: 0 });
  });

  it("dismisses the pointer after 1.5s without movement", () => {
    expect(LASER_IDLE_MS).toBe(1500);
    vi.useFakeTimers();
    let now = 0;
    const sent: LaserUpdateMessage[] = [];
    let idleClears = 0;
    const pointer = createLaserPointer({
      userId: "teacher-1",
      color: "#ef4444",
      now: () => now,
      send: (update) => sent.push(update),
      onIdle: () => {
        idleClears += 1;
      },
    });

    pointer.move({ x: 4, y: 8, pageIndex: 0 });
    now += LASER_IDLE_MS - 1;
    vi.advanceTimersByTime(LASER_IDLE_MS - 1);
    expect(sent.map((update) => update.active)).toEqual([true]);
    expect(idleClears).toBe(0);

    now += 1;
    vi.advanceTimersByTime(1);
    expect(sent.at(-1)).toMatchObject({ type: "laser_update", active: false, userId: "teacher-1" });
    expect(idleClears).toBe(1);

    const remote = applyLaserUpdate([], sent[0], 0);
    expect(visibleLasers(remote, LASER_IDLE_MS - 1)).toHaveLength(1);
    expect(visibleLasers(remote, LASER_IDLE_MS)).toEqual([]);
    expect(applyLaserUpdate(remote, sent.at(-1)!, LASER_IDLE_MS)).toEqual([]);
  });

  it("clears the pointer on leave and does not broadcast after dispose", () => {
    vi.useFakeTimers();
    let now = 500;
    const sent: LaserUpdateMessage[] = [];
    const pointer = createLaserPointer({
      userId: "student-1",
      color: "#22c55e",
      now: () => now,
      send: (update) => sent.push(update),
    });

    pointer.move({ x: 3, y: 4, pageIndex: 2 });
    now += 5;
    pointer.move({ x: 9, y: 10, pageIndex: 2 });
    pointer.leave();
    expect(sent.filter((update) => update.active)).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ active: false, userId: "student-1", color: "#22c55e" });

    now += 100;
    pointer.move({ x: 1, y: 1, pageIndex: 0 });
    expect(sent.at(-1)).toMatchObject({ active: true, x: 1, y: 1 });

    pointer.dispose();
    const afterDispose = sent.length;
    expect(sent.at(-1)).toMatchObject({ active: false, userId: "student-1" });
    now += 5_000;
    vi.advanceTimersByTime(5_000);
    pointer.move({ x: 2, y: 2, pageIndex: 0 });
    expect(sent).toHaveLength(afterDispose);
  });
});
