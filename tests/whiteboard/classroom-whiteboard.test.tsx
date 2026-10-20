import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STREAM_SAFE_LIMIT,
  buildRequestSnapshot,
  buildSnapshotChunks,
  noteSnapshotChunk,
  readPaperStyleChange,
  readWhiteboardShortcut,
  shouldRequestSnapshot,
  type SnapshotChunkEvent,
} from "../../components/ClassroomWhiteboard";
import { applyHistoryBackward, applyHistoryForward } from "../../lib/whiteboard/display-list";
import { backingStoreSize } from "../../lib/whiteboard/hidpi";
import {
  alignRecognizedShape,
  constrainLineEnd,
  draftFromRecognized,
  shouldSnapRecognizedToGrid,
  snapPointToGrid,
  snapRadiusToGrid,
} from "../../lib/whiteboard/snap-commit";
import { SnapSession } from "../../lib/whiteboard/snap-session";
import type { RecognizedShape } from "../../lib/whiteboard/types";

function zigzagStroke(id: string, count: number) {
  const points = [];
  for (let i = 0; i < count; i++) points.push({ x: i * 4, y: (i % 2) * 24 });
  return {
    kind: "stroke" as const,
    id,
    tool: "pen" as const,
    color: "#111111",
    width: 2,
    opacity: 1,
    strokeStyle: "solid" as const,
    points,
    pageIndex: 0,
  };
}

function chunkBytes(chunk: SnapshotChunkEvent): number {
  return JSON.stringify({ type: "board_sync", v: 6, ...chunk }).length;
}

function drawLine(session: SnapSession): void {
  session.begin(0, 0, 0);
  session.move(40, 0, 12);
  session.move(100, 0, 24);
}

describe("classroom whiteboard live snap", () => {
  const sessions: SnapSession[] = [];

  afterEach(() => {
    for (const session of sessions) session.dispose();
    sessions.length = 0;
    vi.useRealTimers();
  });

  function track(): { session: SnapSession; seen: Array<RecognizedShape | null> } {
    vi.useFakeTimers();
    const seen: Array<RecognizedShape | null> = [];
    const session = new SnapSession((preview) => {
      seen.push(preview);
    });
    sessions.push(session);
    return { session, seen };
  }

  it("previews a straight line after a 450ms dwell", () => {
    const { session, seen } = track();
    drawLine(session);
    vi.advanceTimersByTime(449);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    const ghost = seen.at(-1);
    expect(ghost?.type).toBe("line");
    if (ghost?.type !== "line") return;
    expect(ghost.start).toEqual({ x: 0, y: 0 });
    expect(ghost.end).toEqual({ x: 100, y: 0 });
  });

  it("resets the dwell timer when the pen moves more than 5px", () => {
    const { session, seen } = track();
    drawLine(session);
    vi.advanceTimersByTime(450);
    expect(seen.at(-1)?.type).toBe("line");

    session.move(105, 0, 500);
    expect(seen.at(-1)?.type).toBe("line");

    session.move(106, 0, 520);
    expect(seen.at(-1)).toBeNull();

    vi.advanceTimersByTime(449);
    expect(seen.at(-1)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(seen.at(-1)?.type).toBe("line");
  });

  it("keeps freehand ink when the pen lifts before the dwell", () => {
    const { session } = track();
    drawLine(session);
    expect(session.finish(80).type).toBe("freehand");
  });

  it("commits the snapped line once the dwell has elapsed", () => {
    const { session } = track();
    drawLine(session);
    vi.advanceTimersByTime(450);
    const committed = session.finish(24 + 450);
    expect(committed.type).toBe("line");
    const draft = draftFromRecognized(committed);
    expect(draft).toEqual({ shape: "line", x: 0, y: 0, w: 100, h: 0 });
  });

  it("drops the dwell timer when the board unmounts", () => {
    const { session, seen } = track();
    drawLine(session);
    session.dispose();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
  });

  it("snaps a held circle to an ellipse on the display list", () => {
    const { session, seen } = track();
    const cx = 80;
    const cy = 60;
    const radius = 48;
    const count = 64;
    session.begin(cx + radius, cy, 0);
    for (let i = 1; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      session.move(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), i * 8);
    }
    vi.advanceTimersByTime(450);
    const ghost = seen.at(-1);
    expect(ghost?.type).toBe("circle");
    if (ghost?.type !== "circle") return;
    const draft = draftFromRecognized(ghost);
    expect(draft?.shape).toBe("ellipse");
    expect(draft?.w).toBeCloseTo(ghost.radius * 2, 8);
    expect(draft?.h).toBeCloseTo(ghost.radius * 2, 8);
  });

  it("undo and redo a committed snap on the display list", () => {
    const { session } = track();
    drawLine(session);
    vi.advanceTimersByTime(450);
    const draft = draftFromRecognized(session.finish(24 + 450));
    expect(draft).not.toBeNull();
    if (!draft) return;
    const el = { id: "snap-1", ...draft };
    const change = { removed: [], added: [el], updated: [] };
    const committed = applyHistoryForward([], change);
    expect(committed.map((item) => item.id)).toEqual(["snap-1"]);
    expect(applyHistoryBackward(committed, change)).toEqual([]);
    expect(applyHistoryForward([], change)).toEqual(committed);
  });

  it("sizes the page canvas for HiDPI", () => {
    expect(backingStoreSize(794, 1123, 2)).toEqual({
      width: 1588,
      height: 2246,
      scale: 2,
    });
    expect(backingStoreSize(794, 1123, 1.25).scale).toBe(2);
    expect(backingStoreSize(794, 1123, Number.NaN).scale).toBe(1);
  });

  it("keeps recognizing after the sample buffer grows past its initial capacity", () => {
    const { session, seen } = track();
    session.begin(0, 0, 0);
    for (let i = 1; i <= 300; i++) session.move(i, 0, i);
    vi.advanceTimersByTime(450);
    const ghost = seen.at(-1);
    expect(ghost?.type).toBe("line");
    if (ghost?.type !== "line") return;
    expect(ghost.end.x).toBe(300);
  });
});

