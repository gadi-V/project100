import { describe, expect, it } from "vitest";
import {
  LASER_STREAM_FALLBACK,
  RECEIVER_HOPS,
  classifyBoardPayload,
  planBoardDelivery,
  type BoardRouteContext,
} from "../../lib/whiteboard/transport-policy";

const JOINED_WITH_PEER: BoardRouteContext = { dailyJoined: true, remoteParticipants: 1 };
const JOINED_ALONE: BoardRouteContext = { dailyJoined: true, remoteParticipants: 0 };
const OFF_DAILY: BoardRouteContext = { dailyJoined: false, remoteParticipants: 0 };

describe("whiteboard transport policy", () => {
  it("keeps both receivers armed", () => {
    expect(RECEIVER_HOPS).toEqual({ daily: true, stream: true });
  });

  it("copies persistent ops to Daily only when a remote peer is present, and always keeps Stream", () => {
    expect(planBoardDelivery({ add: { id: "stroke-1" }, seq: 1 }, JOINED_WITH_PEER)).toEqual({
      daily: true,
      stream: true,
    });
    expect(planBoardDelivery({ remove: ["stroke-1"] }, JOINED_WITH_PEER)).toEqual({ daily: true, stream: true });
    expect(planBoardDelivery({ action: "clear" }, JOINED_WITH_PEER)).toEqual({ daily: true, stream: true });
    expect(planBoardDelivery({ action: "paper_style_change", paperStyle: "grid" }, JOINED_WITH_PEER)).toEqual({
      daily: true,
      stream: true,
    });
    expect(planBoardDelivery({ pageCount: 3 }, JOINED_WITH_PEER)).toEqual({ daily: true, stream: true });
    expect(planBoardDelivery({ historyOp: { id: "op-1" } }, JOINED_WITH_PEER)).toEqual({ daily: true, stream: true });
    expect(planBoardDelivery({ layerOrder: { pageIndex: 0, ids: [] } }, JOINED_WITH_PEER)).toEqual({
      daily: true,
      stream: true,
    });

    expect(planBoardDelivery({ add: { id: "stroke-1" } }, JOINED_ALONE)).toEqual({ daily: false, stream: true });
    expect(planBoardDelivery({ action: "clear" }, OFF_DAILY)).toEqual({ daily: false, stream: true });
  });

  it("sends snapshot requests on both transports and prefers Daily for the reply", () => {
    expect(planBoardDelivery({ action: "request_snapshot" }, JOINED_WITH_PEER)).toEqual({
      daily: true,
      stream: true,
    });
    expect(planBoardDelivery({ action: "request_snapshot" }, JOINED_ALONE)).toEqual({ daily: true, stream: true });
    expect(planBoardDelivery({ action: "request_snapshot" }, OFF_DAILY)).toEqual({ daily: false, stream: true });
    expect(
      planBoardDelivery({ action: "snapshot_chunk" }, { ...JOINED_WITH_PEER, requesterOnDaily: true }),
    ).toEqual({ daily: true, stream: false });
    expect(
      planBoardDelivery({ type: "snapshot_response" }, { ...JOINED_WITH_PEER, requesterOnDaily: false }),
    ).toEqual({ daily: false, stream: true });
    expect(planBoardDelivery({ action: "snapshot_chunk" }, { ...OFF_DAILY, requesterOnDaily: true })).toEqual({
      daily: false,
      stream: true,
    });
  });

  it("keeps the laser and stroke previews off Stream", () => {
    expect(LASER_STREAM_FALLBACK).toBe("disabled");
    expect(planBoardDelivery({ type: "laser_update" }, JOINED_WITH_PEER)).toEqual({ daily: true, stream: false });
    expect(planBoardDelivery({ type: "stroke_preview" }, JOINED_WITH_PEER)).toEqual({ daily: true, stream: false });
    expect(planBoardDelivery({ type: "laser_update" }, JOINED_ALONE)).toEqual({ daily: false, stream: false });
    expect(planBoardDelivery({ action: "stroke_preview" }, OFF_DAILY)).toEqual({ daily: false, stream: false });
  });

  it("classifies the payloads the room actually sends", () => {
    expect(classifyBoardPayload({ add: { id: "a" } })).toBe("board_delta");
    expect(classifyBoardPayload({ remove: ["a"] })).toBe("board_delta");
    expect(classifyBoardPayload({ type: "board_delta" })).toBe("board_delta");
    expect(classifyBoardPayload({ type: "laser_update" })).toBe("laser_update");
    expect(classifyBoardPayload({ type: "stroke_preview" })).toBe("stroke_preview");
    expect(classifyBoardPayload({ action: "request_snapshot" })).toBe("snapshot_request");
    expect(classifyBoardPayload({ type: "snapshot_response" })).toBe("snapshot_response");
    expect(classifyBoardPayload({ action: "clear" })).toBe("clear");
    expect(classifyBoardPayload({ action: "paper_style_change" })).toBe("paper_style");
    expect(classifyBoardPayload({ pageCount: 2 })).toBe("page_count");
    expect(classifyBoardPayload({ historyOp: {} })).toBe("history_op");
    expect(classifyBoardPayload({ layerOrder: { pageIndex: 0, ids: [] } })).toBe("layer_order");
  });
});
