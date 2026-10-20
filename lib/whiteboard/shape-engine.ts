/**
 * GoodNotes-style geometric recognition.
 * Pure analytic TypeScript: no canvas libraries, no per-frame point allocations
 * on the dwell check. Sample history may be a packed Float32Array (stride 3).
 */

import {
  SAMPLE_STRIDE,
  type Point,
  type RawPoint,
  type RecognizedShape,
  type SampleSource,
} from "./types";

/** Travel across the last window must stay under this to count as a dwell. */
export const DWELL_MAX_TRAVEL_PX = 5;
/** Stillness window that arms shape snapping. */
export const DWELL_MS = 450;
/** Mean perpendicular distance to the regression line, strictly below this snaps a line. */
export const LINE_EPSILON_PX = 3.5;
/** Endpoint gap at or under this closes the stroke. */
export const CLOSE_DISTANCE_PX = 15;
/** Isoperimetric quotient at or above this snaps a closed stroke to a circle. */
export const CIRCULARITY_MIN = 0.82;
/** Inclusive corner-angle band that is forced to 90°. */
export const ORTHOGONAL_MIN_DEG = 82;
export const ORTHOGONAL_MAX_DEG = 98;

const RESAMPLE_SPACING_PX = 4;
const CORNER_LOOK_PX = 18;
const CORNER_MIN_ANGLE_DEG = 42;
const CORNER_MIN_SEPARATION_PX = 20;

function sampleCount(samples: SampleSource): number {
  return samples instanceof Float32Array
    ? Math.floor(samples.length / SAMPLE_STRIDE)
    : samples.length;
}

function readX(samples: SampleSource, index: number): number {
  return samples instanceof Float32Array
    ? samples[index * SAMPLE_STRIDE]
    : samples[index].x;
}

function readY(samples: SampleSource, index: number): number {
  return samples instanceof Float32Array
    ? samples[index * SAMPLE_STRIDE + 1]
    : samples[index].y;
}

function readT(samples: SampleSource, index: number): number {
  return samples instanceof Float32Array
    ? samples[index * SAMPLE_STRIDE + 2]
    : samples[index].time;
}

/**
 * True when a suffix lasting at least 450ms has path length strictly under 5px.
 * Walks the source in place and allocates nothing.
 */
export function isDwellGesture(samples: SampleSource): boolean {
  const n = sampleCount(samples);
  if (n < 2) return false;
  const tLast = readT(samples, n - 1);
  let path = 0;
  for (let i = n - 2; i >= 0; i--) {
    const step = Math.hypot(
      readX(samples, i + 1) - readX(samples, i),
      readY(samples, i + 1) - readY(samples, i)
    );
    if (path + step >= DWELL_MAX_TRAVEL_PX) return false;
    path += step;
    if (tLast - readT(samples, i) >= DWELL_MS) return true;
  }
  return false;
}

/**
 * Last ink sample. The pause is the suffix after `tLast - 450ms`; those
 * samples are not part of the fit, so a still tail cannot change the regression.
 */
function inkEndIndex(times: Float64Array, n: number): number {
  const tCut = times[n - 1] - DWELL_MS;
  let end = -1;
  for (let i = 0; i < n; i++) {
    if (times[i] <= tCut) end = i;
    else break;
  }
  return end < 0 ? 0 : end;
}

/** Mean orthogonal distance from the principal-axis line. */
export function meanPerpendicularDistance(points: readonly Point[]): number {
  const n = points.length;
  if (n === 0) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += points[i].x;
    my += points[i].y;
  }
  mx /= n;
  my /= n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = points[i].x - mx;
    const dy = points[i].y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const dx = points[i].x - mx;
    const dy = points[i].y - my;
    sum += Math.abs(-uy * dx + ux * dy);
  }
  return sum / n;
}

/** Absolute shoelace area of a closed ring. The closing edge is implied. */
export function shoelaceArea(points: readonly Point[]): number {
  return Math.abs(signedArea(points));
}

