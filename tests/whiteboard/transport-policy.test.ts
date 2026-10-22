import { describe, expect, it } from "vitest";
import {
  LASER_STREAM_FALLBACK,
  classifyBoardPayload,
  planBoardDelivery,
  selectTransport,
  type BoardEventKind,
} from "../../lib/whiteboard/transport-policy";

const DURABLE: BoardEventKind[] = [
  "snapshot_request",
  "snapshot_response",
  "clear",
  "paper_style",
  "page_count",
  "history_op",
  "layer_order",
];

describe("whiteboard transport policy", () => {
  it("keeps the hot path on Daily and durable events on Stream while the call is joined", () => {
    expect(selectTransport("board_delta", true)).toBe("daily");
    expect(selectTransport("laser_update", true)).toBe("daily");
    for (const kind of DURABLE) expect(selectTransport(kind, true)).toBe("stream");

    expect(planBoardDelivery({ add: { id: "stroke-1" }, seq: 1 }, true)).toEqual({
      daily: true,
      stream: false,
    });
    expect(planBoardDelivery({ remove: ["stroke-1"] }, true)).toEqual({ daily: true, stream: false });
    expect(planBoardDelivery({ action: "clear" }, true)).toEqual({ daily: false, stream: true });
    expect(planBoardDelivery({ action: "paper_style_change", paperStyle: "grid" }, true)).toEqual({
      daily: false,
      stream: true,
    });
    expect(planBoardDelivery({ action: "request_snapshot" }, true)).toEqual({ daily: false, stream: true });
    expect(planBoardDelivery({ action: "snapshot_chunk" }, true)).toEqual({ daily: false, stream: true });
    expect(planBoardDelivery({ pageCount: 3 }, true)).toEqual({ daily: false, stream: true });
    expect(planBoardDelivery({ historyOp: { id: "op-1" } }, true)).toEqual({ daily: false, stream: true });
    expect(planBoardDelivery({ type: "laser_update" }, true)).toEqual({ daily: true, stream: false });
  });

  it("falls board deltas back to Stream when Daily is absent and disables the laser", () => {
    expect(LASER_STREAM_FALLBACK).toBe("disabled");
    expect(selectTransport("board_delta", false)).toBe("stream");
    expect(selectTransport("laser_update", false)).toBeNull();
    expect(planBoardDelivery({ add: { id: "stroke-1" } }, false)).toEqual({ daily: false, stream: true });
    expect(planBoardDelivery({ type: "laser_update" }, false)).toEqual({ daily: false, stream: false });
    expect(planBoardDelivery({ action: "clear" }, false)).toEqual({ daily: false, stream: true });
    expect(planBoardDelivery({ historyOp: { id: "op-1" }, direction: "forward" }, false)).toEqual({
      daily: false,
      stream: true,
    });
  });

  it("classifies the payloads the room actually sends", () => {
    expect(classifyBoardPayload({ add: { id: "a" } })).toBe("board_delta");
    expect(classifyBoardPayload({ remove: ["a"] })).toBe("board_delta");
    expect(classifyBoardPayload({ type: "board_delta" })).toBe("board_delta");
    expect(classifyBoardPayload({ type: "laser_update" })).toBe("laser_update");
    expect(classifyBoardPayload({ action: "request_snapshot" })).toBe("snapshot_request");
    expect(classifyBoardPayload({ type: "snapshot_response" })).toBe("snapshot_response");
    expect(classifyBoardPayload({ action: "clear" })).toBe("clear");
    expect(classifyBoardPayload({ action: "paper_style_change" })).toBe("paper_style");
    expect(classifyBoardPayload({ pageCount: 2 })).toBe("page_count");
    expect(classifyBoardPayload({ historyOp: {} })).toBe("history_op");
    expect(classifyBoardPayload({ layerOrder: { pageIndex: 0, ids: [] } })).toBe("layer_order");
  });
});
