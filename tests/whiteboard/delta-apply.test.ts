import { describe, expect, it } from "vitest";
import { applyLiveAdd } from "../../components/ClassroomWhiteboard";
import { encodeDailyMessage, decodeDailyMessage } from "../../lib/whiteboard/daily-transport";
import {
  MAX_TRACKED_SENDERS,
  SEEN_EVENT_LIMIT,
  TOMBSTONE_TTL_MS,
  createDeltaApplyState,
  guardIncomingOp,
  isOwnBoardEcho,
  nextDeltaSeq,
  pushSenderDelta,
  resolveBoardSenderId,
  resolveBoardSenderKey,
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

  it("stamps a monotonic outgoing seq", () => {
    const state = createDeltaApplyState();
    expect(nextDeltaSeq(state)).toBe(1);
    expect(nextDeltaSeq(state)).toBe(2);
  });

  it("accepts a fresh session at seq 1 after the previous session reached seq 51", () => {
    const state = createDeltaApplyState();
    const previous = resolveBoardSenderKey("user-1", "tab-a", "oldses");
    const fresh = resolveBoardSenderKey("user-1", "tab-a", "newses");
    expect(previous).toBe("user-1:oldses");
    expect(fresh).toBe("user-1:newses");
    expect(fresh).not.toBe(previous);

    for (let seq = 1; seq <= 51; seq += 1) {
      const accepted = pushSenderDelta(state, { senderId: previous, seq, ops: [{ op: "add", id: `old-${seq}` }] }, seq);
      expect(accepted).toHaveLength(1);
    }

    const restarted = pushSenderDelta(
      state,
      { senderId: fresh, seq: 1, ops: [{ op: "add", id: "fresh-stroke" }] },
      52,
    );
    expect(restarted.map((event) => event.ops[0]?.id)).toEqual(["fresh-stroke"]);
  });

  it("applies one event received on two transports exactly once", () => {
    const state = createDeltaApplyState();
    const event = delta(7, "add", "shared");
    expect(pushSenderDelta(state, event, 1).map((item) => item.ops[0]?.id)).toEqual(["shared"]);
    expect(pushSenderDelta(state, event, 2)).toEqual([]);
    expect(pushSenderDelta(state, { ...event }, 3)).toEqual([]);
  });

  it("applies out-of-order sequence numbers and ignores only exact duplicates", () => {
    const state = createDeltaApplyState();
    const t0 = 5_000;
    expect(pushSenderDelta(state, delta(4, "add", "fourth"), t0).map((event) => event.seq)).toEqual([4]);
    expect(pushSenderDelta(state, delta(1, "add", "first"), t0 + 1).map((event) => event.ops[0]?.id)).toEqual(["first"]);
    expect(pushSenderDelta(state, delta(4, "add", "fourth"), t0 + 2)).toEqual([]);
    expect(pushSenderDelta(state, delta(2, "add", "second"), t0 + 3).map((event) => event.seq)).toEqual([2]);
  });

  it("does not drop a second tab of the same user as an echo", () => {
    const local = resolveBoardSenderKey("user-1", "tab-a", "aaaaaa");
    const otherTab = resolveBoardSenderKey("user-1", "tab-b", "bbbbbb");
    expect(local).not.toBe(otherTab);
    expect(isOwnBoardEcho(local, local)).toBe(true);
    expect(isOwnBoardEcho(otherTab, local)).toBe(false);
    expect(resolveBoardSenderKey("", "tab-9", "sess01")).toBe("tab-9");
    expect(resolveBoardSenderKey(null, "tab-9", "sess01")).toBe("tab-9");

    const state = createDeltaApplyState();
    const applied = isOwnBoardEcho(otherTab, local)
      ? []
      : pushSenderDelta(state, { senderId: otherTab, seq: 1, ops: [{ op: "add", id: "tab-b-stroke" }] }, 0);
    expect(applied.map((event) => event.ops[0]?.id)).toEqual(["tab-b-stroke"]);
    expect(isOwnBoardEcho(local, local) ? [] : pushSenderDelta(state, { senderId: local, seq: 1, ops: [{ op: "add", id: "echo" }] }, 0)).toEqual(
      [],
    );
  });

  it("slides event ids out after 2000 and evicts sender keys past 50", () => {
    const state = createDeltaApplyState();
    const senderKey = "user-1:sess01";
    for (let seq = 1; seq <= SEEN_EVENT_LIMIT; seq += 1) {
      expect(pushSenderDelta(state, { senderId: senderKey, seq, ops: [{ op: "add", id: `s-${seq}` }] }, seq)).toHaveLength(1);
    }
    expect(pushSenderDelta(state, { senderId: senderKey, seq: 1, ops: [{ op: "add", id: "dup" }] }, 0)).toEqual([]);

    expect(
      pushSenderDelta(
        state,
        { senderId: senderKey, seq: SEEN_EVENT_LIMIT + 1, ops: [{ op: "add", id: "newest" }] },
        0,
      ),
    ).toHaveLength(1);
    expect(pushSenderDelta(state, { senderId: senderKey, seq: 1, ops: [{ op: "add", id: "slid" }] }, 0)).toHaveLength(1);
    expect(state.seen.size).toBeLessThanOrEqual(SEEN_EVENT_LIMIT);

    const capped = createDeltaApplyState();
    for (let index = 0; index < MAX_TRACKED_SENDERS; index += 1) {
      pushSenderDelta(capped, { senderId: `user-${index}:sess`, seq: 1, ops: [{ op: "add", id: `u-${index}` }] }, index);
    }
    expect(capped.senders.size).toBe(MAX_TRACKED_SENDERS);
    pushSenderDelta(capped, { senderId: "user-extra:sess", seq: 1, ops: [{ op: "add", id: "extra" }] }, 0);
    expect(capped.senders.has("user-0:sess")).toBe(false);
    expect(capped.senders.size).toBe(MAX_TRACKED_SENDERS);
    expect(pushSenderDelta(capped, { senderId: "user-0:sess", seq: 1, ops: [{ op: "add", id: "still-dup" }] }, 0)).toEqual([]);
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