function signedArea(points: readonly Point[]): number {
  const n = points.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return sum * 0.5;
}

/** Sum of Euclidean segment lengths. When `closed`, the ring returns to the first point. */
export function euclideanPerimeter(points: readonly Point[], closed = false): number {
  const n = points.length;
  if (n < 2) return 0;
  let length = 0;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % n;
    length += Math.hypot(points[j].x - points[i].x, points[j].y - points[i].y);
  }
  return length;
}

/** Q = 4πA / L² for the closed ring. Zero when the perimeter vanishes. */
export function circularityQuotient(points: readonly Point[]): number {
  const perimeter = euclideanPerimeter(points, true);
  if (perimeter <= 0) return 0;
  const area = shoelaceArea(points);
  return (4 * Math.PI * area) / (perimeter * perimeter);
}

/** Center of mass of the polygonal lamina. Falls back to the vertex average if the area is ~0. */
export function polygonCentroid(points: readonly Point[]): Point {
  const n = points.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n === 1) return { x: points[0].x, y: points[0].y };

  let crossSum = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = points[i].x * points[j].y - points[j].x * points[i].y;
    crossSum += cross;
    cx += (points[i].x + points[j].x) * cross;
    cy += (points[i].y + points[j].y) * cross;
  }
  const area = crossSum * 0.5;
  if (Math.abs(area) < 1e-8) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += points[i].x;
      sy += points[i].y;
    }
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

export function endpointGap(points: readonly Point[]): number {
  const n = points.length;
  if (n < 2) return Number.POSITIVE_INFINITY;
  return Math.hypot(points[n - 1].x - points[0].x, points[n - 1].y - points[0].y);
}

/** Angle in degrees between two direction vectors, in [0, 180]. */
export function directionAngleDeg(ix: number, iy: number, ox: number, oy: number): number {
  const il = Math.hypot(ix, iy);
  const ol = Math.hypot(ox, oy);
  if (il < 1e-9 || ol < 1e-9) return Number.NaN;
  const cos = (ix * ox + iy * oy) / (il * ol);
  const clamped = cos < -1 ? -1 : cos > 1 ? 1 : cos;
  return (Math.acos(clamped) * 180) / Math.PI;
}

function isOrthogonalAngle(degrees: number): boolean {
  return degrees >= ORTHOGONAL_MIN_DEG && degrees <= ORTHOGONAL_MAX_DEG;
}

function cornerAngleAt(vertices: readonly Point[], index: number): number {
  const n = vertices.length;
  const prev = vertices[(index - 1 + n) % n];
  const cur = vertices[index];
  const next = vertices[(index + 1) % n];
  return directionAngleDeg(cur.x - prev.x, cur.y - prev.y, next.x - cur.x, next.y - cur.y);
}

/**
 * Corners whose direction-vector angle lies in [82°, 98°] are rebuilt at exactly 90°.
 * A quadrilateral whose corners all fall in that band becomes a true rectangle
 * (opposite sides averaged, axes taken from the stroke).
 */
export function snapOrthogonalPolygon(vertices: readonly Point[]): Point[] {
  const n = vertices.length;
  if (n < 3) return vertices.map((vertex) => ({ x: vertex.x, y: vertex.y }));

  const orthogonal = new Array<boolean>(n);
  let orthogonalCount = 0;
  for (let i = 0; i < n; i++) {
    const angle = cornerAngleAt(vertices, i);
    orthogonal[i] = Number.isFinite(angle) && isOrthogonalAngle(angle);
    if (orthogonal[i]) orthogonalCount += 1;
  }

  if (n === 4 && orthogonalCount === 4) return rectangleFromQuad(vertices);

  const out = vertices.map((vertex) => ({ x: vertex.x, y: vertex.y }));
  for (let i = 0; i < n; i++) {
    if (!orthogonal[i]) continue;
    const prev = out[(i - 1 + n) % n];
    const cur = out[i];
    const next = out[(i + 1) % n];
    const ix = cur.x - prev.x;
    const iy = cur.y - prev.y;
    const il = Math.hypot(ix, iy);
    const ol = Math.hypot(next.x - cur.x, next.y - cur.y);
    if (il < 1e-9 || ol < 1e-9) continue;
    const cross = ix * (next.y - cur.y) - iy * (next.x - cur.x);
    const px = cross >= 0 ? -iy / il : iy / il;
    const py = cross >= 0 ? ix / il : -ix / il;
    next.x = cur.x + px * ol;
    next.y = cur.y + py * ol;
  }
  return out;
}

