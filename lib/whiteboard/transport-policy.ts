/**
 * Where a board event is allowed to travel.
 *
 * Receivers listen on Daily and Stream at the same time.
 * Persistent ops always ride Stream. They are also copied onto Daily when
 * this client has joined and at least one remote peer is in the call.
 * The event-id window absorbs that duplicate.
 * Laser updates and in-progress stroke previews ride Daily only, and only
 * when a remote peer is present. They are never copied onto Stream.
 * A snapshot request goes out on both transports. The reply prefers Daily
 * when the requester is on Daily, and otherwise uses Stream chunks.
 */

export type BoardEventKind =
  | "board_delta"
  | "laser_update"
  | "stroke_preview"
  | "snapshot_request"
  | "snapshot_response"
  | "clear"
  | "paper_style"
  | "page_count"
  | "history_op"
  | "layer_order";

export type TransportHop = "daily" | "stream";

export type BoardRouteContext = {
  /** Local client has joined a Daily call. */
  dailyJoined: boolean;
  /** Other participants currently in that call. */
  remoteParticipants: number;
  /** Snapshot replies: the peer who asked is on Daily. */
  requesterOnDaily?: boolean;
};

export type BoardDelivery = { daily: boolean; stream: boolean };

/** Both receivers stay armed. A missing call simply has nothing to deliver. */
export const RECEIVER_HOPS = { daily: true, stream: true } as const;

/** Laser is not sent on Stream when Daily is missing. */
export const LASER_STREAM_FALLBACK = "disabled" as const;

const EPHEMERAL = new Set<BoardEventKind>(["laser_update", "stroke_preview"]);

export function classifyBoardPayload(payload: Record<string, unknown>): BoardEventKind {
  const action = payload.action;
  const type = payload.type;
  if (action === "request_snapshot" || type === "request_snapshot") return "snapshot_request";
  if (action === "snapshot_chunk" || action === "snapshot_response" || type === "snapshot_response") {
    return "snapshot_response";
  }
  if (action === "clear") return "clear";
  if (action === "paper_style_change" || action === "paper_style") return "paper_style";
  if (payload.historyOp != null) return "history_op";
  if (typeof payload.pageCount === "number") return "page_count";
  if (payload.layerOrder != null) return "layer_order";
  if (type === "laser_update" || action === "laser_update") return "laser_update";
  if (type === "stroke_preview" || action === "stroke_preview" || payload.strokePreview != null) {
    return "stroke_preview";
  }
  if (payload.add != null || payload.remove != null || type === "board_delta") return "board_delta";
  return "history_op";
}

function hasDailyPeer(ctx: BoardRouteContext): boolean {
  return ctx.dailyJoined && ctx.remoteParticipants > 0;
}

export function planBoardDelivery(payload: Record<string, unknown>, ctx: BoardRouteContext): BoardDelivery {
  const kind = classifyBoardPayload(payload);
  if (EPHEMERAL.has(kind)) return { daily: hasDailyPeer(ctx), stream: false };
  if (kind === "snapshot_request") return { daily: ctx.dailyJoined, stream: true };
  if (kind === "snapshot_response") {
    if (ctx.requesterOnDaily && ctx.dailyJoined) return { daily: true, stream: false };
    return { daily: false, stream: true };
  }
  return { daily: hasDailyPeer(ctx), stream: true };
}
