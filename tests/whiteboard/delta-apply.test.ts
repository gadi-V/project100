import { describe, expect, it } from "vitest";
import { applyLiveAdd } from "../../components/ClassroomWhiteboard";
import { encodeDailyMessage, decodeDailyMessage } from "../../lib/whiteboard/daily-transport";
import {
  SEQ_REORDER_MS,
  TOMBSTONE_TTL_MS,
  createDeltaApplyState,
  flushSenderDeltas,
  guardIncomingOp,
  nextDeltaSeq,
  pushSenderDelta,
  resolveBoardSenderId,
  type RemoteBoardEvent,
} from "../../lib/whiteboard/delta-apply";
import { createStrokePartStore } from "../../lib/whiteboard/stroke-parts";

function stroke(id: string, pts: number[]) {
  return {
    kind: "stroke",
    id,
    tool: "pen",
    color: "#0f172a",
    width: 2,
    opacity: 1,
    strokeStyle: "solid",
    pts,
    pageIndex: 0,
  };
}

function pointsOf(board: ReturnType<typeof applyLiveAdd>): Array<{ x: number; y: number }> {
  const el = board[0];
  if (!el || el.kind !== "stroke") return [];
  return el.points.map((point) => ({ x: point.x, y: point.y }));
}

function delta(seq: number, op: "add" | "remove", id: string): RemoteBoardEvent {
  return {
    senderId: "teacher-1",
    seq,
    ops: [{ op, id, element: op === "add" ? { kind: "shape", id } : undefined }],
  };
}

describe("idempotent board deltas", () => {
  it("uses one sender id for Daily and Stream", () => {
    expect(resolveBoardSenderId("user-1", "tab-9")).toBe("user-1");
    expect(resolveBoardSenderId("", "tab-9")).toBe("tab-9");
    expect(resolveBoardSenderId(null, "tab-9")).toBe("tab-9");
    expect(resolveBoardSenderId(undefined, "tab-9")).toBe("tab-9");
  });

  it("replaces a stroke part in place and reassembles by part index", () => {
    const parts = createStrokePartStore();
    let board = applyLiveAdd([], { add: stroke("ink", [2, 2, 3, 3]), strokePart: 1 }, parts);
    board = applyLiveAdd(board, { add: stroke("ink", [0, 0, 1, 1]), strokePart: 0 }, parts);
    expect(pointsOf(board)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);

    board = applyLiveAdd(board, { add: stroke("ink", [9, 9, 8, 8]), strokePart: 1 }, parts);
    expect(pointsOf(board)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 9, y: 9 },
      { x: 8, y: 8 },
    ]);
    expect(board).toHaveLength(1);
  });

  it("releases sender deltas in seq order and ignores stale or duplicate seqs", () => {
    const state = createDeltaApplyState();
    expect(nextDeltaSeq(state)).toBe(1);
    expect(nextDeltaSeq(state)).toBe(2);
    const t0 = 5_000;

    expect(pushSenderDelta(state, delta(2, "add", "late"), t0)).toEqual([]);
    expect(pushSenderDelta(state, delta(1, "add", "early"), t0 + 10)).toEqual([]);
    expect(pushSenderDelta(state, delta(1, "add", "early"), t0 + 20)).toEqual([]);

    const ordered = flushSenderDeltas(state, t0 + SEQ_REORDER_MS);
    expect(ordered.map((event) => event.seq)).toEqual([1, 2]);
    expect(ordered.map((event) => event.ops[0]?.id)).toEqual(["early", "late"]);

    const third = pushSenderDelta(state, delta(3, "add", "next"), t0 + SEQ_REORDER_MS + 5);
    expect(third.map((event) => event.seq)).toEqual([3]);
    expect(pushSenderDelta(state, delta(3, "add", "next"), t0 + SEQ_REORDER_MS + 6)).toEqual([]);
    expect(pushSenderDelta(state, delta(2, "add", "late"), t0 + SEQ_REORDER_MS + 7)).toEqual([]);
  });

  it("skips a seq gap once the reorder window has elapsed", () => {
    const state = createDeltaApplyState();
    const t0 = 8_000;
    pushSenderDelta(state, delta(1, "add", "a"), t0);
    expect(flushSenderDeltas(state, t0 + SEQ_REORDER_MS).map((event) => event.seq)).toEqual([1]);

    expect(pushSenderDelta(state, delta(4, "add", "d"), t0 + SEQ_REORDER_MS + 1)).toEqual([]);
    expect(flushSenderDeltas(state, t0 + SEQ_REORDER_MS + 20)).toEqual([]);
    const skipped = flushSenderDeltas(state, t0 + SEQ_REORDER_MS + 1 + SEQ_REORDER_MS);
    expect(skipped.map((event) => event.seq)).toEqual([4]);
    expect(pushSenderDelta(state, delta(2, "add", "lost"), t0 + 500)).toEqual([]);
  });

  it("drops an add that arrives after a remove until the tombstone expires", () => {
    const state = createDeltaApplyState();
    const now = 1_000;
    expect(guardIncomingOp(state, { op: "remove", id: "stroke-1" }, now)?.op).toBe("remove");
    expect(guardIncomingOp(state, { op: "add", id: "stroke-1", element: stroke("stroke-1", [1, 2]) }, now + 1_000)).toBeNull();
    expect(guardIncomingOp(state, { op: "add", id: "other", element: stroke("other", [1, 2]) }, now + 1_000)?.id).toBe("other");
    expect(
      guardIncomingOp(
        state,
        { op: "add", id: "stroke-1", element: stroke("stroke-1", [3, 4]) },
        now + TOMBSTONE_TTL_MS,
      )?.op,
    ).toBe("add");
    expect(TOMBSTONE_TTL_MS).toBeGreaterThanOrEqual(15_000);
    expect(TOMBSTONE_TTL_MS).toBeLessThanOrEqual(30_000);
  });

  it("keeps seq and part 0 on a Daily board delta", () => {
    const encoded = encodeDailyMessage({
      type: "board_delta",
      op: "add",
      senderId: "teacher-1",
      id: "stroke-1",
      seq: 4,
      part: 0,
      element: stroke("stroke-1", [1, 2, 3, 4]),
    });
    expect(encoded).not.toBeNull();
    expect(decodeDailyMessage(encoded)).toMatchObject({ seq: 4, part: 0, op: "add" });

    const removed = encodeDailyMessage({
      type: "board_delta",
      op: "remove",
      senderId: "teacher-1",
      id: "stroke-1",
      seq: 5,
    });
    expect(decodeDailyMessage(removed)).toMatchObject({ op: "remove", seq: 5, id: "stroke-1" });
  });
});