function rectangleFromQuad(vertices: readonly Point[]): Point[] {
  const v0 = vertices[0];
  const v1 = vertices[1];
  const v2 = vertices[2];
  const v3 = vertices[3];
  const cx = (v0.x + v1.x + v2.x + v3.x) / 4;
  const cy = (v0.y + v1.y + v2.y + v3.y) / 4;

  let ax = v1.x - v0.x + (v2.x - v3.x);
  let ay = v1.y - v0.y + (v2.y - v3.y);
  let alen = Math.hypot(ax, ay);
  if (alen < 1e-9) {
    ax = 1;
    ay = 0;
    alen = 1;
  }
  const ux = ax / alen;
  const uy = ay / alen;

  const e0x = v1.x - v0.x;
  const e0y = v1.y - v0.y;
  const e1x = v2.x - v1.x;
  const e1y = v2.y - v1.y;
  const cross = e0x * e1y - e0y * e1x;
  const px = cross >= 0 ? -uy : uy;
  const py = cross >= 0 ? ux : -ux;

  const width = (Math.hypot(e0x, e0y) + Math.hypot(v2.x - v3.x, v2.y - v3.y)) / 2;
  const height = (Math.hypot(e1x, e1y) + Math.hypot(v0.x - v3.x, v0.y - v3.y)) / 2;
  const hw = width / 2;
  const hh = height / 2;

  return [
    { x: cx - hw * ux - hh * px, y: cy - hw * uy - hh * py },
    { x: cx + hw * ux - hh * px, y: cy + hw * uy - hh * py },
    { x: cx + hw * ux + hh * px, y: cy + hw * uy + hh * py },
    { x: cx - hw * ux + hh * px, y: cy - hw * uy + hh * py },
  ];
}

function resampleClosed(
  xs: Float64Array,
  ys: Float64Array,
  n: number,
  spacing: number
): { xs: Float32Array; ys: Float32Array; count: number } | null {
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cum[i + 1] = cum[i] + Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
  }
  const total = cum[n];
  if (total < CORNER_MIN_SEPARATION_PX * 3) return null;

  const count = Math.max(12, Math.round(total / spacing));
  const step = total / count;
  const ox = new Float32Array(count);
  const oy = new Float32Array(count);
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const dist = k * step;
    while (seg < n - 1 && cum[seg + 1] < dist) seg += 1;
    const span = cum[seg + 1] - cum[seg];
    const t = span > 1e-9 ? (dist - cum[seg]) / span : 0;
    const j = (seg + 1) % n;
    ox[k] = xs[seg] + (xs[j] - xs[seg]) * t;
    oy[k] = ys[seg] + (ys[j] - ys[seg]) * t;
  }
  return { xs: ox, ys: oy, count };
}

function circularIndexDistance(a: number, b: number, count: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, count - raw);
}