describe("classroom whiteboard late-join sync", () => {
  it("asks for a snapshot once when the board is empty", () => {
    expect(shouldRequestSnapshot(0, false)).toBe(true);
    expect(shouldRequestSnapshot(0, true)).toBe(false);
    expect(shouldRequestSnapshot(4, false)).toBe(false);
    expect(buildRequestSnapshot("student-1", 1_700_000_000_000)).toEqual({
      action: "request_snapshot",
      senderId: "student-1",
      timestamp: 1_700_000_000_000,
    });
  });

  it("splits a snapshot into safe chunks and reassembles every element", () => {
    const elements = Array.from({ length: 24 }, (_, index) => zigzagStroke(`stroke-${index}`, 80));
    const chunks = buildSnapshotChunks(elements, "ruled", "snap-1", "teacher-1");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.action).toBe("snapshot_chunk");
      expect(chunk.paperStyle).toBe("ruled");
      expect(chunkBytes(chunk)).toBeLessThanOrEqual(STREAM_SAFE_LIMIT);
      expect(chunkBytes(chunk)).toBeLessThan(4000);
    }

    const buffers = new Map<string, SnapshotChunkEvent[]>();
    let ready: { elements: { id: string }[]; paperStyle: string } | null = null;
    const shuffled = [...chunks].reverse();
    for (const chunk of shuffled) {
      ready = noteSnapshotChunk(buffers, chunk);
    }
    expect(ready).not.toBeNull();
    expect(ready?.paperStyle).toBe("ruled");
    expect(ready?.elements.map((el) => el.id)).toEqual(elements.map((el) => el.id));
  });

  it("applies a paper style change and ignores an unknown style", () => {
    expect(readPaperStyleChange({ action: "paper_style_change", paperStyle: "dotted" })).toBe("dotted");
    expect(readPaperStyleChange({ action: "paper_style_change", paperStyle: "blank" })).toBe("blank");
    expect(readPaperStyleChange({ action: "paper_style_change", paperStyle: "graph" })).toBeNull();
    expect(readPaperStyleChange({ action: "request_snapshot", paperStyle: "ruled" })).toBeNull();
  });
});

function pointOnRay(origin: { x: number; y: number }, degrees: number, radius: number) {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: origin.x + radius * Math.cos(radians),
    y: origin.y + radius * Math.sin(radians),
  };
}

