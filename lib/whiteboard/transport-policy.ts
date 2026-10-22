/**
 * Where a board event is allowed to travel.
 *
 * Hot path (`board_delta`, `laser_update`) uses Daily while the call is joined.
 * The same event is never copied onto Stream at the same time.
 * Durable events stay on Stream. If Daily is missing, failed, or ended,
 * `board_delta` falls back to Stream instead of being dropped.
 * Laser is not sent on that fallback — Stream is not a pointer channel.
 */

export type BoardEventKind =
  | "board_delta"
  | "laser_update"
  | "snapshot_request"
  | "snapshot_response"
  | "clear"
  | "paper_style"
  | "page_count"
  | "history_op"
  | "layer_order";

export type TransportHop = "daily" | "stream";

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
  if (type === "laser_update") return "laser_update";
  if (payload.add != null || payload.remove != null || type === "board_delta") return "board_delta";
  return "history_op";
}

/** `null` means the event is intentionally not sent. Laser is disabled when Daily is offline. */
export const LASER_STREAM_FALLBACK = "disabled" as const;

export function selectTransport(kind: BoardEventKind, dailyActive: boolean): TransportHop | null {
  if (kind === "laser_update") return dailyActive ? "daily" : null;
  if (kind === "board_delta") return dailyActive ? "daily" : "stream";
  return "stream";
}

export function planBoardDelivery(
  payload: Record<string, unknown>,
  dailyActive: boolean,
): { daily: boolean; stream: boolean } {
  const hop = selectTransport(classifyBoardPayload(payload), dailyActive);
  return { daily: hop === "daily", stream: hop === "stream" };
}