function detectCorners(points: readonly Point[]): Point[] {
  const n = points.length;
  if (n < 3) return [];
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i].x;
    ys[i] = points[i].y;
  }
  const resampled = resampleClosed(xs, ys, n, RESAMPLE_SPACING_PX);
  if (!resampled) return [];

  const m = resampled.count;
  const look = Math.max(1, Math.round(CORNER_LOOK_PX / RESAMPLE_SPACING_PX));
  const minSep = Math.max(look, Math.round(CORNER_MIN_SEPARATION_PX / RESAMPLE_SPACING_PX));
  const angles = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const a = (i - look + m) % m;
    const b = (i + look) % m;
    const angle = directionAngleDeg(
      resampled.xs[i] - resampled.xs[a],
      resampled.ys[i] - resampled.ys[a],
      resampled.xs[b] - resampled.xs[i],
      resampled.ys[b] - resampled.ys[i]
    );
    angles[i] = Number.isFinite(angle) ? angle : 0;
  }

  const picked: number[] = [];
  for (let i = 0; i < m; i++) {
    if (angles[i] < CORNER_MIN_ANGLE_DEG) continue;
    let localMax = true;
    for (let d = 1; d <= look; d++) {
      const ahead = angles[(i + d) % m];
      const behind = angles[(i - d + m) % m];
      if (ahead > angles[i] || behind > angles[i]) {
        localMax = false;
        break;
      }
    }
    if (!localMax) continue;
    const previous = picked.length > 0 ? picked[picked.length - 1] : -1;
    if (previous >= 0 && circularIndexDistance(previous, i, m) < minSep) {
      if (angles[i] > angles[previous]) picked[picked.length - 1] = i;
      continue;
    }
    picked.push(i);
  }

  if (picked.length >= 2) {
    const first = picked[0];
    const last = picked[picked.length - 1];
    if (first + (m - last) < minSep) {
      if (angles[last] > angles[first]) picked[0] = last;
      picked.pop();
    }
  }

  return picked.map((index) => ({ x: resampled.xs[index], y: resampled.ys[index] }));
}

function materialize(samples: SampleSource): RawPoint[] {
  const n = sampleCount(samples);
  const points: RawPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    points[i] = { x: readX(samples, i), y: readY(samples, i), time: readT(samples, i) };
  }
  return points;
}

function freehand(samples: SampleSource): RecognizedShape {
  return { type: "freehand", points: materialize(samples) };
}

function loadBuffers(samples: SampleSource): {
  xs: Float64Array;
  ys: Float64Array;
  times: Float64Array;
  n: number;
} | null {
  const n = sampleCount(samples);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = readX(samples, i);
    const y = readY(samples, i);
    const time = readT(samples, i);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(time)) return null;
    xs[i] = x;
    ys[i] = y;
    times[i] = time;
  }
  return { xs, ys, times, n };
}

function pointsUntil(xs: Float64Array, ys: Float64Array, end: number): Point[] {
  const points: Point[] = new Array(end + 1);
  for (let i = 0; i <= end; i++) points[i] = { x: xs[i], y: ys[i] };
  return points;
}

/**
 * Classify a finished stroke.
 * Snapping runs only after a dwell. The still tail is excluded from the fit,
 * so a hold at the end does not bend the line, circle, or polygon.
 */
export function recognizeShape(samples: SampleSource): RecognizedShape {
  const loaded = loadBuffers(samples);
  if (!loaded || loaded.n < 2) return freehand(samples);

  if (!isDwellGesture(samples)) return freehand(samples);

  const { xs, ys, times, n } = loaded;
  const end = inkEndIndex(times, n);
  if (end < 1) return freehand(samples);

  const active = pointsUntil(xs, ys, end);
  const closed = endpointGap(active) <= CLOSE_DISTANCE_PX;

  if (closed && active.length >= 3) {
    const quotient = circularityQuotient(active);
    if (quotient >= CIRCULARITY_MIN && shoelaceArea(active) > 0) {
      const perimeter = euclideanPerimeter(active, true);
      return {
        type: "circle",
        center: polygonCentroid(active),
        radius: perimeter / (2 * Math.PI),
      };
    }

    const corners = detectCorners(active);
    if (corners.length >= 3) {
      return { type: "polygon", vertices: snapOrthogonalPolygon(corners) };
    }
  }

  if (!closed && meanPerpendicularDistance(active) < LINE_EPSILON_PX) {
    const first = active[0];
    const last = active[active.length - 1];
    return {
      type: "line",
      start: { x: first.x, y: first.y },
      end: { x: last.x, y: last.y },
    };
  }

  return freehand(samples);
}