describe("grid snap and shift-locked lines", () => {
  it("rounds (23, 49) to (24, 48) on a 24px grid", () => {
    expect(snapPointToGrid(23, 49, 24)).toEqual({ x: 24, y: 48 });
    expect(snapPointToGrid(23, 49)).toEqual({ x: 24, y: 48 });
  });

  it("locks a line dragged at about 38° to exactly 45° while shift is held", () => {
    const start = { x: 12, y: 8 };
    const radius = 160;
    const end = pointOnRay(start, 38, radius);
    const locked = constrainLineEnd(start, end, true);
    const dx = locked.x - start.x;
    const dy = locked.y - start.y;
    expect(Math.atan2(dy, dx)).toBeCloseTo(Math.PI / 4, 10);
    expect(dx).toBeCloseTo(dy, 8);
    expect(Math.hypot(dx, dy)).toBeCloseTo(radius, 6);
  });

  it("locks a line dragged at about 85° to a perfect vertical while shift is held", () => {
    const start = { x: 40, y: 18 };
    const radius = 90;
    const end = pointOnRay(start, 85, radius);
    const locked = constrainLineEnd(start, end, true);
    expect(locked.x).toBe(start.x);
    expect(locked.y).toBeCloseTo(start.y + radius, 8);
    expect(Math.atan2(locked.y - start.y, locked.x - start.x)).toBeCloseTo(Math.PI / 2, 10);
  });

  it("keeps the raw endpoint when shift is not held", () => {
    const start = { x: 0, y: 0 };
    const end = pointOnRay(start, 38, 100);
    expect(constrainLineEnd(start, end, false)).toEqual(end);
  });

  it("snaps a recognized line, polygon, and circle only when snapToGrid is set", () => {
    const line = {
      type: "line" as const,
      start: { x: 23, y: 49 },
      end: { x: 50, y: 10 },
    };
    expect(draftFromRecognized(line)).toEqual({ shape: "line", x: 23, y: 49, w: 27, h: -39 });
    expect(draftFromRecognized(line, { snapToGrid: true })).toEqual({
      shape: "line",
      x: 24,
      y: 48,
      w: 24,
      h: -48,
    });

    const snappedTriangle = draftFromRecognized(
      {
        type: "polygon",
        vertices: [
          { x: 23, y: 49 },
          { x: 70, y: 10 },
          { x: 10, y: 80 },
        ],
      },
      { snapToGrid: true },
    );
    expect(snappedTriangle?.shape).toBe("triangle");
    expect(snappedTriangle?.vertices).toEqual([
      { x: 24, y: 48 },
      { x: 72, y: 0 },
      { x: 0, y: 72 },
    ]);

    expect(snapRadiusToGrid(30, 24)).toBe(36);
    expect(
      draftFromRecognized({ type: "circle", center: { x: 23, y: 49 }, radius: 30 }, { snapToGrid: true }),
    ).toEqual({ shape: "ellipse", x: -12, y: 12, w: 72, h: 72 });
  });

  it("applies 45° lock before grid snap on a recognized line", () => {
    const start = { x: 0, y: 0 };
    const aligned = alignRecognizedShape(
      { type: "line", start, end: pointOnRay(start, 38, 100) },
      { constrainLine: true, snapToGrid: true },
    );
    expect(aligned).toEqual({
      type: "line",
      start: { x: 0, y: 0 },
      end: { x: 72, y: 72 },
    });
  });

  it("snaps recognized geometry on grid paper and leaves ruled, dotted, and blank alone", () => {
    expect(shouldSnapRecognizedToGrid("grid")).toBe(true);
    expect(shouldSnapRecognizedToGrid("ruled")).toBe(false);
    expect(shouldSnapRecognizedToGrid("dotted")).toBe(false);
    expect(shouldSnapRecognizedToGrid("blank")).toBe(false);
  });

  it("keeps Cmd+Shift+Z and Ctrl+Shift+Z as redo", () => {
    expect(readWhiteboardShortcut({ key: "z", metaKey: true, ctrlKey: false, shiftKey: true })).toBe("redo");
    expect(readWhiteboardShortcut({ key: "Z", metaKey: false, ctrlKey: true, shiftKey: true })).toBe("redo");
    expect(
      readWhiteboardShortcut({ key: "ז", code: "KeyZ", metaKey: true, ctrlKey: false, shiftKey: true }),
    ).toBe("redo");
    expect(readWhiteboardShortcut({ key: "z", metaKey: true, ctrlKey: false, shiftKey: false })).toBe("undo");
    expect(readWhiteboardShortcut({ key: "Shift", metaKey: true, ctrlKey: false, shiftKey: true })).toBeNull();

    const restored = { id: "line-1" };
    const change = { removed: [], added: [restored], updated: [] };
    expect(readWhiteboardShortcut({ key: "z", metaKey: true, ctrlKey: false, shiftKey: true })).toBe("redo");
    expect(applyHistoryForward([], change)).toEqual([restored]);
  });
});
