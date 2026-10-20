import type { Point, RecognizedShape } from "./types";

/** Squared-paper cell size, in CSS pixels. Matches the page grid. */
export const GRID_STEP = 24;

const QUARTER_TURN = Math.PI / 4;

export interface SnappedShapeDraft {
  shape: "line" | "ellipse" | "rectangle" | "triangle";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Present when the snap is not an axis-aligned box. */
  vertices?: Point[];
}

export interface SnapCommitOptions {
  /** Round vertices onto GRID_STEP. Off for blank, ruled, and dotted paper. */
  snapToGrid?: boolean;
  step?: number;
}

/** Grid snap is a property of squared paper, or of an explicit snap flag. */
export function shouldSnapRecognizedToGrid(paperStyle: string): boolean {
  return paperStyle === "grid";
}

/** Round one coordinate pair to the nearest grid intersection. */
export function snapPointToGrid(x: number, y: number, step = GRID_STEP): Point {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(step > 0) || !Number.isFinite(step)) {
    return { x, y };
  }
  return {
    x: Math.round(x / step) * step,
    y: Math.round(y / step) * step,
  };
}

/** Round a radius to the nearest multiple of half a grid cell. */
export function snapRadiusToGrid(radius: number, step = GRID_STEP): number {
  const quantum = step / 2;
  if (!Number.isFinite(radius) || !(quantum > 0) || !Number.isFinite(quantum)) return radius;
  return Math.round(radius / quantum) * quantum;
}

/**
 * Lock a dragged line endpoint to the nearest 45° step while Shift is held.
 * Axis results are exact (90° keeps x unchanged) so the lock does not inherit
 * the residual of cos(π/2).
 */
export function constrainLineEnd(start: Point, end: Point, shiftKey: boolean): Point {
  if (!shiftKey) return { x: end.x, y: end.y };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const radius = Math.hypot(dx, dy);
  if (!(radius > 0) || !Number.isFinite(radius)) return { x: start.x, y: start.y };

  const theta = Math.atan2(dy, dx);
  const steps = Math.round(theta / QUARTER_TURN);
  const octant = ((steps % 8) + 8) % 8;
  const diagonal = radius * Math.SQRT1_2;
  switch (octant) {
    case 0:
      return { x: start.x + radius, y: start.y };
    case 1:
      return { x: start.x + diagonal, y: start.y + diagonal };
    case 2:
      return { x: start.x, y: start.y + radius };
    case 3:
      return { x: start.x - diagonal, y: start.y + diagonal };
    case 4:
      return { x: start.x - radius, y: start.y };
    case 5:
      return { x: start.x - diagonal, y: start.y - diagonal };
    case 6:
      return { x: start.x, y: start.y - radius };
    default:
      return { x: start.x + diagonal, y: start.y - diagonal };
  }
}

export interface AlignRecognizedOptions extends SnapCommitOptions {
  /** Lock a recognized line to 45° before any grid snap. */
  constrainLine?: boolean;
}

/** Apply Shift-lock and optional grid snap to a recognized primitive. */
export function alignRecognizedShape(
  shape: RecognizedShape,
  options: AlignRecognizedOptions = {},
): RecognizedShape {
  const step = options.step ?? GRID_STEP;

  if (shape.type === "line") {
    const end = options.constrainLine ? constrainLineEnd(shape.start, shape.end, true) : shape.end;
    if (!options.snapToGrid) {
      return end === shape.end ? shape : { type: "line", start: shape.start, end };
    }
    return {
      type: "line",
      start: snapPointToGrid(shape.start.x, shape.start.y, step),
      end: snapPointToGrid(end.x, end.y, step),
    };
  }

  if (!options.snapToGrid || shape.type === "freehand") return shape;

  if (shape.type === "circle") {
    return {
      type: "circle",
      center: snapPointToGrid(shape.center.x, shape.center.y, step),
      radius: snapRadiusToGrid(shape.radius, step),
    };
  }

  return {
    type: "polygon",
    vertices: shape.vertices.map((vertex) => snapPointToGrid(vertex.x, vertex.y, step)),
  };
}

function boundsOf(points: readonly Point[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** A rectangle whose edges already sit on the axes can use the box shape. */
function isAxisAlignedRectangle(vertices: readonly Point[]): boolean {
  if (vertices.length !== 4) return false;
  for (let i = 0; i < vertices.length; i++) {
    const next = vertices[(i + 1) % vertices.length];
    const dx = Math.abs(next.x - vertices[i].x);
    const dy = Math.abs(next.y - vertices[i].y);
    if (dx > 1.5 && dy > 1.5) return false;
  }
  return true;
}

/** Map a recognized primitive onto the whiteboard display-list shape. */
export function draftFromRecognized(
  shape: RecognizedShape,
  options?: SnapCommitOptions,
): SnappedShapeDraft | null {
  const aligned = options?.snapToGrid ? alignRecognizedShape(shape, options) : shape;
  if (aligned.type === "freehand") return null;

  if (aligned.type === "line") {
    return {
      shape: "line",
      x: aligned.start.x,
      y: aligned.start.y,
      w: aligned.end.x - aligned.start.x,
      h: aligned.end.y - aligned.start.y,
    };
  }

  if (aligned.type === "circle") {
    if (!(aligned.radius > 0)) return null;
    return {
      shape: "ellipse",
      x: aligned.center.x - aligned.radius,
      y: aligned.center.y - aligned.radius,
      w: aligned.radius * 2,
      h: aligned.radius * 2,
    };
  }

  if (aligned.vertices.length < 3) return null;
  const box = boundsOf(aligned.vertices);
  if (isAxisAlignedRectangle(aligned.vertices)) {
    return { shape: "rectangle", ...box };
  }
  return {
    shape: aligned.vertices.length === 3 ? "triangle" : "rectangle",
    ...box,
    vertices: aligned.vertices.map((vertex) => ({ x: vertex.x, y: vertex.y })),
  };
}
