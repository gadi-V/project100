import { describe, expect, it } from "vitest";
import {
  createDailyTransport,
  type DailyAppMessageEvent,
  type DailyAppSession,
  type DailyBoardMessage,
  type DailyBoardTransport,
} from "../../lib/whiteboard/daily-transport";
import { createDailyPeerSync, type LiveBoard } from "../../lib/whiteboard/daily-peer-sync";

function linkSessions() {
  const listeners = new Map<string, Set<(event: DailyAppMessageEvent) => void>>();
  const wire: Array<{ fromId: string; data: unknown }> = [];

  function session(id: string): DailyAppSession {
    return {
      sendAppMessage(data) {
        wire.push({ fromId: id, data });
        for (const [other, handlers] of listeners) {
          if (other === id) continue;
          for (const handler of handlers) handler({ data, fromId: id });
        }
      },
      on(_event, handler) {
        const bucket = listeners.get(id) ?? new Set();
        bucket.add(handler);
        listeners.set(id, bucket);
      },
      off(_event, handler) {
        listeners.get(id)?.delete(handler);
      },
    };
  }

  function open(id: string): DailyBoardTransport {
    return createDailyTransport(session(id));
  }

  return { open, wire };
}

function board(elements: LiveBoard["elements"], paperStyle = "grid"): LiveBoard {
  return { elements, paperStyle };
}

describe("daily peer snapshot handshake", () => {
  it("loads the server baseline, then replaces it with a non-empty peer snapshot", () => {
    const network = linkSessions();
    let teacher = board([{ id: "live-stroke", kind: "stroke", pts: [1, 2, 8, 9], pageIndex: 0 }], "ruled");
    let student = board([{ id: "server-stroke", kind: "stroke", pts: [0, 0, 1, 1], pageIndex: 0 }], "grid");
    const teacherSync = createDailyPeerSync({
      transport: network.open("teacher-1"),
      userId: "teacher-1",
      now: () => 1_700,
      readBoard: () => teacher,
      applyLive: (next) => {
        teacher = next;
      },
    });
    const studentSync = createDailyPeerSync({
      transport: network.open("student-1"),
      userId: "student-1",
      now: () => 1_700,
      readBoard: () => student,
      applyLive: (next) => {
        student = next;
      },
    });

    studentSync.onServerBaselineReady();

    expect(network.wire.map((entry) => (entry.data as DailyBoardMessage).type)).toEqual([
      "request_snapshot",
      "snapshot_response",
    ]);
    expect(student).toEqual(board([{ id: "live-stroke", kind: "stroke", pts: [1, 2, 8, 9], pageIndex: 0 }], "ruled"));
    expect(teacher.elements.map((element) => element.id)).toEqual(["live-stroke"]);
    teacherSync.close();
    studentSync.close();
  });

  it("does not let an empty peer answer or wipe the server snapshot", () => {
    const network = linkSessions();
    const teacher = board([]);
    let student = board([{ id: "server-stroke", kind: "stroke", pageIndex: 0 }]);
    const teacherSync = createDailyPeerSync({
      transport: network.open("teacher-1"),
      userId: "teacher-1",
      readBoard: () => teacher,
      applyLive: () => {
        throw new Error("empty peer must not publish a snapshot");
      },
    });
    const studentSync = createDailyPeerSync({
      transport: network.open("student-1"),
      userId: "student-1",
      readBoard: () => student,
      applyLive: (next) => {
        student = next;
      },
    });

    studentSync.onServerBaselineReady();
    expect(network.wire.map((entry) => (entry.data as DailyBoardMessage).type)).toEqual(["request_snapshot"]);
    expect(student.elements).toEqual([{ id: "server-stroke", kind: "stroke", pageIndex: 0 }]);

    const ghost = network.open("ghost");
    ghost.send({
      type: "snapshot_response",
      senderId: "ghost",
      snapshotId: "empty",
      chunkIndex: 0,
      totalChunks: 1,
      paperStyle: "blank",
      elements: [],
    });
    expect(student.elements).toEqual([{ id: "server-stroke", kind: "stroke", pageIndex: 0 }]);
    expect(student.paperStyle).toBe("grid");

    teacherSync.close();
    studentSync.close();
    ghost.close();
  });

  it("keeps laser updates off the live snapshot", () => {
    const network = linkSessions();
    let student = board([{ id: "server-stroke", kind: "stroke", pageIndex: 0 }]);
    const lasers: string[] = [];
    const studentSync = createDailyPeerSync({
      transport: network.open("student-1"),
      userId: "student-1",
      readBoard: () => student,
      applyLive: (next) => {
        student = next;
      },
      onLaser: (update) => lasers.push(update.userId),
    });
    const teacher = network.open("teacher-1");
    studentSync.onServerBaselineReady();
    teacher.send({
      type: "laser_update",
      x: 12,
      y: 18,
      color: "#ef4444",
      userId: "teacher-1",
      active: true,
      pageIndex: 0,
    });

    expect(lasers).toEqual(["teacher-1"]);
    expect(student.elements).toEqual([{ id: "server-stroke", kind: "stroke", pageIndex: 0 }]);
    expect(JSON.stringify(student)).not.toContain("laser");
    studentSync.close();
    teacher.close();
  });
});
