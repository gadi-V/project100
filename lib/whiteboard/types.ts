/**
 * Sample and recognition types for the whiteboard geometry engine.
 * Coordinates are canvas CSS pixels. `time` is a monotonic clock in milliseconds.
 */

export interface Point {
  x: number;
  y: number;
}

export interface RawPoint {
  x: number;
  y: number;
  time: number;
}

/**
 * Packed pointer history for the 60fps sample loop.
 * Layout is `[x, y, time, x, y, time, ...]`.
 */
export const SAMPLE_STRIDE = 3;

export type SampleSource = readonly RawPoint[] | Float32Array;

export type RecognizedShape =
  | { type: "freehand"; points: RawPoint[] }
  | { type: "line"; start: Point; end: Point }
  | { type: "circle"; center: Point; radius: number }
  | { type: "polygon"; vertices: Point[] };
