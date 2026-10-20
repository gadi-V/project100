/**
 * Pen-gesture session for the classroom whiteboard.
 * Samples stay in a Float32Array. A dwell timer arms the live snap preview
 * and is reset whenever the pointer travels more than 5px.
 */

import { DWELL_MAX_TRAVEL_PX, DWELL_MS, recognizeShape } from "./shape-engine";
import { SAMPLE_STRIDE, type RecognizedShape } from "./types";

const INITIAL_SAMPLES = 128;

export class SnapSession {
  private buf = new Float32Array(INITIAL_SAMPLES * SAMPLE_STRIDE);
  private count = 0;
  private anchorX = 0;
  private anchorY = 0;
  private anchorTime = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private preview: RecognizedShape | null = null;
  private disposed = false;

  constructor(private readonly onChange: (preview: RecognizedShape | null) => void) {}

  begin(x: number, y: number, time: number): void {
    this.disposed = false;
    this.count = 0;
    this.preview = null;
    this.push(x, y, time);
    this.resetDwell(x, y, time);
  }

  /**
   * Append a sample. Movement greater than 5px from the dwell anchor,
   * or a single step greater than 5px, restarts the 450ms timer.
   */
  move(x: number, y: number, time: number): void {
    if (this.disposed || this.count === 0) return;
    const prev = (this.count - 1) * SAMPLE_STRIDE;
    const step = Math.hypot(x - this.buf[prev], y - this.buf[prev + 1]);
    const fromAnchor = Math.hypot(x - this.anchorX, y - this.anchorY);
    this.push(x, y, time);
    if (step > DWELL_MAX_TRAVEL_PX || fromAnchor > DWELL_MAX_TRAVEL_PX) {
      if (this.preview) {
        this.preview = null;
        this.onChange(null);
      }
      this.resetDwell(x, y, time);
    }
  }

  /** Commit the current stroke. A release before the dwell stays freehand. */
  finish(time: number): RecognizedShape {
    this.clearTimer();
    const shape = this.count === 0 ? { type: "freehand" as const, points: [] } : this.evaluate(time);
    this.preview = null;
    this.count = 0;
    return shape;
  }

  /** Drop the dwell timer. Safe to call from a React effect cleanup. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.preview = null;
    this.count = 0;
  }

  private resetDwell(x: number, y: number, time: number): void {
    this.anchorX = x;
    this.anchorY = y;
    this.anchorTime = time;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed) return;
      const shape = this.evaluate(this.anchorTime + DWELL_MS);
      if (shape.type === "freehand") return;
      this.preview = shape;
      this.onChange(shape);
    }, DWELL_MS);
  }

  private evaluate(now: number): RecognizedShape {
    const n = this.count;
    if (n === 0) return { type: "freehand", points: [] };
    const lastT = this.buf[(n - 1) * SAMPLE_STRIDE + 2];
    const addHold = now > lastT;
    const packed = new Float32Array((n + (addHold ? 1 : 0)) * SAMPLE_STRIDE);
    packed.set(this.buf.subarray(0, n * SAMPLE_STRIDE));
    if (addHold) {
      const offset = n * SAMPLE_STRIDE;
      const prev = (n - 1) * SAMPLE_STRIDE;
      packed[offset] = this.buf[prev];
      packed[offset + 1] = this.buf[prev + 1];
      packed[offset + 2] = now;
    }
    return recognizeShape(packed);
  }

  private push(x: number, y: number, time: number): void {
    this.ensure(1);
    const offset = this.count * SAMPLE_STRIDE;
    this.buf[offset] = x;
    this.buf[offset + 1] = y;
    this.buf[offset + 2] = time;
    this.count += 1;
  }

  private ensure(extra: number): void {
    const need = (this.count + extra) * SAMPLE_STRIDE;
    if (need <= this.buf.length) return;
    let nextLen = this.buf.length;
    while (nextLen < need) nextLen *= 2;
    const next = new Float32Array(nextLen);
    next.set(this.buf);
    this.buf = next;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
