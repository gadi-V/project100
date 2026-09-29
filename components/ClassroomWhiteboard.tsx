"use client";

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import Draggable from "react-draggable";
import { nanoid } from "nanoid";
import type { Channel } from "stream-chat";

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_W = 794;
const PAGE_H = 1123;
const PAGE_GAP = 32;
const DESK_BG = "#f5f5f4";
const HANDLE_R = 6;
const ROT_HANDLE_OFFSET = 32;
const BOARD_EVENT = "board_sync";
const STREAM_LIMIT = 4000;
const PROTO_V = 6;
const LASER_FADE_MS = 1000;
const PASTE_OFFSET = 24;
const DUPLICATE_OFFSET = 20;
const ERASER_SIZE_PRESETS = [
  { diameter: 4, label: "עדין", title: "Micro · 4px" },
  { diameter: 10, label: "קטן", title: "Small · 10px" },
  { diameter: 22, label: "בינוני", title: "Medium · 22px" },
  { diameter: 45, label: "גדול", title: "Large · 45px" },
] as const;
const FONT_SIZE_PRESETS = [14, 18, 24, 32, 48] as const;
const DEFAULT_TEXT_W = 240;
const MIN_LASSO_DIST = 4;
// Fixed metrics shared by the textarea overlay and the canvas renderer so the
// committed text lands pixel-for-pixel where it was typed.
const TEXT_LINE_HEIGHT = 1.35;
const TEXT_FONT_FAMILY = "system-ui, -apple-system, sans-serif";
const TEXT_PADDING = 8;

const PALETTE = [
  { label: "שחור", hex: "#0f172a" },
  { label: "כחול", hex: "#1d4ed8" },
  { label: "אדום", hex: "#dc2626" },
  { label: "ירוק", hex: "#15803d" },
  { label: "צהוב", hex: "#fbbf24" },
] as const;

function mmToPx(mm: number): number {
  return Math.round(mm * 3.7795);
}

const WIDTH_PRESETS = [
  { mm: 0.3, label: "0.3mm" },
  { mm: 0.6, label: "0.6mm" },
  { mm: 1.2, label: "1.2mm" },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type DrawTool =
  | "selection"
  | "pen"
  | "highlighter"
  | "eraser"
  | "shapes"
  | "text"
  | "image"
  | "laser";
type ShapeKind = "rectangle" | "ellipse" | "triangle" | "line" | "arrow";
type StrokeStyle = "solid" | "dashed" | "dotted";
type EraserMode = "stroke" | "pixel";
type LassoStyle = "rect" | "free";
type TextAlign = "right" | "center" | "left";

interface EditTextSession {
  pageIndex: number;
  x: number;
  y: number;
  text: string;
  id?: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  color: string;
  w: number;
}
type Point = { readonly x: number; readonly y: number };
type Bounds = { x: number; y: number; w: number; h: number };
type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type TextWidthSide = "left" | "right";

interface ImageCrop {
  sx: number;
  sy: number;
  sWidth: number;
  sHeight: number;
}

interface StrokeEl {
  kind: "stroke";
  id: string;
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  opacity: number;
  strokeStyle: StrokeStyle;
  points: Point[];
  pageIndex: number;
}

interface ShapeEl {
  kind: "shape";
  id: string;
  shape: ShapeKind;
  color: string;
  width: number;
  strokeStyle: StrokeStyle;
  x: number;
  y: number;
  w: number;
  h: number;
  pageIndex: number;
}

interface TextEl {
  kind: "text";
  id: string;
  text: string;
  color: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  w: number;
  x: number;
  y: number;
  pageIndex: number;
}

interface ImageEl {
  kind: "image";
  id: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  crop: ImageCrop | null;
  pageIndex: number;
}

type DrawEl = StrokeEl | ShapeEl | TextEl | ImageEl;

interface HistoryUpdate {
  id: string;
  before: DrawEl;
  after: DrawEl;
}

interface HistoryOp {
  id: string;
  removed: DrawEl[];
  added: DrawEl[];
  updated: HistoryUpdate[];
}

interface ActivePen {
  kind: "pen";
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  opacity: number;
  strokeStyle: StrokeStyle;
  points: Point[];
  pageIndex: number;
}

interface ActiveShape {
  kind: "shape";
  shape: ShapeKind;
  color: string;
  width: number;
  strokeStyle: StrokeStyle;
  start: Point;
  end: Point;
  pageIndex: number;
}

type ActiveDrawing = ActivePen | ActiveShape | null;

type SelectionMode = "idle" | "marquee" | "lasso" | "move" | "resize" | "rotate" | "text-width";

interface SelectionState {
  mode: SelectionMode;
  pageIndex: number;
  start: Point;
  current: Point;
  lassoPoints: Point[];
  handle: ResizeHandle | null;
  widthSide: TextWidthSide | null;
  snapshot: DrawEl[];
  groupBounds: Bounds | null;
  initialRotation: number;
  rotateCenter: Point | null;
}

interface CropState {
  imageId: string;
  pageIndex: number;
  frame: Bounds;
}

interface SyncStroke {
  kind: "stroke";
  id: string;
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  opacity: number;
  strokeStyle: StrokeStyle;
  pts: number[];
  pageIndex: number;
}

interface SyncShape extends Omit<ShapeEl, "kind"> {
  kind: "shape";
}

interface SyncText extends Omit<TextEl, "kind"> {
  kind: "text";
}

interface SyncImage {
  kind: "image";
  id: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  crop: ImageCrop | null;
  pageIndex: number;
}

type SyncEl = SyncStroke | SyncShape | SyncText | SyncImage;

interface SyncEvent {
  type?: string;
  v?: number;
  add?: unknown;
  remove?: unknown;
  pageCount?: unknown;
  historyOp?: HistoryOp;
  direction?: "forward" | "backward";
  layerOrder?: { pageIndex: number; ids: string[] };
}

interface PageInfo {
  id: string;
  pageNumber: number;
}

export type ClassroomWhiteboardRef = {
  /** Export all board pages to a PDF.
   *  - With `lessonId`: uploads to storage and returns the public/signed URL (or null on failure).
   *  - Without `lessonId`: returns the raw PDF Blob (legacy download mode).
   */
  exportBoardToPdf: (lessonId?: string) => Promise<Blob | string | null>;
  exportBoardToPng: (pageIndex?: number) => Promise<void>;
};

type BoardRole = "STUDENT" | "TEACHER" | "ADMIN" | "MANAGER";

type ClassroomWhiteboardProps = {
  role: BoardRole;
  streamChannel?: Channel | null;
  /** When set, load PreLessonAsset items for insert-to-canvas. */
  packageId?: string | null;
  lessonId?: string | null;
};

type PreLessonAssetPanelItem = {
  id: string;
  assetType: "IMAGE" | "PDF" | "TEXT_NOTE" | string;
  assetUrl: string | null;
  textContent: string | null;
  lessonId: string | null;
  createdAt: string;
};

type ExportFrame = {
  pageNumber: number;
  width: number;
  height: number;
  dataUrl: string;
};

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function pointInPolygon(pt: Point, polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
}

function rdpSimplify(pts: readonly Point[], eps: number): Point[] {
  if (pts.length <= 2) return [...pts];
  let maxD = 0;
  let maxI = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD > eps) {
    const L = rdpSimplify(pts.slice(0, maxI + 1), eps);
    const R = rdpSimplify(pts.slice(maxI), eps);
    return [...L.slice(0, -1), ...R];
  }
  return [pts[0], pts[pts.length - 1]];
}

function toSyncPts(pts: readonly Point[]): number[] {
  return rdpSimplify(pts, 1.5).flatMap((p) => [
    Math.round(p.x * 10) / 10,
    Math.round(p.y * 10) / 10,
  ]);
}

function fromSyncPts(raw: number[]): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pts.push({ x: raw[i], y: raw[i + 1] });
  return pts;
}

function textLineHeight(fontSize: number): number {
  return fontSize * TEXT_LINE_HEIGHT;
}

let measureCanvas: HTMLCanvasElement | null = null;

function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) throw new Error("measure ctx unavailable");
  return ctx;
}

function textFontString(el: Pick<TextEl, "fontSize" | "bold" | "italic">): string {
  const weight = el.bold ? "bold" : "normal";
  const style = el.italic ? "italic" : "normal";
  return `${style} ${weight} ${el.fontSize}px ${TEXT_FONT_FAMILY}`;
}

function wrapTextContent(text: string, maxWidth: number, font: string): string[] {
  const ctx = getMeasureCtx();
  ctx.font = font;
  const paragraphs = text.split("\n");
  const lines: string[] = [];
  for (const para of paragraphs) {
    if (para === "") {
      lines.push("");
      continue;
    }
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}

function getWrappedTextLines(el: TextEl): string[] {
  // `el.w` is the border-box width; the drawable content area is inset by the
  // padding on both sides, matching the textarea's box-sizing: border-box.
  const contentWidth = Math.max(1, el.w - TEXT_PADDING * 2);
  return wrapTextContent(el.text, contentWidth, textFontString(el));
}

function textElBounds(el: TextEl): Bounds {
  const lines = getWrappedTextLines(el);
  const lh = textLineHeight(el.fontSize);
  return {
    x: el.x,
    y: el.y,
    w: el.w,
    h: Math.max(lines.length, 1) * lh + TEXT_PADDING * 2,
  };
}

function normalizeTextEl(raw: Partial<TextEl> & Pick<TextEl, "kind" | "id" | "text" | "x" | "y" | "pageIndex">): TextEl {
  return {
    kind: "text",
    id: raw.id,
    text: raw.text,
    color: raw.color ?? "#0f172a",
    fontSize: raw.fontSize ?? 24,
    bold: raw.bold ?? false,
    italic: raw.italic ?? false,
    align: raw.align ?? "right",
    w: raw.w ?? DEFAULT_TEXT_W,
    x: raw.x,
    y: raw.y,
    pageIndex: raw.pageIndex,
  };
}

function elBounds(el: DrawEl): Bounds | null {
  if (el.kind === "stroke") {
    if (el.points.length === 0) return null;
    const xs = el.points.map((p) => p.x);
    const ys = el.points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (el.kind === "shape")
    return {
      x: Math.min(el.x, el.x + el.w),
      y: Math.min(el.y, el.y + el.h),
      w: Math.abs(el.w),
      h: Math.abs(el.h),
    };
  if (el.kind === "text") return textElBounds(el);
  if (el.kind === "image") return { x: el.x, y: el.y, w: el.w, h: el.h };
  return null;
}

function ptInBounds(p: Point, b: Bounds): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function unionBounds(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  const x2 = Math.max(...list.map((b) => b.x + b.w));
  const y2 = Math.max(...list.map((b) => b.y + b.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

function groupBoundsFor(
  elements: readonly DrawEl[],
  ids: ReadonlySet<string>,
): Bounds | null {
  const bounds = elements
    .filter((el) => ids.has(el.id))
    .map((el) => elBounds(el))
    .filter((b): b is Bounds => b !== null);
  return unionBounds(bounds);
}

function handlePositions(b: Bounds): { handle: ResizeHandle; x: number; y: number }[] {
  const { x, y, w, h } = b;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return [
    { handle: "nw", x, y },
    { handle: "n", x: cx, y },
    { handle: "ne", x: x + w, y },
    { handle: "e", x: x + w, y: cy },
    { handle: "se", x: x + w, y: y + h },
    { handle: "s", x: cx, y: y + h },
    { handle: "sw", x, y: y + h },
    { handle: "w", x, y: cy },
  ];
}

function hitHandle(pt: Point, b: Bounds): ResizeHandle | null {
  for (const { handle, x, y } of handlePositions(b)) {
    if (Math.hypot(pt.x - x, pt.y - y) <= HANDLE_R + 4) return handle;
  }
  return null;
}

function textPillHandlePositions(b: Bounds): { side: TextWidthSide; x: number; y: number }[] {
  const cy = b.y + b.h / 2;
  return [
    { side: "left", x: b.x, y: cy },
    { side: "right", x: b.x + b.w, y: cy },
  ];
}

function hitTextPillHandle(pt: Point, b: Bounds): TextWidthSide | null {
  for (const { side, x, y } of textPillHandlePositions(b)) {
    if (Math.abs(pt.x - x) <= 10 && Math.abs(pt.y - y) <= 16) return side;
  }
  return null;
}

function recolorElement(el: DrawEl, color: string): DrawEl | null {
  if (el.kind === "stroke" || el.kind === "shape" || el.kind === "text") return { ...el, color };
  return null;
}

function cleanUpStroke(stroke: StrokeEl): ShapeEl | null {
  if (stroke.points.length < 2) return null;
  const pts = rdpSimplify(stroke.points, 2.5);
  if (pts.length < 2) return null;

  const a = pts[0];
  const b = pts[pts.length - 1];
  let maxLineDist = 0;
  for (const p of pts) maxLineDist = Math.max(maxLineDist, perpDist(p, a, b));
  const lineLen = Math.hypot(b.x - a.x, b.y - a.y);

  if (lineLen >= 12 && maxLineDist <= Math.max(stroke.width * 2.2, 6)) {
    return {
      kind: "shape",
      id: stroke.id,
      shape: "line",
      color: stroke.color,
      width: stroke.width,
      strokeStyle: stroke.strokeStyle,
      x: a.x,
      y: a.y,
      w: b.x - a.x,
      h: b.y - a.y,
      pageIndex: stroke.pageIndex,
    };
  }

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rw = maxX - minX;
  const bh = maxY - minY;
  if (rw < 12 || bh < 12) return null;

  const tol = Math.max(stroke.width * 2.5, 8);
  let edgeHits = 0;
  for (const p of pts) {
    const onEdge =
      Math.abs(p.x - minX) <= tol ||
      Math.abs(p.x - maxX) <= tol ||
      Math.abs(p.y - minY) <= tol ||
      Math.abs(p.y - maxY) <= tol;
    if (onEdge) edgeHits++;
  }
  if (edgeHits / pts.length >= 0.65) {
    const closed =
      Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= tol * 2;
    return {
      kind: "shape",
      id: stroke.id,
      shape: closed ? "rectangle" : "line",
      color: stroke.color,
      width: stroke.width,
      strokeStyle: stroke.strokeStyle,
      x: minX,
      y: minY,
      w: closed ? rw : b.x - a.x,
      h: closed ? bh : b.y - a.y,
      pageIndex: stroke.pageIndex,
    };
  }

  if (rw > 0 && bh > 0) {
    const aspect = rw / bh;
    if (aspect > 0.55 && aspect < 1.8 && pts.length >= 8) {
      return {
        kind: "shape",
        id: stroke.id,
        shape: "ellipse",
        color: stroke.color,
        width: stroke.width,
        strokeStyle: stroke.strokeStyle,
        x: minX,
        y: minY,
        w: rw,
        h: bh,
        pageIndex: stroke.pageIndex,
      };
    }
  }

  return null;
}

function applyPageLayerOrder(
  elements: readonly DrawEl[],
  pageIndex: number,
  orderedIds: string[],
): DrawEl[] {
  const other = elements.filter((e) => e.pageIndex !== pageIndex);
  const pageEls = elements.filter((e) => e.pageIndex === pageIndex);
  const byId = new Map(pageEls.map((e) => [e.id, e]));
  const ordered = orderedIds
    .map((id) => byId.get(id))
    .filter((e): e is DrawEl => e !== undefined);
  const tail = pageEls.filter((e) => !orderedIds.includes(e.id));
  return [...other, ...tail, ...ordered];
}

function bringIdsToFront(elements: readonly DrawEl[], ids: ReadonlySet<string>): DrawEl[] {
  const pages = new Set(
    elements.filter((e) => ids.has(e.id)).map((e) => e.pageIndex),
  );
  let result = [...elements];
  for (const pageIndex of pages) {
    const pageIds = result.filter((e) => e.pageIndex === pageIndex).map((e) => e.id);
    const sel = pageIds.filter((id) => ids.has(id));
    const unsel = pageIds.filter((id) => !ids.has(id));
    result = applyPageLayerOrder(result, pageIndex, [...unsel, ...sel]);
  }
  return result;
}

function sendIdsToBack(elements: readonly DrawEl[], ids: ReadonlySet<string>): DrawEl[] {
  const pages = new Set(
    elements.filter((e) => ids.has(e.id)).map((e) => e.pageIndex),
  );
  let result = [...elements];
  for (const pageIndex of pages) {
    const pageIds = result.filter((e) => e.pageIndex === pageIndex).map((e) => e.id);
    const sel = pageIds.filter((id) => ids.has(id));
    const unsel = pageIds.filter((id) => !ids.has(id));
    result = applyPageLayerOrder(result, pageIndex, [...sel, ...unsel]);
  }
  return result;
}

function resizeTextBox(el: TextEl, side: TextWidthSide, pt: Point, bounds: Bounds): TextEl {
  const right = bounds.x + bounds.w;
  if (side === "right") {
    return { ...el, w: Math.max(48, pt.x - bounds.x) };
  }
  const newW = Math.max(48, right - pt.x);
  return { ...el, x: right - newW, w: newW };
}

function strokeHits(s: StrokeEl, pt: Point, radius: number): boolean {
  const r2 = radius * radius;
  return s.points.some((p) => (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2 <= r2);
}

function rotationHandlePos(b: Bounds, rotation: number): Point {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const localX = cx;
  const localY = b.y - ROT_HANDLE_OFFSET;
  const dx = localX - cx;
  const dy = localY - cy;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

function hitRotationHandle(pt: Point, b: Bounds, rotation: number): boolean {
  const hp = rotationHandlePos(b, rotation);
  return Math.hypot(pt.x - hp.x, pt.y - hp.y) <= HANDLE_R + 4;
}

function lassoHitsEl(el: DrawEl, polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false;
  if (el.kind === "stroke") {
    return el.points.some((p) => pointInPolygon(p, polygon));
  }
  const b = elBounds(el);
  if (!b) return false;
  const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  if (pointInPolygon(center, polygon)) return true;
  const corners: Point[] = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
  if (corners.some((c) => pointInPolygon(c, polygon))) return true;
  return polygon.some((p) => ptInBounds(p, b));
}

function applyHistoryForward(els: readonly DrawEl[], op: HistoryOp): DrawEl[] {
  const removedIds = new Set(op.removed.map((e) => e.id));
  const addedIds = new Set(op.added.map((e) => e.id));
  let next = els.filter((e) => !removedIds.has(e.id) && !addedIds.has(e.id));
  for (const u of op.updated) {
    const idx = next.findIndex((e) => e.id === u.id);
    if (idx >= 0) next = [...next.slice(0, idx), u.after, ...next.slice(idx + 1)];
    else next = [...next, u.after];
  }
  return [...next, ...op.added];
}

function applyHistoryBackward(els: readonly DrawEl[], op: HistoryOp): DrawEl[] {
  const addedIds = new Set(op.added.map((e) => e.id));
  const removedIds = new Set(op.removed.map((e) => e.id));
  let next = els.filter((e) => !addedIds.has(e.id) && !removedIds.has(e.id));
  for (const u of op.updated) {
    const idx = next.findIndex((e) => e.id === u.id);
    if (idx >= 0) next = [...next.slice(0, idx), u.before, ...next.slice(idx + 1)];
    else next = [...next, u.before];
  }
  return [...next, ...op.removed];
}

function ensureImageInCache(
  el: ImageEl,
  cache: Map<string, HTMLImageElement>,
): void {
  if (cache.has(el.id)) return;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => cache.set(el.id, img);
  img.src = el.url;
}

function ensureHistoryImages(
  op: HistoryOp,
  cache: Map<string, HTMLImageElement>,
): void {
  for (const el of op.added) {
    if (el.kind === "image") ensureImageInCache(el, cache);
  }
  for (const u of op.updated) {
    if (u.after.kind === "image") ensureImageInCache(u.after, cache);
    if (u.before.kind === "image") ensureImageInCache(u.before, cache);
  }
  for (const el of op.removed) {
    if (el.kind === "image") ensureImageInCache(el, cache);
  }
}

function paintImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  el: ImageEl,
): void {
  const { x, y, w, h, rotation, crop } = el;
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.translate(-cx, -cy);
  if (crop) {
    ctx.drawImage(img, crop.sx, crop.sy, crop.sWidth, crop.sHeight, x, y, w, h);
  } else {
    ctx.drawImage(img, x, y, w, h);
  }
  ctx.restore();
}

function displayCropToSource(
  el: ImageEl,
  frame: Bounds,
  img: HTMLImageElement,
): ImageCrop {
  const baseSx = el.crop?.sx ?? 0;
  const baseSy = el.crop?.sy ?? 0;
  const baseSw = el.crop?.sWidth ?? img.naturalWidth;
  const baseSh = el.crop?.sHeight ?? img.naturalHeight;
  const relX = (frame.x - el.x) / el.w;
  const relY = (frame.y - el.y) / el.h;
  const relW = frame.w / el.w;
  const relH = frame.h / el.h;
  return {
    sx: baseSx + relX * baseSw,
    sy: baseSy + relY * baseSh,
    sWidth: Math.max(1, relW * baseSw),
    sHeight: Math.max(1, relH * baseSh),
  };
}

function sourceCropToDisplay(el: ImageEl, img: HTMLImageElement): Bounds {
  if (!el.crop) return { x: el.x, y: el.y, w: el.w, h: el.h };
  const baseSw = img.naturalWidth;
  const baseSh = img.naturalHeight;
  const relX = el.crop.sx / baseSw;
  const relY = el.crop.sy / baseSh;
  const relW = el.crop.sWidth / baseSw;
  const relH = el.crop.sHeight / baseSh;
  return {
    x: el.x + relX * el.w,
    y: el.y + relY * el.h,
    w: relW * el.w,
    h: relH * el.h,
  };
}

function pixelEraseStroke(stroke: StrokeEl, pt: Point, radius: number): StrokeEl[] {
  const r2 = radius * radius;
  const segments: Point[][] = [];
  let current: Point[] = [];

  for (const p of stroke.points) {
    if ((p.x - pt.x) ** 2 + (p.y - pt.y) ** 2 > r2) {
      current.push(p);
    } else if (current.length > 0) {
      if (current.length >= 1) segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);

  if (segments.length === 0) return [];
  if (segments.length === 1 && segments[0].length === stroke.points.length) return [stroke];

  return segments.map((points, i) => ({
    ...stroke,
    id: i === 0 ? stroke.id : nanoid(),
    points,
  }));
}

function translateEl(el: DrawEl, dx: number, dy: number): DrawEl {
  if (el.kind === "stroke")
    return { ...el, points: el.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  if (el.kind === "shape") return { ...el, x: el.x + dx, y: el.y + dy };
  if (el.kind === "text") return { ...el, x: el.x + dx, y: el.y + dy };
  return { ...el, x: el.x + dx, y: el.y + dy };
}

function scaleEl(el: DrawEl, b: Bounds, sx: number, sy: number): DrawEl {
  if (el.kind === "stroke") {
    return {
      ...el,
      points: el.points.map((p) => ({
        x: b.x + (p.x - b.x) * sx,
        y: b.y + (p.y - b.y) * sy,
      })),
      width: el.width * Math.max(sx, sy),
    };
  }
  if (el.kind === "shape") {
    const nb = elBounds(el);
    if (!nb) return el;
    const nx = b.x + (nb.x - b.x) * sx;
    const ny = b.y + (nb.y - b.y) * sy;
    return {
      ...el,
      x: nx,
      y: ny,
      w: nb.w * sx * Math.sign(el.w || 1),
      h: nb.h * sy * Math.sign(el.h || 1),
      width: el.width * Math.max(sx, sy),
    };
  }
  if (el.kind === "text") {
    const nb = elBounds(el);
    if (!nb) return el;
    return {
      ...el,
      x: b.x + (el.x - b.x) * sx,
      y: b.y + (el.y - b.y) * sy,
      w: nb.w * sx,
      fontSize: el.fontSize * Math.max(sx, sy),
    };
  }
  const nb = elBounds(el);
  if (!nb) return el;
  return {
    ...el,
    x: b.x + (nb.x - b.x) * sx,
    y: b.y + (nb.y - b.y) * sy,
    w: nb.w * sx,
    h: nb.h * sy,
  };
}

function upsertElement(list: readonly DrawEl[], el: DrawEl): DrawEl[] {
  const idx = list.findIndex((e) => e.id === el.id);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = el;
    return next;
  }
  return [...list, el];
}

function cloneEl(el: DrawEl, pageIndex: number, offset: number): DrawEl {
  const id = nanoid();
  if (el.kind === "stroke") return { ...el, id, pageIndex, points: el.points.map((p) => ({ x: p.x + offset, y: p.y + offset })) };
  if (el.kind === "shape") return { ...el, id, pageIndex, x: el.x + offset, y: el.y + offset };
  if (el.kind === "text") return { ...el, id, pageIndex, x: el.x + offset, y: el.y + offset };
  return { ...el, id, pageIndex, x: el.x + offset, y: el.y + offset };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const paragraphs = text.split(/\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = words[0];
    for (let i = 1; i < words.length; i++) {
      const trial = `${current} ${words[i]}`;
      if (ctx.measureText(trial).width <= maxWidth) {
        current = trial;
      } else {
        lines.push(current);
        current = words[i];
      }
    }
    lines.push(current);
  }
  return lines;
}

function toSyncEl(el: DrawEl): SyncEl | null {
  if (el.kind === "stroke")
    return {
      kind: "stroke",
      id: el.id,
      tool: el.tool,
      color: el.color,
      width: el.width,
      opacity: el.opacity,
      strokeStyle: el.strokeStyle,
      pts: toSyncPts(el.points),
      pageIndex: el.pageIndex,
    };
  if (el.kind === "shape") return el;
  if (el.kind === "text") return el;
  if (el.kind === "image") return el;
  return null;
}

function makeThrottle<T extends unknown[]>(fn: (...a: T) => void, ms: number): (...a: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  return (...args: T): void => {
    const wait = ms - (Date.now() - last);
    if (wait <= 0) {
      last = Date.now();
      fn(...args);
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      last = Date.now();
      fn(...args);
    }, wait);
  };
}

// ─── Canvas drawing ───────────────────────────────────────────────────────────

function setDash(ctx: CanvasRenderingContext2D, style: StrokeStyle, w: number): void {
  if (style === "dashed") ctx.setLineDash([w * 4, w * 2]);
  else if (style === "dotted") ctx.setLineDash([w, w * 2]);
  else ctx.setLineDash([]);
}

function paintSmoothStroke(
  ctx: CanvasRenderingContext2D,
  pts: readonly Point[],
  color: string,
  width: number,
  opacity: number,
  hl: boolean,
  strokeStyle: StrokeStyle,
): void {
  if (pts.length === 0) return;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = hl ? "multiply" : "source-over";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  setDash(ctx, strokeStyle, width);
  ctx.beginPath();
  if (pts.length === 1) {
    ctx.arc(pts[0].x, pts[0].y, width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }
  ctx.restore();
}

function paintArrowhead(ctx: CanvasRenderingContext2D, from: Point, to: Point, sz: number): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - sz * Math.cos(angle - Math.PI / 6), to.y - sz * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - sz * Math.cos(angle + Math.PI / 6), to.y - sz * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function paintShape(ctx: CanvasRenderingContext2D, el: ShapeEl | ActiveShape): void {
  const x1 = "x" in el ? el.x : el.start.x;
  const y1 = "x" in el ? el.y : el.start.y;
  const x2 = "x" in el ? el.x + el.w : el.end.x;
  const y2 = "x" in el ? el.y + el.h : el.end.y;
  ctx.save();
  ctx.strokeStyle = el.color;
  ctx.lineWidth = el.width;
  ctx.lineCap = "round";
  setDash(ctx, el.strokeStyle, el.width);
  const lx = Math.min(x1, x2);
  const ty = Math.min(y1, y2);
  const rw = Math.abs(x2 - x1);
  const bh = Math.abs(y2 - y1);
  switch (el.shape) {
    case "rectangle":
      ctx.strokeRect(lx, ty, rw, bh);
      break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(lx + rw / 2, ty + bh / 2, rw / 2, bh / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "triangle":
      ctx.beginPath();
      ctx.moveTo(lx + rw / 2, ty);
      ctx.lineTo(lx, ty + bh);
      ctx.lineTo(lx + rw, ty + bh);
      ctx.closePath();
      ctx.stroke();
      break;
    case "line":
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      break;
    case "arrow":
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      paintArrowhead(ctx, { x: x1, y: y1 }, { x: x2, y: y2 }, el.width * 4 + 8);
      break;
  }
  ctx.restore();
}

function paintText(ctx: CanvasRenderingContext2D, el: TextEl): void {
  if (!el.text.trim()) return;
  ctx.save();
  ctx.fillStyle = el.color;
  ctx.font = textFontString(el);
  ctx.direction = "rtl";
  ctx.textBaseline = "top";
  const lh = textLineHeight(el.fontSize);
  // Half-leading centers the glyph em-box inside the CSS line box, matching
  // the textarea overlay (line-height * fontSize) pixel-for-pixel.
  const halfLeading = (lh - el.fontSize) / 2;
  // The content box is inset by TEXT_PADDING on every edge, identical to the
  // textarea overlay (padding: 8px, box-sizing: border-box).
  const rightEdge = el.x + el.w - TEXT_PADDING;
  const leftEdge = el.x + TEXT_PADDING;
  const centerX = el.x + el.w / 2;
  const lines = getWrappedTextLines(el);
  lines.forEach((line, i) => {
    const top = el.y + TEXT_PADDING + i * lh + halfLeading;
    if (el.align === "right") {
      ctx.textAlign = "right";
      ctx.fillText(line, rightEdge, top);
    } else if (el.align === "center") {
      ctx.textAlign = "center";
      ctx.fillText(line, centerX, top);
    } else {
      ctx.textAlign = "left";
      ctx.fillText(line, leftEdge, top);
    }
  });
  ctx.restore();
}

function paintToolCursor(
  ctx: CanvasRenderingContext2D,
  pt: Point,
  tool: DrawTool,
  penWidth: number,
  penColor: string,
  eraserRadius: number,
): void {
  ctx.save();
  if (tool === "pen" || tool === "highlighter") {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, Math.max(penWidth / 2, 2), 0, Math.PI * 2);
    ctx.fillStyle = tool === "highlighter" ? `${penColor}59` : penColor;
    ctx.fill();
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (tool === "eraser") {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, eraserRadius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fill();
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    const cross = Math.min(eraserRadius, 6);
    ctx.beginPath();
    ctx.moveTo(pt.x - cross, pt.y);
    ctx.lineTo(pt.x + cross, pt.y);
    ctx.moveTo(pt.x, pt.y - cross);
    ctx.lineTo(pt.x, pt.y + cross);
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (tool === "laser") {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#ef4444";
    ctx.shadowColor = "#ef4444";
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.strokeStyle = "#fca5a5";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

function paintTextPillHandles(ctx: CanvasRenderingContext2D, b: Bounds): void {
  ctx.save();
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
  ctx.setLineDash([]);
  ctx.fillStyle = "#3b82f6";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  for (const { x, y } of textPillHandlePositions(b)) {
    ctx.beginPath();
    ctx.roundRect(x - 5, y - 14, 10, 28, 5);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function paintSelectionOverlay(
  ctx: CanvasRenderingContext2D,
  bounds: Bounds | null,
  marquee: { start: Point; end: Point } | null,
  lassoPoints: readonly Point[] | null,
  rotation: number | null,
  textOnlyBounds: Bounds | null,
): void {
  if (textOnlyBounds) {
    paintTextPillHandles(ctx, textOnlyBounds);
    return;
  }
  if (bounds) {
    ctx.save();
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(bounds.x - 2, bounds.y - 2, bounds.w + 4, bounds.h + 4);
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#3b82f6";
    for (const { x, y } of handlePositions(bounds)) {
      ctx.beginPath();
      ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (rotation !== null) {
      const hp = rotationHandlePos(bounds, rotation);
      ctx.beginPath();
      ctx.moveTo(bounds.x + bounds.w / 2, bounds.y - 4);
      ctx.lineTo(hp.x, hp.y);
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.stroke();

      // Rotation circular handle (amber handle like the design)
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#f59e0b";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Rotation icon (↻) inside the handle
      ctx.font = "bold 9px system-ui, sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("↻", hp.x, hp.y);
    }
    ctx.restore();
  }
  if (marquee) {
    const lx = Math.min(marquee.start.x, marquee.end.x);
    const ty = Math.min(marquee.start.y, marquee.end.y);
    const rw = Math.abs(marquee.end.x - marquee.start.x);
    const bh = Math.abs(marquee.end.y - marquee.start.y);
    ctx.save();
    ctx.fillStyle = "rgba(59,130,246,0.12)";
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(lx, ty, rw, bh);
    ctx.strokeRect(lx, ty, rw, bh);
    ctx.restore();
  }
  if (lassoPoints && lassoPoints.length > 1) {
    ctx.save();
    ctx.fillStyle = "rgba(59,130,246,0.12)";
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) {
      ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function paintCropOverlay(
  ctx: CanvasRenderingContext2D,
  imageEl: ImageEl,
  img: HTMLImageElement,
  frame: Bounds,
): void {
  const b = elBounds(imageEl);
  if (!b) return;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.x, frame.y, frame.w, frame.h);
  ctx.clip();
  paintImage(ctx, img, imageEl);
  ctx.restore();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#3b82f6";
  for (const { x, y } of handlePositions(frame)) {
    ctx.beginPath();
    ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function renderPage(
  canvas: HTMLCanvasElement,
  pageIndex: number,
  elements: readonly DrawEl[],
  active: ActiveDrawing,
  laserPts: readonly Point[] | null,
  laserAlpha: number,
  selectedIds: ReadonlySet<string>,
  selection: SelectionState | null,
  imgCache: Map<string, HTMLImageElement>,
  eraserPt: Point | null,
  eraserRadius: number,
  cropState: CropState | null,
  editingTextId: string | null,
  cursorPt: Point | null,
  tool: DrawTool,
  penWidth: number,
  penColor: string,
  transformMode: boolean,
): void {
  const dpr = Math.ceil(window.devicePixelRatio ?? 1);
  if (canvas.width !== PAGE_W * dpr || canvas.height !== PAGE_H * dpr) {
    canvas.width = PAGE_W * dpr;
    canvas.height = PAGE_H * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, PAGE_W, PAGE_H);

  for (const el of elements) {
    if (el.pageIndex !== pageIndex) continue;
    if (el.kind === "stroke")
      paintSmoothStroke(ctx, el.points, el.color, el.width, el.opacity, el.tool === "highlighter", el.strokeStyle);
    else if (el.kind === "shape") paintShape(ctx, el);
    else if (el.kind === "text") {
      if (editingTextId === el.id) continue;
      paintText(ctx, el);
    } else if (el.kind === "image") {
      const img = imgCache.get(el.id);
      if (img?.complete && img.naturalWidth > 0) paintImage(ctx, img, el);
    }
  }

  if (active?.pageIndex === pageIndex) {
    if (active.kind === "pen")
      paintSmoothStroke(ctx, active.points, active.color, active.width, active.opacity, active.tool === "highlighter", active.strokeStyle);
    else if (active.kind === "shape") paintShape(ctx, active);
  }

  if (laserPts && laserPts.length > 1) {
    ctx.save();
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 3.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = "#ef4444";
    ctx.shadowBlur = 10;
    ctx.globalAlpha = 0.9 * laserAlpha;
    ctx.beginPath();
    ctx.moveTo(laserPts[0].x, laserPts[0].y);
    laserPts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.stroke();
    ctx.restore();
  }

  const previewPt = eraserPt ?? cursorPt;
  if (previewPt && (tool === "eraser" || tool === "pen" || tool === "highlighter" || tool === "laser")) {
    paintToolCursor(ctx, previewPt, tool, penWidth, penColor, eraserRadius);
  }

  if (cropState && cropState.pageIndex === pageIndex) {
    const imgEl = elements.find(
      (e): e is ImageEl => e.kind === "image" && e.id === cropState.imageId,
    );
    if (imgEl) {
      const img = imgCache.get(imgEl.id);
      if (img?.complete && img.naturalWidth > 0) {
        paintCropOverlay(ctx, imgEl, img, cropState.frame);
      }
    }
  }

  const groupB =
    selectedIds.size > 0 ? groupBoundsFor(elements, selectedIds) : null;
  const marquee =
    selection?.mode === "marquee" && selection.pageIndex === pageIndex
      ? { start: selection.start, end: selection.current }
      : null;
  const lassoPts =
    selection?.mode === "lasso" && selection.pageIndex === pageIndex
      ? selection.lassoPoints
      : null;
  let singleImageRotation: number | null = null;
  let textOnlyBounds: Bounds | null = null;
  if (selectedIds.size === 1 && !transformMode) {
    const sel = elements.find((e) => selectedIds.has(e.id));
    if (sel?.kind === "image") singleImageRotation = sel.rotation;
    if (sel?.kind === "text") textOnlyBounds = textElBounds(sel);
  } else if (selectedIds.size === 1 && transformMode) {
    const sel = elements.find((e) => selectedIds.has(e.id));
    if (sel?.kind === "image") singleImageRotation = sel.rotation;
  }
  paintSelectionOverlay(
    ctx,
    textOnlyBounds ? null : groupB,
    marquee,
    lassoPts,
    singleImageRotation,
    textOnlyBounds,
  );

  ctx.restore();
}

function emptySelection(
  mode: SelectionMode,
  pageIndex: number,
  start: Point,
): SelectionState {
  return {
    mode,
    pageIndex,
    start,
    current: start,
    lassoPoints: mode === "lasso" ? [start] : [],
    handle: null,
    widthSide: null,
    snapshot: [],
    groupBounds: null,
    initialRotation: 0,
    rotateCenter: null,
  };
}

const SHAPES: { kind: ShapeKind; icon: string; label: string }[] = [
  { kind: "rectangle", icon: "▭", label: "מרובע" },
  { kind: "ellipse", icon: "⬭", label: "אליפסה" },
  { kind: "triangle", icon: "△", label: "משולש" },
  { kind: "line", icon: "╱", label: "קו ישר" },
  { kind: "arrow", icon: "→", label: "חץ" },
];

const TOOL_META: Record<DrawTool, { icon: string; label: string }> = {
  selection: { icon: "⭕", label: "לאסו / בחירה" },
  pen: { icon: "✒", label: "עט" },
  highlighter: { icon: "🖊", label: "מרקר" },
  eraser: { icon: "🧹", label: "מחק" },
  shapes: { icon: "📐", label: "צורות" },
  text: { icon: "🔤", label: "טקסט" },
  image: { icon: "🖼", label: "תמונה" },
  laser: { icon: "🔴", label: "מצביע לייזר" },
};

const STROKE_STYLES: { value: StrokeStyle; label: string; preview: string }[] = [
  { value: "solid", label: "רציף", preview: "————" },
  { value: "dashed", label: "מקווקו", preview: "— — " },
  { value: "dotted", label: "נקודות", preview: "· · ·" },
];

// ─── Main component ───────────────────────────────────────────────────────────

const ClassroomWhiteboard = forwardRef<ClassroomWhiteboardRef, ClassroomWhiteboardProps>(
  function ClassroomWhiteboard(
    { role: _role, streamChannel = null, packageId = null, lessonId = null },
    ref,
  ) {
    const [pages, setPages] = useState<PageInfo[]>(() => [{ id: nanoid(), pageNumber: 1 }]);
    const [elements, setElements] = useState<DrawEl[]>([]);
    const [tool, setTool] = useState<DrawTool>("pen");
    const [color, setColor] = useState<string>(PALETTE[0].hex);
    const [widthMm, setWidthMm] = useState(0.6);
    const [hlWidthMm, setHlWidthMm] = useState(4.0);
    const [strokeStyle, setStrokeStyle] = useState<StrokeStyle>("solid");
    const [shapeKind, setShapeKind] = useState<ShapeKind>("rectangle");
    const [eraserMode, setEraserMode] = useState<EraserMode>("stroke");
    const [eraserDiameter, setEraserDiameter] = useState<number>(10);
    const [lassoStyle, setLassoStyle] = useState<LassoStyle>("rect");
    const [undoStack, setUndoStack] = useState<HistoryOp[]>([]);
    const [redoStack, setRedoStack] = useState<HistoryOp[]>([]);
    const [cropState, setCropState] = useState<CropState | null>(null);
    const [zoom, setZoom] = useState(1);
    const [active, setActive] = useState<ActiveDrawing>(null);
    const [laserPts, setLaserPts] = useState<Point[] | null>(null);
    const [laserPage, setLaserPage] = useState<number | null>(null);
    const [laserAlpha, setLaserAlpha] = useState(1);
    const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
    const [selection, setSelection] = useState<SelectionState | null>(null);
    const [editText, setEditText] = useState<EditTextSession | null>(null);
    const [eraserPt, setEraserPt] = useState<Point | null>(null);
    const [cursorPt, setCursorPt] = useState<(Point & { pageIndex: number }) | null>(null);
    const [canvasCursor, setCanvasCursor] = useState<string>("crosshair");
    const [openMenu, setOpenMenu] = useState<
      "selection" | "pen" | "highlighter" | "eraser" | "shapes" | null
    >(null);
    const [textMenu, setTextMenu] = useState<"size" | "align" | "color" | null>(null);
    const [showRecolorPicker, setShowRecolorPicker] = useState(false);
    const [showLassoMore, setShowLassoMore] = useState(false);
    const [transformMode, setTransformMode] = useState(false);
    const [aiHint, setAiHint] = useState<string | null>(null);
    const [syncStatus, setSyncStatus] = useState<"idle" | "live" | "error">("idle");
    const [activePageIndex, setActivePageIndex] = useState(0);
    const [preLessonAssets, setPreLessonAssets] = useState<PreLessonAssetPanelItem[]>([]);
    const [assetsPanelOpen, setAssetsPanelOpen] = useState(false);
    const [assetsLoading, setAssetsLoading] = useState(false);
    const [insertingAssetId, setInsertingAssetId] = useState<string | null>(null);

    const canvasMap = useRef<Map<string, HTMLCanvasElement>>(new Map());
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const toolbarRef = useRef<HTMLDivElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const commitTextRef = useRef<() => void>(() => {});
    const activeRef = useRef<ActiveDrawing>(null);
    const elementsRef = useRef<DrawEl[]>(elements);
    const selectedRef = useRef<ReadonlySet<string>>(selectedIds);
    const erasingRef = useRef(false);
    const applyRemote = useRef(false);
    const rafId = useRef<number | null>(null);
    const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());
    const zoomRef = useRef(zoom);
    const clipboardRef = useRef<DrawEl[]>([]);
    const laserTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const undoStackRef = useRef<HistoryOp[]>([]);
    const redoStackRef = useRef<HistoryOp[]>([]);
    const eraserSizeRef = useRef(eraserDiameter / 2);
    const broadcastRef = useRef<((payload: Record<string, unknown>) => void) | null>(null);

    const eraserRadius = eraserDiameter / 2;

    useEffect(() => {
      undoStackRef.current = undoStack;
    }, [undoStack]);
    useEffect(() => {
      redoStackRef.current = redoStack;
    }, [redoStack]);
    useEffect(() => {
      eraserSizeRef.current = eraserDiameter / 2;
    }, [eraserDiameter]);

    useEffect(() => {
      elementsRef.current = elements;
    }, [elements]);
    useEffect(() => {
      selectedRef.current = selectedIds;
    }, [selectedIds]);
    useEffect(() => {
      zoomRef.current = zoom;
    }, [zoom]);

    useEffect(() => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        pages.forEach((page, idx) => {
          const canvas = canvasMap.current.get(page.id);
          if (canvas) {
            renderPage(
              canvas,
              idx,
              elements,
              active,
              laserPage === idx ? laserPts : null,
              laserAlpha,
              selectedIds,
              selection,
              imgCache.current,
              eraserPt,
              eraserRadius,
              cropState,
              editText?.id ?? null,
              cursorPt?.pageIndex === idx ? cursorPt : null,
              tool,
              tool === "highlighter" ? mmToPx(hlWidthMm) : mmToPx(widthMm),
              color,
              transformMode,
            );
          }
        });
      });
      return () => {
        if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      };
    });

    useEffect(() => {
      if (editText) setTimeout(() => textareaRef.current?.focus(), 0);
    }, [editText]);

    useEffect(() => {
      if (selectedIds.size === 0) {
        setShowRecolorPicker(false);
        setShowLassoMore(false);
        setTransformMode(false);
      }
    }, [selectedIds.size]);

    useEffect(() => {
      const root = containerRef.current;
      if (!root) return;
      const blockMenu = (e: Event): void => e.preventDefault();
      root.addEventListener("contextmenu", blockMenu);
      return () => root.removeEventListener("contextmenu", blockMenu);
    }, []);

    useEffect(() => {
      if (!aiHint) return;
      const t = setTimeout(() => setAiHint(null), 4500);
      return () => clearTimeout(t);
    }, [aiHint]);

    useEffect(() => {
      if (!openMenu) return;
      const onOutside = (ev: PointerEvent): void => {
        const target = ev.target as Node;
        if (document.querySelector(".board-toolbar-root")?.contains(target)) return;
        setOpenMenu(null);
      };
      document.addEventListener("pointerdown", onOutside);
      return () => document.removeEventListener("pointerdown", onOutside);
    }, [openMenu]);

    useEffect(() => {
      if (!textMenu) return;
      const onOutside = (ev: PointerEvent): void => {
        const target = ev.target as Node;
        if (document.querySelector(".text-format-bar")?.contains(target)) return;
        setTextMenu(null);
      };
      document.addEventListener("pointerdown", onOutside);
      return () => document.removeEventListener("pointerdown", onOutside);
    }, [textMenu]);

    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      const blockHorizontalWheel = (e: WheelEvent): void => {
        if (!(e.metaKey || e.ctrlKey) && Math.abs(e.deltaX) > 0) {
          e.preventDefault();
        }
      };
      el.addEventListener("wheel", blockHorizontalWheel, { passive: false });
      return () => el.removeEventListener("wheel", blockHorizontalWheel);
    }, []);

    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      const handler = (e: WheelEvent): void => {
        if (!(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.03 : 0.03;
        setZoom((z) => Math.max(0.25, Math.min(3, Math.round((z + delta) * 100) / 100)));
      };
      el.addEventListener("wheel", handler, { passive: false });
      return () => el.removeEventListener("wheel", handler);
    }, []);

    function ptFrom(e: React.PointerEvent<HTMLCanvasElement>): Point {
      const r = e.currentTarget.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) / zoomRef.current,
        y: (e.clientY - r.top) / zoomRef.current,
      };
    }

    const broadcastElement = useCallback((payload: Record<string, unknown>): void => {
      broadcastRef.current?.(payload);
    }, []);

    const pushHistory = useCallback(
      (op: HistoryOp, sync = false): void => {
        setUndoStack((prev) => [...prev, op]);
        setRedoStack([]);
        if (sync) {
          broadcastElement({ historyOp: op, direction: "forward" });
        }
      },
      [broadcastElement],
    );

    const applyHistoryRemote = useCallback((op: HistoryOp, direction: "forward" | "backward"): void => {
      ensureHistoryImages(op, imgCache.current);
      setElements((prev) =>
        direction === "forward" ? applyHistoryForward(prev, op) : applyHistoryBackward(prev, op),
      );
    }, []);

    const performUndo = useCallback((): void => {
      const stack = undoStackRef.current;
      if (stack.length === 0) return;
      const op = stack[stack.length - 1];
      ensureHistoryImages(op, imgCache.current);
      setElements((prev) => applyHistoryBackward(prev, op));
      setUndoStack((prev) => prev.slice(0, -1));
      setRedoStack((prev) => [...prev, op]);
      broadcastElement({ historyOp: op, direction: "backward" });
    }, [broadcastElement]);

    const performRedo = useCallback((): void => {
      const stack = redoStackRef.current;
      if (stack.length === 0) return;
      const op = stack[stack.length - 1];
      ensureHistoryImages(op, imgCache.current);
      setElements((prev) => applyHistoryForward(prev, op));
      setRedoStack((prev) => prev.slice(0, -1));
      setUndoStack((prev) => [...prev, op]);
      broadcastElement({ historyOp: op, direction: "forward" });
    }, [broadcastElement]);

    useEffect(() => {
      if (!streamChannel) {
        broadcastRef.current = null;
        return;
      }
      const throttled = makeThrottle((payload: Record<string, unknown>): void => {
        if (applyRemote.current) return;
        const json = JSON.stringify({ type: BOARD_EVENT, v: PROTO_V, ...payload });
        if (json.length > STREAM_LIMIT) {
          console.warn(`[whiteboard] payload ${json.length}B > limit, skipping`);
          return;
        }
        void streamChannel
          .sendEvent({ type: BOARD_EVENT, v: PROTO_V, ...payload } as unknown as Parameters<
            Channel["sendEvent"]
          >[0])
          .then(() => setSyncStatus("live"))
          .catch((err: unknown) => {
            const m = err instanceof Error ? err.message : String(err);
            if (!/size|limit|payload|2000|4096/i.test(m)) {
              console.error("[whiteboard]", err);
              setSyncStatus("error");
            }
          });
      }, 0);
      broadcastRef.current = throttled;
      setSyncStatus("live");
    }, [streamChannel]);

    useEffect(() => {
      if (!streamChannel) return;

      const onEvent = (ev: SyncEvent): void => {
        if (ev.type !== BOARD_EVENT || (ev.v !== PROTO_V && ev.v !== 5 && ev.v !== 4)) return;
        applyRemote.current = true;
        try {
          if (ev.historyOp && (ev.direction === "forward" || ev.direction === "backward")) {
            applyHistoryRemote(ev.historyOp, ev.direction);
          }
          if (ev.add !== undefined && ev.add !== null) {
            const raw = ev.add as SyncEl;
            if (raw.kind === "stroke") {
              const el: StrokeEl = {
                kind: "stroke",
                id: raw.id,
                tool: raw.tool,
                color: raw.color,
                width: raw.width,
                opacity: raw.opacity,
                strokeStyle: raw.strokeStyle ?? "solid",
                points: fromSyncPts(raw.pts),
                pageIndex: raw.pageIndex,
              };
              setElements((prev) => upsertElement(prev, el));
            } else if (raw.kind === "shape") {
              setElements((prev) => upsertElement(prev, raw as ShapeEl));
            } else if (raw.kind === "text") {
              const el = normalizeTextEl(raw as TextEl);
              setElements((prev) => upsertElement(prev, el));
            } else if (raw.kind === "image") {
              const imgEl = raw as SyncImage;
              const el: ImageEl = {
                kind: "image",
                id: imgEl.id,
                url: imgEl.url,
                x: imgEl.x,
                y: imgEl.y,
                w: imgEl.w,
                h: imgEl.h,
                rotation: imgEl.rotation ?? 0,
                crop: imgEl.crop ?? null,
                pageIndex: imgEl.pageIndex,
              };
              ensureImageInCache(el, imgCache.current);
              setElements((prev) => upsertElement(prev, el));
            }
          }
          if (Array.isArray(ev.remove)) {
            const rmSet = new Set(ev.remove as string[]);
            setElements((prev) => prev.filter((e) => !rmSet.has(e.id)));
          }
          if (ev.layerOrder) {
            const { pageIndex, ids } = ev.layerOrder;
            setElements((prev) => applyPageLayerOrder(prev, pageIndex, ids));
          }
          if (typeof ev.pageCount === "number" && ev.pageCount > 0) {
            const target = ev.pageCount;
            setPages((prev) => {
              if (prev.length >= target) return prev;
              return [
                ...prev,
                ...Array.from({ length: target - prev.length }, (_, i) => ({
                  id: nanoid(),
                  pageNumber: prev.length + i + 1,
                })),
              ];
            });
          }
          setSyncStatus("live");
        } finally {
          setTimeout(() => {
            applyRemote.current = false;
          }, 50);
        }
      };

      const unbound = streamChannel.on(BOARD_EVENT as "message.new", onEvent as never);
      setSyncStatus("live");
      return () => {
        if (typeof unbound === "object" && unbound && "unsubscribe" in unbound) {
          (unbound as { unsubscribe: () => void }).unsubscribe();
        } else {
          streamChannel.off(BOARD_EVENT as "message.new", onEvent as never);
        }
      };
    }, [streamChannel, applyHistoryRemote]);

    const removeElements = useCallback(
      (ids: string[], withHistory = true): void => {
        if (ids.length === 0) return;
        const rmSet = new Set(ids);
        const removed = elementsRef.current.filter((e) => rmSet.has(e.id));
        if (withHistory && removed.length > 0) {
          pushHistory({ id: nanoid(), removed, added: [], updated: [] }, true);
        }
        setElements((prev) => prev.filter((e) => !rmSet.has(e.id)));
        setSelectedIds((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
        broadcastElement({ remove: ids });
      },
      [broadcastElement, pushHistory],
    );

    const applyEraserAt = useCallback(
      (pt: Point, pageIndex: number): void => {
        const radius = eraserSizeRef.current;
        if (eraserMode === "stroke") {
          const removed = elementsRef.current.filter(
            (s) =>
              s.pageIndex === pageIndex && s.kind === "stroke" && strokeHits(s as StrokeEl, pt, radius),
          );
          if (removed.length === 0) return;
          pushHistory({ id: nanoid(), removed, added: [], updated: [] }, true);
          const rmIds = removed.map((s) => s.id);
          setElements((prev) => prev.filter((e) => !rmIds.includes(e.id)));
          broadcastElement({ remove: rmIds });
          return;
        }

        const nextEls: DrawEl[] = [];
        const removedEls: DrawEl[] = [];
        const addedEls: DrawEl[] = [];

        for (const el of elementsRef.current) {
          if (el.pageIndex !== pageIndex || el.kind !== "stroke") {
            nextEls.push(el);
            continue;
          }
          const parts = pixelEraseStroke(el, pt, radius);
          if (parts.length === 0) {
            removedEls.push(el);
          } else if (parts.length === 1 && parts[0].id === el.id) {
            nextEls.push(el);
          } else {
            removedEls.push(el);
            parts.forEach((p) => addedEls.push(p));
          }
        }

        if (removedEls.length === 0 && addedEls.length === 0) return;
        pushHistory({ id: nanoid(), removed: removedEls, added: addedEls, updated: [] }, true);
        setElements([...nextEls, ...addedEls]);
        if (removedEls.length) broadcastElement({ remove: removedEls.map((e) => e.id) });
        addedEls.forEach((a) => {
          const sync = toSyncEl(a);
          if (sync) broadcastElement({ add: sync });
        });
      },
      [eraserMode, broadcastElement, pushHistory],
    );

    const finalizeSelection = useCallback(
      (sel: SelectionState): void => {
        if (sel.mode === "marquee") {
          const rect: Bounds = {
            x: Math.min(sel.start.x, sel.current.x),
            y: Math.min(sel.start.y, sel.current.y),
            w: Math.abs(sel.current.x - sel.start.x),
            h: Math.abs(sel.current.y - sel.start.y),
          };
          const hits = elementsRef.current.filter((el) => {
            if (el.pageIndex !== sel.pageIndex) return false;
            const b = elBounds(el);
            return b ? boundsIntersect(b, rect) : false;
          });
          setSelectedIds(new Set(hits.map((h) => h.id)));
        } else if (sel.mode === "lasso") {
          const hits = elementsRef.current.filter(
            (el) => el.pageIndex === sel.pageIndex && lassoHitsEl(el, sel.lassoPoints),
          );
          setSelectedIds(new Set(hits.map((h) => h.id)));
        } else if (
          sel.mode === "move" ||
          sel.mode === "resize" ||
          sel.mode === "rotate" ||
          sel.mode === "text-width"
        ) {
          const ids = new Set(sel.snapshot.map((e) => e.id));
          const updated: HistoryUpdate[] = [];
          const changed = elementsRef.current.filter((e) => ids.has(e.id));
          changed.forEach((after) => {
            const before = sel.snapshot.find((s) => s.id === after.id);
            if (before && JSON.stringify(before) !== JSON.stringify(after)) {
              updated.push({ id: after.id, before, after });
              const sync = toSyncEl(after);
              if (sync) broadcastElement({ add: sync });
            }
          });
          if (updated.length > 0) {
            pushHistory({ id: nanoid(), removed: [], added: [], updated }, true);
          }
        }
        setSelection(null);
      },
      [broadcastElement, pushHistory],
    );

    const onDown = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>, pageIndex: number): void => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setActivePageIndex(pageIndex);
        const pt = ptFrom(e);

        if (cropState && cropState.pageIndex === pageIndex) {
          const handle = hitHandle(pt, cropState.frame);
          if (handle) {
            setSelection({
              mode: "resize",
              pageIndex,
              start: pt,
              current: pt,
              lassoPoints: [],
              handle,
              widthSide: null,
              snapshot: [],
              groupBounds: cropState.frame,
              initialRotation: 0,
              rotateCenter: null,
            });
          } else if (ptInBounds(pt, cropState.frame)) {
            setSelection({
              mode: "move",
              pageIndex,
              start: pt,
              current: pt,
              lassoPoints: [],
              handle: null,
              widthSide: null,
              snapshot: [],
              groupBounds: cropState.frame,
              initialRotation: 0,
              rotateCenter: null,
            });
          }
          return;
        }

        if (tool === "eraser") {
          erasingRef.current = true;
          setEraserPt(pt);
          applyEraserAt(pt, pageIndex);
          return;
        }

        if (tool === "laser") {
          if (laserTimerRef.current) clearTimeout(laserTimerRef.current);
          setLaserAlpha(1);
          setLaserPage(pageIndex);
          setLaserPts([pt]);
          return;
        }

        if (tool === "text") {
          setEditText({
            pageIndex,
            x: Math.min(pt.x, PAGE_W - DEFAULT_TEXT_W - 8),
            y: pt.y,
            text: "",
            fontSize: 24,
            bold: false,
            italic: false,
            align: "right",
            color,
            w: DEFAULT_TEXT_W,
          });
          return;
        }

        if (tool === "selection") {
          const groupB = groupBoundsFor(elementsRef.current, selectedRef.current);
          const singleSel =
            selectedRef.current.size === 1
              ? elementsRef.current.find((el) => selectedRef.current.has(el.id))
              : null;
          const singleImage = singleSel?.kind === "image" ? singleSel : null;
          const singleText = singleSel?.kind === "text" ? singleSel : null;
          const singleTextBounds = singleText ? textElBounds(singleText) : null;

          if (singleImage && groupB && hitRotationHandle(pt, groupB, singleImage.rotation)) {
            setSelection({
              mode: "rotate",
              pageIndex,
              start: pt,
              current: pt,
              lassoPoints: [],
              handle: null,
              widthSide: null,
              snapshot: [singleImage],
              groupBounds: groupB,
              initialRotation: singleImage.rotation,
              rotateCenter: { x: groupB.x + groupB.w / 2, y: groupB.y + groupB.h / 2 },
            });
            return;
          }

          if (singleText && singleTextBounds) {
            const pillSide = hitTextPillHandle(pt, singleTextBounds);
            if (pillSide) {
              setSelection({
                mode: "text-width",
                pageIndex,
                start: pt,
                current: pt,
                lassoPoints: [],
                handle: null,
                widthSide: pillSide,
                snapshot: [singleText],
                groupBounds: singleTextBounds,
                initialRotation: 0,
                rotateCenter: null,
              });
              return;
            }
          }

          if (groupB && !singleText && hitHandle(pt, groupB)) {
            const handle = hitHandle(pt, groupB);
            setSelection({
              mode: "resize",
              pageIndex,
              start: pt,
              current: pt,
              lassoPoints: [],
              handle,
              widthSide: null,
              snapshot: elementsRef.current.filter((el) => selectedRef.current.has(el.id)),
              groupBounds: groupB,
              initialRotation: 0,
              rotateCenter: null,
            });
            return;
          }

          if (groupB && ptInBounds(pt, groupB)) {
            setSelection({
              mode: "move",
              pageIndex,
              start: pt,
              current: pt,
              lassoPoints: [],
              handle: null,
              widthSide: null,
              snapshot: elementsRef.current.filter((el) => selectedRef.current.has(el.id)),
              groupBounds: groupB,
              initialRotation: 0,
              rotateCenter: null,
            });
            return;
          }

          const hit = [...elementsRef.current]
            .filter((el) => el.pageIndex === pageIndex)
            .reverse()
            .find((el) => {
              const b = elBounds(el);
              return b ? ptInBounds(pt, b) : false;
            });

          if (hit) {
            setSelectedIds(new Set([hit.id]));
            setSelection({
              mode: "move",
              pageIndex,
              start: pt,
              current: pt,
              lassoPoints: [],
              handle: null,
              widthSide: null,
              snapshot: elementsRef.current.filter((el) => el.id === hit.id),
              groupBounds: elBounds(hit),
              initialRotation: hit.kind === "image" ? hit.rotation : 0,
              rotateCenter: null,
            });
            return;
          }

          setSelectedIds(new Set());
          if (lassoStyle === "free") {
            setSelection(emptySelection("lasso", pageIndex, pt));
          } else {
            setSelection(emptySelection("marquee", pageIndex, pt));
          }
          return;
        }

        if (tool === "pen" || tool === "highlighter") {
          const na: ActivePen = {
            kind: "pen",
            tool,
            color,
            width: tool === "highlighter" ? mmToPx(hlWidthMm) : mmToPx(widthMm),
            opacity: tool === "highlighter" ? 0.35 : 1,
            strokeStyle,
            points: [pt],
            pageIndex,
          };
          activeRef.current = na;
          setActive(na);
          return;
        }

        if (tool === "shapes") {
          const na: ActiveShape = {
            kind: "shape",
            shape: shapeKind,
            color,
            width: mmToPx(widthMm),
            strokeStyle,
            start: pt,
            end: pt,
            pageIndex,
          };
          activeRef.current = na;
          setActive(na);
        }
      },
      [tool, color, widthMm, hlWidthMm, strokeStyle, shapeKind, applyEraserAt, lassoStyle, cropState],
    );

    const onMove = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>, pageIndex: number): void => {
        const pt = ptFrom(e);
        setCursorPt({ x: pt.x, y: pt.y, pageIndex });

        let nextCursor = "crosshair";
        if (tool === "text") nextCursor = "text";
        else if (tool === "eraser" || tool === "laser" || tool === "pen" || tool === "highlighter")
          nextCursor = "none";
        else if (tool === "selection") {
          if (selection?.mode === "move") nextCursor = "grabbing";
          else {
            const groupB = groupBoundsFor(elementsRef.current, selectedRef.current);
            nextCursor = groupB && ptInBounds(pt, groupB) ? "grab" : "default";
          }
        }
        setCanvasCursor(nextCursor);

        if (cropState && selection && selection.groupBounds) {
          if (selection.mode === "move") {
            const dx = pt.x - selection.start.x;
            const dy = pt.y - selection.start.y;
            const b = selection.groupBounds;
            setCropState((prev) =>
              prev
                ? { ...prev, frame: { ...b, x: b.x + dx, y: b.y + dy } }
                : null,
            );
            return;
          }
          if (selection.mode === "resize" && selection.handle) {
            const b = selection.groupBounds;
            let nx = b.x;
            let ny = b.y;
            let nw = b.w;
            let nh = b.h;
            const h = selection.handle;
            if (h.includes("e")) nw = Math.max(20, pt.x - b.x);
            if (h.includes("w")) {
              nw = Math.max(20, b.x + b.w - pt.x);
              nx = pt.x;
            }
            if (h.includes("s")) nh = Math.max(20, pt.y - b.y);
            if (h.includes("n")) {
              nh = Math.max(20, b.y + b.h - pt.y);
              ny = pt.y;
            }
            setCropState((prev) =>
              prev ? { ...prev, frame: { x: nx, y: ny, w: nw, h: nh } } : null,
            );
            return;
          }
        }

        if (tool === "eraser" && erasingRef.current) {
          setEraserPt(pt);
          applyEraserAt(pt, pageIndex);
          return;
        }

        if (tool === "laser") {
          setLaserPts((prev) => [...(prev ?? []), pt]);
          return;
        }

        if (tool === "selection" && selection && selection.pageIndex === pageIndex) {
          if (selection.mode === "marquee") {
            setSelection({ ...selection, current: pt });
            return;
          }

          if (selection.mode === "lasso") {
            const pts = selection.lassoPoints;
            const last = pts[pts.length - 1];
            if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= MIN_LASSO_DIST) {
              setSelection({ ...selection, current: pt, lassoPoints: [...pts, pt] });
            }
            return;
          }

          if (selection.mode === "rotate" && selection.rotateCenter) {
            const c = selection.rotateCenter;
            const startAngle = Math.atan2(selection.start.y - c.y, selection.start.x - c.x);
            const curAngle = Math.atan2(pt.y - c.y, pt.x - c.x);
            const delta = curAngle - startAngle;
            const snap = selection.snapshot[0];
            if (snap?.kind === "image") {
              setElements((prev) =>
                prev.map((el) =>
                  el.id === snap.id && el.kind === "image"
                    ? { ...el, rotation: selection.initialRotation + delta }
                    : el,
                ),
              );
            }
            return;
          }

          if (selection.mode === "text-width" && selection.widthSide && selection.groupBounds) {
            const orig = selection.snapshot[0];
            if (orig?.kind === "text") {
              const resized = resizeTextBox(orig, selection.widthSide, pt, selection.groupBounds);
              setElements((prev) => prev.map((el) => (el.id === orig.id ? resized : el)));
            }
            return;
          }

          if (selection.mode === "move") {
            const dx = pt.x - selection.start.x;
            const dy = pt.y - selection.start.y;
            const ids = new Set(selection.snapshot.map((s) => s.id));
            setElements((prev) =>
              prev.map((el) => (ids.has(el.id) ? translateEl(selection.snapshot.find((s) => s.id === el.id) ?? el, dx, dy) : el)),
            );
            return;
          }

          if (selection.mode === "resize" && selection.groupBounds && selection.handle) {
            const b = selection.groupBounds;
            let nx = b.x;
            let ny = b.y;
            let nw = b.w;
            let nh = b.h;
            const h = selection.handle;
            if (h.includes("e")) nw = Math.max(20, pt.x - b.x);
            if (h.includes("w")) {
              nw = Math.max(20, b.x + b.w - pt.x);
              nx = pt.x;
            }
            if (h.includes("s")) nh = Math.max(20, pt.y - b.y);
            if (h.includes("n")) {
              nh = Math.max(20, b.y + b.h - pt.y);
              ny = pt.y;
            }
            const sx = nw / b.w;
            const sy = nh / b.h;
            const ids = new Set(selection.snapshot.map((s) => s.id));
            setElements((prev) =>
              prev.map((el) => {
                if (!ids.has(el.id)) return el;
                const orig = selection.snapshot.find((s) => s.id === el.id);
                return orig ? scaleEl(orig, b, sx, sy) : el;
              }),
            );
          }
          return;
        }

        const cur = activeRef.current;
        if (!cur || cur.pageIndex !== pageIndex) return;

        if (cur.kind === "pen") {
          const updated: ActivePen = { ...cur, points: [...cur.points, pt] };
          activeRef.current = updated;
          setActive(updated);
        } else if (cur.kind === "shape") {
          const updated: ActiveShape = { ...cur, end: pt };
          activeRef.current = updated;
          setActive(updated);
        }
      },
      [tool, selection, applyEraserAt, cropState],
    );

    const onUp = useCallback((): void => {
      if (cropState && selection && !selection.snapshot.length) {
        setSelection(null);
        return;
      }

      if (tool === "eraser") {
        erasingRef.current = false;
        setEraserPt(null);
        return;
      }

      if (tool === "laser") {
        if (laserTimerRef.current) clearTimeout(laserTimerRef.current);
        laserTimerRef.current = setTimeout(() => {
          setLaserAlpha(0);
          setTimeout(() => {
            setLaserPts(null);
            setLaserPage(null);
            setLaserAlpha(1);
          }, 200);
        }, LASER_FADE_MS);
        return;
      }

      if (tool === "selection" && selection) {
        finalizeSelection(selection);
        return;
      }

      const cur = activeRef.current;
      if (!cur) return;
      activeRef.current = null;
      setActive(null);

      if (cur.kind === "pen") {
        const el: StrokeEl = {
          kind: "stroke",
          id: nanoid(),
          tool: cur.tool,
          color: cur.color,
          width: cur.width,
          opacity: cur.opacity,
          strokeStyle: cur.strokeStyle,
          points: [...cur.points],
          pageIndex: cur.pageIndex,
        };
        pushHistory({ id: nanoid(), removed: [], added: [el], updated: [] });
        setElements((prev) => [...prev, el]);
        const sync = toSyncEl(el);
        if (sync) broadcastElement({ add: sync });
      } else if (cur.kind === "shape") {
        const el: ShapeEl = {
          kind: "shape",
          id: nanoid(),
          shape: cur.shape,
          color: cur.color,
          width: cur.width,
          strokeStyle: cur.strokeStyle,
          x: cur.start.x,
          y: cur.start.y,
          w: cur.end.x - cur.start.x,
          h: cur.end.y - cur.start.y,
          pageIndex: cur.pageIndex,
        };
        pushHistory({ id: nanoid(), removed: [], added: [el], updated: [] });
        setElements((prev) => [...prev, el]);
        const sync = toSyncEl(el);
        if (sync) broadcastElement({ add: sync });
      }
    }, [tool, selection, finalizeSelection, broadcastElement, pushHistory, cropState]);

    const commitText = useCallback((): void => {
      if (!editText) return;
      const trimmed = editText.text.trim();
      if (!trimmed) {
        setEditText(null);
        return;
      }
      if (editText.id) {
        const before = elementsRef.current.find((e) => e.id === editText.id);
        if (before?.kind === "text") {
          const after: TextEl = {
            ...before,
            text: editText.text,
            fontSize: editText.fontSize,
            bold: editText.bold,
            italic: editText.italic,
            align: editText.align,
            color: editText.color,
            w: editText.w,
            x: editText.x,
            y: editText.y,
          };
          pushHistory({
            id: nanoid(),
            removed: [],
            added: [],
            updated: [{ id: before.id, before, after }],
          });
          setElements((prev) => prev.map((e) => (e.id === before.id ? after : e)));
          const sync = toSyncEl(after);
          if (sync) broadcastElement({ add: sync });
        }
        setEditText(null);
        return;
      }
      const el: TextEl = {
        kind: "text",
        id: nanoid(),
        text: editText.text,
        color: editText.color,
        fontSize: editText.fontSize,
        bold: editText.bold,
        italic: editText.italic,
        align: editText.align,
        w: editText.w,
        x: editText.x,
        y: editText.y,
        pageIndex: editText.pageIndex,
      };
      pushHistory({ id: nanoid(), removed: [], added: [el], updated: [] });
      setElements((prev) => [...prev, el]);
      const sync = toSyncEl(el);
      if (sync) broadcastElement({ add: sync });
      setEditText(null);
    }, [editText, broadcastElement, pushHistory]);

    useEffect(() => {
      commitTextRef.current = commitText;
    }, [commitText]);

    useEffect(() => {
      if (!editText) return;
      const onDocPointerDown = (ev: PointerEvent): void => {
        const target = ev.target as Node;
        if (textareaRef.current?.contains(target)) return;
        if (document.querySelector(".text-format-bar")?.contains(target)) return;
        if (document.querySelector(".board-toolbar-root")?.contains(target)) return;
        if (document.querySelector(".lasso-action-bar")?.contains(target)) return;
        commitTextRef.current();
      };
      document.addEventListener("pointerdown", onDocPointerDown);
      return () => document.removeEventListener("pointerdown", onDocPointerDown);
    }, [editText]);

    const insertImageElement = useCallback(
      async (imageId: string, url: string): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
          const img = new Image();
          // data: URLs and same-origin mock paths don't need CORS; remote may.
          if (!url.startsWith("data:") && !url.startsWith("/")) {
            img.crossOrigin = "anonymous";
          }
          img.onerror = () => {
            console.error("[whiteboard] failed to load image for canvas:", url.slice(0, 80));
            resolve(false);
          };
          img.onload = () => {
            const maxW = PAGE_W - 80;
            const maxH = PAGE_H - 160;
            const sc = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
            const w = Math.floor(img.naturalWidth * sc);
            const h = Math.floor(img.naturalHeight * sc);
            const el: ImageEl = {
              kind: "image",
              id: imageId,
              url,
              x: PAGE_W / 2 - w / 2,
              y: 80,
              w,
              h,
              rotation: 0,
              crop: null,
              pageIndex: activePageIndex,
            };
            imgCache.current.set(el.id, img);
            pushHistory({ id: nanoid(), removed: [], added: [el], updated: [] });
            setElements((prev) => [...prev, el]);
            const sync = toSyncEl(el);
            if (sync) {
              const json = JSON.stringify({ type: BOARD_EVENT, v: PROTO_V, add: sync });
              if (json.length <= STREAM_LIMIT) broadcastElement({ add: sync });
            }
            resolve(true);
          };
          img.src = url;
        });
      },
      [activePageIndex, broadcastElement, pushHistory],
    );

    const handleImageFile = useCallback(
      async (file: File): Promise<void> => {
        try {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch("/api/upload", { method: "POST", body: formData });
          if (!res.ok) {
            console.error("[whiteboard] upload:", await res.text());
            return;
          }
          const data = (await res.json()) as { id: string; url: string };
          await insertImageElement(data.id, data.url);
        } catch (err) {
          console.error("[whiteboard] image error:", err);
        }
      },
      [insertImageElement],
    );

    /** Resolve asset URL → canvas-ready source (remote URL, mock path, or DataURL). */
    const resolveAssetImageSrc = useCallback(
      async (asset: PreLessonAssetPanelItem): Promise<string | null> => {
        if (asset.assetType === "TEXT_NOTE") {
          const text = (asset.textContent ?? "").trim() || "הערה לפני שיעור";
          const canvas = document.createElement("canvas");
          const pad = 24;
          const maxWidth = 520;
          canvas.width = maxWidth + pad * 2;
          canvas.height = 280;
          const ctx = canvas.getContext("2d");
          if (!ctx) return null;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.strokeStyle = "#c7d2fe";
          ctx.lineWidth = 2;
          ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
          ctx.fillStyle = "#312e81";
          ctx.font = "bold 18px system-ui, sans-serif";
          ctx.textAlign = "right";
          ctx.fillText("הערת טקסט לפני שיעור", canvas.width - pad, pad + 18);
          ctx.fillStyle = "#1e293b";
          ctx.font = "15px system-ui, sans-serif";
          const lines = wrapCanvasText(ctx, text, maxWidth);
          let y = pad + 52;
          for (const line of lines.slice(0, 10)) {
            ctx.fillText(line, canvas.width - pad, y);
            y += 22;
          }
          return canvas.toDataURL("image/png");
        }

        if (asset.assetType === "PDF" && asset.assetUrl) {
          const canvas = document.createElement("canvas");
          canvas.width = 480;
          canvas.height = 200;
          const ctx = canvas.getContext("2d");
          if (!ctx) return asset.assetUrl;
          ctx.fillStyle = "#f8fafc";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.strokeStyle = "#e2e8f0";
          ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
          ctx.fillStyle = "#0f172a";
          ctx.font = "bold 20px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("מסמך PDF", canvas.width / 2, 70);
          ctx.font = "13px system-ui, sans-serif";
          ctx.fillStyle = "#475569";
          const label =
            asset.assetUrl.length > 60
              ? `${asset.assetUrl.slice(0, 57)}…`
              : asset.assetUrl;
          ctx.fillText(label, canvas.width / 2, 110);
          ctx.fillStyle = "#4f46e5";
          ctx.fillText("הוכנס מהחומרים לפני השיעור", canvas.width / 2, 150);
          return canvas.toDataURL("image/png");
        }

        const url = asset.assetUrl?.trim();
        if (!url) return null;

        // Already a DataURL or local mock storage path — use directly.
        if (url.startsWith("data:") || url.startsWith("/uploads/")) {
          return url;
        }

        // Prefer remote URL; if load will fail CORS, try fetch→DataURL fallback.
        try {
          const res = await fetch(url, { mode: "cors" });
          if (res.ok) {
            const blob = await res.blob();
            if (blob.type.startsWith("image/")) {
              return await blobToDataUrl(blob);
            }
          }
        } catch {
          // Cloud storage may be unavailable — fall through to raw URL / mock.
        }

        return url;
      },
      [],
    );

    const insertPreLessonAsset = useCallback(
      async (asset: PreLessonAssetPanelItem): Promise<void> => {
        setInsertingAssetId(asset.id);
        try {
          const src = await resolveAssetImageSrc(asset);
          if (!src) {
            setAiHint("לא ניתן להזריק את הנכס ללוח — חסר URL או תוכן");
            return;
          }
          const ok = await insertImageElement(`asset_${asset.id}_${nanoid(6)}`, src);
          setAiHint(
            ok
              ? "החומר לפני השיעור הוזרק ללוח A4"
              : "הזרקה ללוח נכשלה — בדוק את קישור הקובץ",
          );
        } catch (err) {
          console.error("[whiteboard] insert PreLessonAsset:", err);
          setAiHint("שגיאה בהזרקת החומר ללוח");
        } finally {
          setInsertingAssetId(null);
        }
      },
      [insertImageElement, resolveAssetImageSrc],
    );

    useEffect(() => {
      if (!packageId) {
        setPreLessonAssets([]);
        return;
      }
      let cancelled = false;
      setAssetsLoading(true);
      fetch(`/api/packages/${packageId}/assets`)
        .then(async (res) => {
          if (!res.ok) throw new Error("assets fetch failed");
          const data = (await res.json()) as {
            assets?: PreLessonAssetPanelItem[];
          };
          if (cancelled) return;
          const all = data.assets ?? [];
          // Prefer assets bound to this lesson, then package-wide (no lessonId).
          const filtered = lessonId
            ? all.filter((a) => !a.lessonId || a.lessonId === lessonId)
            : all;
          setPreLessonAssets(filtered);
          if (filtered.length > 0) setAssetsPanelOpen(true);
        })
        .catch((err: unknown) => {
          console.error("[whiteboard] PreLessonAsset load:", err);
          if (!cancelled) setPreLessonAssets([]);
        })
        .finally(() => {
          if (!cancelled) setAssetsLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [packageId, lessonId]);

    const commitCrop = useCallback((): void => {
      if (!cropState) return;
      const imgEl = elementsRef.current.find(
        (e): e is ImageEl => e.kind === "image" && e.id === cropState.imageId,
      );
      if (!imgEl) {
        setCropState(null);
        return;
      }
      const img = imgCache.current.get(imgEl.id);
      if (!img?.complete) return;
      const before = imgEl;
      const crop = displayCropToSource(imgEl, cropState.frame, img);
      const after: ImageEl = { ...imgEl, crop };
      pushHistory({
        id: nanoid(),
        removed: [],
        added: [],
        updated: [{ id: before.id, before, after }],
      });
      setElements((prev) => prev.map((e) => (e.id === after.id ? after : e)));
      const sync = toSyncEl(after);
      if (sync) broadcastElement({ add: sync });
      setCropState(null);
    }, [cropState, broadcastElement, pushHistory]);

    const rotateSelectedImage = useCallback(
      (angleDeltaRad: number = Math.PI / 2): void => {
        const sel = selectedRef.current;
        if (sel.size !== 1) return;
        const imgEl = elementsRef.current.find(
          (e): e is ImageEl => e.kind === "image" && sel.has(e.id),
        );
        if (!imgEl) return;
        const before = imgEl;
        const nextRotation = (imgEl.rotation + angleDeltaRad) % (Math.PI * 2);
        const after: ImageEl = { ...imgEl, rotation: nextRotation };
        pushHistory({
          id: nanoid(),
          removed: [],
          added: [],
          updated: [{ id: before.id, before, after }],
        }, true);
        setElements((prev) => prev.map((e) => (e.id === after.id ? after : e)));
        const sync = toSyncEl(after);
        if (sync) broadcastElement({ add: sync });
      },
      [broadcastElement, pushHistory],
    );

    const toggleCropMode = useCallback((): void => {
      if (cropState) {
        commitCrop();
        return;
      }
      if (selectedRef.current.size !== 1) return;
      const imgEl = elementsRef.current.find(
        (e): e is ImageEl => e.kind === "image" && selectedRef.current.has(e.id),
      );
      if (!imgEl) return;
      const img = imgCache.current.get(imgEl.id);
      const frame = img?.complete
        ? sourceCropToDisplay(imgEl, img)
        : { x: imgEl.x, y: imgEl.y, w: imgEl.w, h: imgEl.h };
      setCropState({ imageId: imgEl.id, pageIndex: imgEl.pageIndex, frame });
    }, [cropState, commitCrop]);

    const onDblClick = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>, pageIndex: number): void => {
        const r = e.currentTarget.getBoundingClientRect();
        const pt: Point = {
          x: (e.clientX - r.left) / zoomRef.current,
          y: (e.clientY - r.top) / zoomRef.current,
        };
        const hit = [...elementsRef.current]
          .filter((el) => el.pageIndex === pageIndex && el.kind === "text")
          .reverse()
          .find((el) => {
            const b = elBounds(el);
            return b ? ptInBounds(pt, b) : false;
          });
        if (hit?.kind === "text") {
          setEditText({
            pageIndex,
            x: hit.x,
            y: hit.y,
            text: hit.text,
            id: hit.id,
            fontSize: hit.fontSize,
            bold: hit.bold,
            italic: hit.italic,
            align: hit.align,
            color: hit.color,
            w: hit.w,
          });
          setTool("text");
        }
      },
      [],
    );

    const addPage = useCallback((): void => {
      setPages((prev) => {
        const next = [...prev, { id: nanoid(), pageNumber: prev.length + 1 }];
        broadcastElement({ pageCount: next.length });
        return next;
      });
    }, [broadcastElement]);

    const copySelection = useCallback((): void => {
      const sel = selectedRef.current;
      if (sel.size === 0) return;
      clipboardRef.current = elementsRef.current.filter((el) => sel.has(el.id));
    }, []);

    const pasteClipboard = useCallback((): void => {
      if (clipboardRef.current.length === 0) return;
      const pasted = clipboardRef.current.map((el) =>
        cloneEl(el, activePageIndex, PASTE_OFFSET),
      );
      pushHistory({ id: nanoid(), removed: [], added: pasted, updated: [] });
      setElements((prev) => [...prev, ...pasted]);
      setSelectedIds(new Set(pasted.map((p) => p.id)));
      pasted.forEach((el) => {
        if (el.kind === "image") ensureImageInCache(el, imgCache.current);
        const sync = toSyncEl(el);
        if (sync) {
          const json = JSON.stringify({ type: BOARD_EVENT, v: PROTO_V, add: sync });
          if (json.length <= STREAM_LIMIT) broadcastElement({ add: sync });
        }
      });
    }, [activePageIndex, broadcastElement, pushHistory]);

    const deleteSelection = useCallback((): void => {
      const ids = [...selectedRef.current];
      if (ids.length) removeElements(ids);
    }, [removeElements]);

    const syncElements = useCallback(
      (els: DrawEl[]): void => {
        els.forEach((el) => {
          const sync = toSyncEl(el);
          if (sync) broadcastElement({ add: sync });
        });
      },
      [broadcastElement],
    );

    const cutSelection = useCallback((): void => {
      copySelection();
      deleteSelection();
    }, [copySelection, deleteSelection]);

    const duplicateSelection = useCallback((): void => {
      const sel = selectedRef.current;
      if (sel.size === 0) return;
      const duped = elementsRef.current
        .filter((el) => sel.has(el.id))
        .map((el) => cloneEl(el, el.pageIndex, DUPLICATE_OFFSET));
      pushHistory({ id: nanoid(), removed: [], added: duped, updated: [] }, true);
      setElements((prev) => [...prev, ...duped]);
      setSelectedIds(new Set(duped.map((d) => d.id)));
      duped.forEach((el) => {
        if (el.kind === "image") ensureImageInCache(el, imgCache.current);
      });
      syncElements(duped);
    }, [pushHistory, syncElements]);

    const cleanUpSelection = useCallback((): void => {
      const sel = selectedRef.current;
      if (sel.size === 0) return;
      const removed: DrawEl[] = [];
      const added: DrawEl[] = [];
      for (const el of elementsRef.current) {
        if (!sel.has(el.id) || el.kind !== "stroke") continue;
        const shape = cleanUpStroke(el);
        if (shape) {
          removed.push(el);
          added.push(shape);
        }
      }
      if (added.length === 0) {
        setAiHint("לא נמצאו קווים להמרה לצורות");
        return;
      }
      pushHistory({ id: nanoid(), removed, added, updated: [] }, true);
      const rmSet = new Set(removed.map((e) => e.id));
      setElements((prev) => [...prev.filter((e) => !rmSet.has(e.id)), ...added]);
      setSelectedIds(new Set(added.map((e) => e.id)));
      removed.forEach((e) => broadcastElement({ remove: [e.id] }));
      syncElements(added);
    }, [broadcastElement, pushHistory, syncElements]);

    const aiRecognizeSelection = useCallback((): void => {
      const sel = selectedRef.current;
      if (sel.size === 0) return;
      const selected = elementsRef.current.filter((e) => sel.has(e.id));
      const textParts = selected
        .filter((e): e is TextEl => e.kind === "text")
        .map((e) => e.text.trim())
        .filter(Boolean);
      const strokeCount = selected.filter((e) => e.kind === "stroke").length;
      const shapeCount = selected.filter((e) => e.kind === "shape").length;
      if (textParts.length > 0) {
        setAiHint(`טקסט: ${textParts.join(" · ")}`);
      } else if (strokeCount + shapeCount > 0) {
        setAiHint(
          `זוהו ${strokeCount} משיכות ו-${shapeCount} צורות — OCR מתמטי יתווסף בגרסה הבאה`,
        );
      } else {
        setAiHint("אין טקסט או משיכות לזיהוי בבחירה");
      }
    }, []);

    const enterTransformMode = useCallback((): void => {
      if (selectedRef.current.size === 0) return;
      setTool("selection");
      setTransformMode(true);
    }, []);

    const recolorSelection = useCallback(
      (newColor: string): void => {
        const sel = selectedRef.current;
        if (sel.size === 0) return;
        const updated: HistoryUpdate[] = [];
        const afterList: DrawEl[] = [];
        setElements((prev) =>
          prev.map((el) => {
            if (!sel.has(el.id)) return el;
            const after = recolorElement(el, newColor);
            if (!after) return el;
            updated.push({ id: el.id, before: el, after });
            afterList.push(after);
            return after;
          }),
        );
        if (updated.length > 0) {
          pushHistory({ id: nanoid(), removed: [], added: [], updated }, true);
          syncElements(afterList);
        }
        setShowRecolorPicker(false);
      },
      [pushHistory, syncElements],
    );

    const bringSelectionToFront = useCallback((): void => {
      const sel = selectedRef.current;
      if (sel.size === 0) return;
      const after = bringIdsToFront(elementsRef.current, sel);
      setElements(after);
      const pages = new Set(
        elementsRef.current.filter((e) => sel.has(e.id)).map((e) => e.pageIndex),
      );
      for (const pageIndex of pages) {
        const ids = after.filter((e) => e.pageIndex === pageIndex).map((e) => e.id);
        broadcastElement({ layerOrder: { pageIndex, ids } });
      }
    }, [broadcastElement]);

    const sendSelectionToBack = useCallback((): void => {
      const sel = selectedRef.current;
      if (sel.size === 0) return;
      const after = sendIdsToBack(elementsRef.current, sel);
      setElements(after);
      const pages = new Set(
        elementsRef.current.filter((e) => sel.has(e.id)).map((e) => e.pageIndex),
      );
      for (const pageIndex of pages) {
        const ids = after.filter((e) => e.pageIndex === pageIndex).map((e) => e.id);
        broadcastElement({ layerOrder: { pageIndex, ids } });
      }
    }, [broadcastElement]);

    const cutEditText = useCallback((): void => {
      if (!editText?.id) {
        setEditText(null);
        return;
      }
      const el = elementsRef.current.find((e) => e.id === editText.id);
      if (el) clipboardRef.current = [el];
      removeElements([editText.id]);
      setEditText(null);
    }, [editText, removeElements]);

    const duplicateEditText = useCallback((): void => {
      if (!editText || !editText.text.trim()) return;
      const el: TextEl = {
        kind: "text",
        id: nanoid(),
        text: editText.text,
        color: editText.color,
        fontSize: editText.fontSize,
        bold: editText.bold,
        italic: editText.italic,
        align: editText.align,
        w: editText.w,
        x: editText.x + PASTE_OFFSET,
        y: editText.y + PASTE_OFFSET,
        pageIndex: editText.pageIndex,
      };
      pushHistory({ id: nanoid(), removed: [], added: [el], updated: [] });
      setElements((prev) => [...prev, el]);
      setSelectedIds(new Set([el.id]));
      syncElements([el]);
    }, [editText, pushHistory, syncElements]);

    const deleteEditText = useCallback((): void => {
      if (editText?.id) removeElements([editText.id]);
      setEditText(null);
    }, [editText, removeElements]);

    const onContextMenu = useCallback((e: React.MouseEvent): void => {
      e.preventDefault();
    }, []);

    useEffect(() => {
      const onKey = (e: KeyboardEvent): void => {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key === "c") {
          e.preventDefault();
          copySelection();
        } else if (mod && e.key === "x") {
          e.preventDefault();
          if (editText) cutEditText();
          else cutSelection();
        } else if (mod && e.key === "v") {
          e.preventDefault();
          pasteClipboard();
        } else if (mod && e.key === "d") {
          e.preventDefault();
          if (editText) duplicateEditText();
          else duplicateSelection();
        } else if (mod && e.key === "z" && e.shiftKey) {
          e.preventDefault();
          performRedo();
        } else if (mod && e.key === "z") {
          e.preventDefault();
          performUndo();
        } else if (e.key === "Delete" || e.key === "Backspace") {
          if (editText) return;
          e.preventDefault();
          deleteSelection();
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [
      copySelection,
      pasteClipboard,
      deleteSelection,
      cutSelection,
      cutEditText,
      duplicateSelection,
      duplicateEditText,
      editText,
      performUndo,
      performRedo,
    ]);

    useImperativeHandle(ref, () => ({
      exportBoardToPdf: async (lessonId?: string): Promise<Blob | string | null> => {
        // Render every A4 page at full resolution (794 × 1123 px).
        const frames: ExportFrame[] = pages
          .map((page, idx) => {
            const off = document.createElement("canvas");
            off.width = PAGE_W;
            off.height = PAGE_H;
            const ctx = off.getContext("2d");
            if (!ctx)
              return { pageNumber: page.pageNumber, width: PAGE_W, height: PAGE_H, dataUrl: "" };

            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, PAGE_W, PAGE_H);
            ctx.strokeStyle = "#e2e8f0";
            ctx.lineWidth = 0.5;
            for (let x = 0; x <= PAGE_W; x += 20) {
              ctx.beginPath();
              ctx.moveTo(x, 0);
              ctx.lineTo(x, PAGE_H);
              ctx.stroke();
            }
            for (let y = 0; y <= PAGE_H; y += 20) {
              ctx.beginPath();
              ctx.moveTo(0, y);
              ctx.lineTo(PAGE_W, y);
              ctx.stroke();
            }

            for (const el of elements) {
              if (el.pageIndex !== idx) continue;
              if (el.kind === "stroke")
                paintSmoothStroke(ctx, el.points, el.color, el.width, el.opacity, el.tool === "highlighter", el.strokeStyle);
              else if (el.kind === "shape") paintShape(ctx, el);
              else if (el.kind === "text") paintText(ctx, el);
              else if (el.kind === "image") {
                const img = imgCache.current.get(el.id);
                if (img?.complete && img.naturalWidth > 0) paintImage(ctx, img, el);
              }
            }
            return {
              pageNumber: page.pageNumber,
              width: PAGE_W,
              height: PAGE_H,
              dataUrl: off.toDataURL("image/png"),
            };
          })
          .filter((f) => f.dataUrl !== "");

        if (frames.length === 0) return null;

        try {
          const body = lessonId ? { frames, lessonId } : { frames };
          const res = await fetch("/api/excalidraw/export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

          if (!res.ok) {
            console.error("[whiteboard] export:", await res.text());
            return null;
          }

          // When lessonId is provided, the API returns JSON with a storage URL.
          if (lessonId) {
            const data = (await res.json()) as { success: boolean; url?: string | null };
            return data.url ?? null;
          }

          // Legacy path: return raw PDF blob for direct download.
          return res.blob();
        } catch (err) {
          console.error("[whiteboard] export:", err);
          return null;
        }
      },
      exportBoardToPng: async (pageIndex: number = activePageIndex): Promise<void> => {
        const targetPage = pages[pageIndex] ?? pages[0];
        if (!targetPage) return;
        const off = document.createElement("canvas");
        off.width = PAGE_W;
        off.height = PAGE_H;
        const ctx = off.getContext("2d");
        if (!ctx) return;

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, PAGE_W, PAGE_H);
        ctx.strokeStyle = "#e2e8f0";
        ctx.lineWidth = 0.5;
        for (let x = 0; x <= PAGE_W; x += 20) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, PAGE_H);
          ctx.stroke();
        }
        for (let y = 0; y <= PAGE_H; y += 20) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(PAGE_W, y);
          ctx.stroke();
        }

        for (const el of elements) {
          if (el.pageIndex !== pageIndex) continue;
          if (el.kind === "stroke")
            paintSmoothStroke(ctx, el.points, el.color, el.width, el.opacity, el.tool === "highlighter", el.strokeStyle);
          else if (el.kind === "shape") paintShape(ctx, el);
          else if (el.kind === "text") paintText(ctx, el);
          else if (el.kind === "image") {
            const img = imgCache.current.get(el.id);
            if (img?.complete && img.naturalWidth > 0) paintImage(ctx, img, el);
          }
        }

        const dataUrl = off.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `whiteboard-page-${pageIndex + 1}.png`;
        a.click();
      },
    }));

    const exportPdfDirect = useCallback(async (): Promise<void> => {
      const frames: ExportFrame[] = pages
        .map((page, idx) => {
          const off = document.createElement("canvas");
          off.width = PAGE_W;
          off.height = PAGE_H;
          const ctx = off.getContext("2d");
          if (!ctx) return { pageNumber: page.pageNumber, width: PAGE_W, height: PAGE_H, dataUrl: "" };
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, PAGE_W, PAGE_H);
          ctx.strokeStyle = "#e2e8f0";
          ctx.lineWidth = 0.5;
          for (let x = 0; x <= PAGE_W; x += 20) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, PAGE_H);
            ctx.stroke();
          }
          for (let y = 0; y <= PAGE_H; y += 20) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(PAGE_W, y);
            ctx.stroke();
          }
          for (const el of elements) {
            if (el.pageIndex !== idx) continue;
            if (el.kind === "stroke")
              paintSmoothStroke(ctx, el.points, el.color, el.width, el.opacity, el.tool === "highlighter", el.strokeStyle);
            else if (el.kind === "shape") paintShape(ctx, el);
            else if (el.kind === "text") paintText(ctx, el);
            else if (el.kind === "image") {
              const img = imgCache.current.get(el.id);
              if (img?.complete && img.naturalWidth > 0) paintImage(ctx, img, el);
            }
          }
          return { pageNumber: page.pageNumber, width: PAGE_W, height: PAGE_H, dataUrl: off.toDataURL("image/png") };
        })
        .filter((f) => f.dataUrl !== "");
      if (frames.length === 0) return;
      try {
        const res = await fetch("/api/excalidraw/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ frames }),
        });
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `whiteboard-${new Date().toISOString().slice(0, 10)}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("[whiteboard] export pdf error:", err);
      }
    }, [elements, pages]);

    const exportPngDirect = useCallback((): void => {
      const pageIndex = activePageIndex;
      const off = document.createElement("canvas");
      off.width = PAGE_W;
      off.height = PAGE_H;
      const ctx = off.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, PAGE_W, PAGE_H);
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 0.5;
      for (let x = 0; x <= PAGE_W; x += 20) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, PAGE_H);
        ctx.stroke();
      }
      for (let y = 0; y <= PAGE_H; y += 20) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(PAGE_W, y);
        ctx.stroke();
      }
      for (const el of elements) {
        if (el.pageIndex !== pageIndex) continue;
        if (el.kind === "stroke")
          paintSmoothStroke(ctx, el.points, el.color, el.width, el.opacity, el.tool === "highlighter", el.strokeStyle);
        else if (el.kind === "shape") paintShape(ctx, el);
        else if (el.kind === "text") paintText(ctx, el);
        else if (el.kind === "image") {
          const img = imgCache.current.get(el.id);
          if (img?.complete && img.naturalWidth > 0) paintImage(ctx, img, el);
        }
      }
      const dataUrl = off.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `whiteboard-page-${pageIndex + 1}.png`;
      a.click();
    }, [activePageIndex, elements]);

    const syncLabel = !streamChannel
      ? "לוח מקומי"
      : syncStatus === "live"
        ? "מסונכרן"
        : syncStatus === "error"
          ? "שגיאה"
          : "מתחבר";

    const GRID_CSS = {
      backgroundColor: "#ffffff",
      backgroundImage:
        "linear-gradient(to right, #f1f5f9 1px, transparent 1px)," +
        "linear-gradient(to bottom, #f1f5f9 1px, transparent 1px)",
      backgroundSize: "24px 24px",
    } as const;

    const AddPageButton = ({ className }: { className: string }) => (
      <button
        type="button"
        title="הוסף עמוד A4"
        onClick={addPage}
        className={className}
      >
        + הוסף עמוד
      </button>
    );

    const singleImageSelected =
      selectedIds.size === 1 &&
      elements.some((e) => selectedIds.has(e.id) && e.kind === "image");

    const editTextBounds = editText
      ? textElBounds({
          kind: "text",
          id: editText.id ?? "draft",
          text: editText.text || " ",
          color: editText.color,
          fontSize: editText.fontSize,
          bold: editText.bold,
          italic: editText.italic,
          align: editText.align,
          w: editText.w,
          x: editText.x,
          y: editText.y,
          pageIndex: editText.pageIndex,
        })
      : null;

    const ActionChip = ({
      title,
      onClick,
      children,
      variant = "default",
    }: {
      title: string;
      onClick: () => void;
      children: React.ReactNode;
      variant?: "default" | "danger" | "active";
    }) => (
      <button
        type="button"
        title={title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-sm transition-all ${
          variant === "danger"
            ? "text-red-600 hover:bg-red-50"
            : variant === "active"
              ? "bg-neutral-900 text-white ring-1 ring-neutral-900"
              : "text-neutral-600 hover:bg-neutral-100"
        }`}
      >
        {children}
      </button>
    );

    const Popover = ({
      children,
      width,
    }: {
      children: React.ReactNode;
      width?: number;
    }) => (
      <div
        className="tool-flyout absolute top-full left-1/2 -translate-x-1/2 mt-2 z-[60]"
        dir="rtl"
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span
          aria-hidden
          className="absolute -top-1 left-1/2 -translate-x-1/2 w-2.5 h-2.5 rotate-45 bg-white/95 border-s border-t border-neutral-200/80"
        />
        <div
          className="relative bg-white/95 border border-neutral-200/80 backdrop-blur-md shadow-sm rounded-2xl p-2 flex flex-col gap-2"
          style={width ? { width } : undefined}
        >
          {children}
        </div>
      </div>
    );

    const PenPopover = ({ penTool }: { penTool: "pen" | "highlighter" }): React.ReactElement => {
      const isHl = penTool === "highlighter";
      const currentMm = isHl ? hlWidthMm : widthMm;
      const setMm = isHl ? setHlWidthMm : setWidthMm;
      return (
        <Popover width={168}>
          <div className="flex flex-col items-center gap-1.5">
            {WIDTH_PRESETS.map((wp, i) => (
              <button
                key={wp.mm}
                type="button"
                title={wp.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setMm(wp.mm)}
                className={`w-full h-8 rounded-xl flex items-center justify-center gap-2 transition-all ${
                  currentMm === wp.mm
                    ? "bg-neutral-100 ring-1 ring-neutral-300"
                    : "hover:bg-neutral-50"
                }`}
              >
                <span
                  className="block rounded-full bg-neutral-800"
                  style={{ width: [5, 8, 12][i], height: [5, 8, 12][i] }}
                />
                <span className="text-[13px] text-neutral-600">{wp.label}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 px-0.5">
            <input
              type="range"
              min={isHl ? 1 : 0.1}
              max={isHl ? 12 : 4}
              step={isHl ? 0.5 : 0.05}
              value={currentMm}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => setMm(parseFloat(e.target.value))}
              className={`flex-1 cursor-pointer ${isHl ? "accent-yellow-400" : "accent-emerald-400"}`}
            />
            <span className="text-[13px] text-neutral-700 w-10 text-start">
              {currentMm.toFixed(isHl ? 1 : 2)}
            </span>
          </div>
          <div className="flex gap-1">
            {STROKE_STYLES.map((ss) => (
              <button
                key={ss.value}
                type="button"
                title={ss.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setStrokeStyle(ss.value)}
                className={`flex-1 h-8 rounded-lg flex items-center justify-center text-xs transition-all ${
                  strokeStyle === ss.value
                    ? "bg-neutral-900 text-white ring-1 ring-neutral-900"
                    : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
                }`}
              >
                {ss.preview}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {PALETTE.map((c) => (
              <button
                key={c.hex}
                type="button"
                title={c.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setColor(c.hex)}
                className={`w-5 h-5 rounded-full border-2 transition-all hover:scale-110 ${
                  color === c.hex ? "border-neutral-900 scale-110" : "border-transparent opacity-80"
                }`}
                style={{ background: c.hex }}
              />
            ))}
            <label
              className="relative w-5 h-5 rounded-full overflow-hidden cursor-pointer border border-neutral-300"
              title="צבע מותאם"
            >
              <span
                className="absolute inset-0 rounded-full"
                style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)" }}
              />
              <input
                type="color"
                value={color}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => setColor(e.target.value)}
                className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
              />
            </label>
          </div>
        </Popover>
      );
    };

    const EraserPopover = (): React.ReactElement => (
      <Popover width={160}>
        <div className="flex flex-col gap-1">
          {ERASER_SIZE_PRESETS.map((preset) => (
            <button
              key={preset.diameter}
              type="button"
              title={preset.title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setEraserDiameter(preset.diameter)}
              className={`h-8 px-2 rounded-lg flex items-center gap-2 transition-all ${
                eraserDiameter === preset.diameter
                  ? "bg-neutral-100 ring-1 ring-neutral-300"
                  : "hover:bg-neutral-50"
              }`}
            >
              <span
                className="block rounded-full border border-blue-400/70 bg-white/30 shrink-0"
                style={{
                  width: Math.max(4, preset.diameter / 2.2),
                  height: Math.max(4, preset.diameter / 2.2),
                }}
              />
              <span className="text-[14px] text-neutral-700">{preset.label}</span>
              <span className="text-[12px] text-neutral-400 ms-auto">{preset.diameter}px</span>
            </button>
          ))}
        </div>
        <div className="h-px bg-neutral-200" />
        <div className="flex flex-col gap-1">
          {(["stroke", "pixel"] as EraserMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setEraserMode(m)}
              className={`h-8 px-2 rounded-lg text-[14px] font-bold text-start transition-all ${
                eraserMode === m
                  ? "bg-neutral-900 text-white ring-1 ring-neutral-900"
                  : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
              }`}
            >
              {m === "stroke" ? "מחיקת משיכה שלמה" : "מחיקת פיקסל מדויקת"}
            </button>
          ))}
        </div>
      </Popover>
    );

    const SelectionPopover = (): React.ReactElement => (
      <Popover width={150}>
        <div className="flex flex-col gap-1">
          {(
            [
              { value: "rect" as LassoStyle, icon: "▭", label: "בחירה מלבנית" },
              { value: "free" as LassoStyle, icon: "✦", label: "לאסו חופשי" },
            ] as const
          ).map((ls) => (
            <button
              key={ls.value}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setLassoStyle(ls.value)}
              className={`h-8 px-2 rounded-lg flex items-center gap-2 text-[14px] font-bold transition-all ${
                lassoStyle === ls.value
                  ? "bg-neutral-900 text-white ring-1 ring-neutral-900"
                  : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
              }`}
            >
              <span className="text-sm">{ls.icon}</span>
              {ls.label}
            </button>
          ))}
        </div>
      </Popover>
    );

    const ShapesPopover = (): React.ReactElement => (
      <Popover>
        <div className="flex flex-col gap-1">
          {SHAPES.map((s) => (
            <button
              key={s.kind}
              type="button"
              title={s.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setShapeKind(s.kind);
                setTool("shapes");
                setOpenMenu(null);
              }}
              className={`w-10 h-9 rounded-lg flex items-center justify-center text-base transition-all ${
                shapeKind === s.kind && tool === "shapes"
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
              }`}
            >
              {s.icon}
            </button>
          ))}
        </div>
      </Popover>
    );

    const handleToolClick = (t: DrawTool): void => {
      if (t === "image") {
        fileInputRef.current?.click();
        setOpenMenu(null);
        return;
      }
      if (
        t === "selection" ||
        t === "pen" ||
        t === "highlighter" ||
        t === "eraser" ||
        t === "shapes"
      ) {
        setTool(t);
        setOpenMenu((prev) => (prev === t ? null : t));
        return;
      }
      setTool(t);
      setOpenMenu(null);
    };

    return (
      <div
        ref={containerRef}
        className="relative w-full h-full overflow-hidden overflow-x-hidden"
        dir="ltr"
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          className="board-toolbar-root absolute top-3 z-50 pointer-events-none"
          style={{ left: "50%", transform: "translateX(-50%)", width: PAGE_W, maxWidth: "calc(100% - 16px)" }}
        >
        <Draggable nodeRef={toolbarRef} handle=".toolbar-drag-handle" bounds="parent">
          <div
            ref={toolbarRef}
            className="pointer-events-auto flex justify-between items-center px-6 py-2.5 rounded-2xl border border-neutral-200/80 shadow-sm select-none bg-white/80 backdrop-blur-md"
            style={{ width: PAGE_W, maxWidth: "100%" }}
            dir="rtl"
          >
            {/* Tools group */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="toolbar-drag-handle w-5 h-9 flex items-center justify-center text-neutral-400 hover:text-neutral-700 cursor-grab active:cursor-grabbing text-xs shrink-0"
                title="גרור סרגל"
              >
                ⠿
              </button>
              {(
                ["selection", "pen", "highlighter", "eraser", "shapes", "text", "image", "laser"] as DrawTool[]
              ).map((t) => {
                const hasMenu =
                  t === "selection" ||
                  t === "pen" ||
                  t === "highlighter" ||
                  t === "eraser" ||
                  t === "shapes";
                const menuOpen = hasMenu && openMenu === t;
                return (
                  <div key={t} className="relative shrink-0">
                    <button
                      type="button"
                      title={TOOL_META[t].label}
                      onClick={() => handleToolClick(t)}
                      className={`w-9 h-9 rounded-xl flex items-center justify-center text-base transition-all ${
                        tool === t
                          ? "bg-neutral-900 text-white shadow-md scale-105"
                          : menuOpen
                            ? "bg-neutral-100 text-neutral-900 ring-1 ring-neutral-300"
                            : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
                      }`}
                    >
                      {TOOL_META[t].icon}
                    </button>
                    {menuOpen && t === "selection" && <SelectionPopover />}
                    {menuOpen && t === "pen" && <PenPopover penTool="pen" />}
                    {menuOpen && t === "highlighter" && <PenPopover penTool="highlighter" />}
                    {menuOpen && t === "eraser" && <EraserPopover />}
                    {menuOpen && t === "shapes" && <ShapesPopover />}
                  </div>
                );
              })}
            </div>

            {/* Undo / Redo group */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                title="Undo (Cmd+Z)"
                disabled={undoStack.length === 0}
                onClick={performUndo}
                className="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center text-base text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 disabled:opacity-30 disabled:pointer-events-none transition-all"
              >
                ↩
              </button>
              <button
                type="button"
                title="Redo (Cmd+Shift+Z)"
                disabled={redoStack.length === 0}
                onClick={performRedo}
                className="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center text-base text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 disabled:opacity-30 disabled:pointer-events-none transition-all"
              >
                ↪
              </button>
            </div>

            {/* Actions group */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                title="הוסף עמוד A4"
                onClick={addPage}
                className="h-8 px-2.5 shrink-0 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-1 transition-all shadow-sm active:scale-95"
              >
                <span className="text-sm leading-none">+</span>
                <span className="text-[14px] font-semibold">A4</span>
              </button>

              <div className="h-4 w-px bg-neutral-200 mx-0.5" />

              <button
                type="button"
                title="ייצוא כל העמודים לקובץ PDF"
                onClick={exportPdfDirect}
                className="h-8 px-2.5 shrink-0 rounded-full bg-white hover:bg-neutral-50 text-neutral-700 border border-neutral-200 text-xs font-medium flex items-center gap-1.5 transition-all shadow-sm active:scale-95"
              >
                <span className="text-[14px]">PDF</span>
              </button>

              <button
                type="button"
                title="ייצוא העמוד הנוכחי לתמונת PNG"
                onClick={exportPngDirect}
                className="h-8 px-2.5 shrink-0 rounded-full bg-white hover:bg-neutral-50 text-neutral-700 border border-neutral-200 text-xs font-medium flex items-center gap-1.5 transition-all shadow-sm active:scale-95"
              >
                <span className="text-[14px]">PNG</span>
              </button>

              <span title={syncLabel} className="shrink-0 flex items-center ms-1">
                <span
                  className={`block w-2 h-2 rounded-full ${
                    syncStatus === "live"
                      ? "bg-emerald-400 animate-pulse"
                      : syncStatus === "error"
                        ? "bg-red-400"
                        : "bg-neutral-400"
                  }`}
                />
              </span>
            </div>
          </div>
        </Draggable>
        </div>

        {/* Side add-page button */}
        <AddPageButton className="absolute top-1/2 end-4 -translate-y-1/2 z-40 px-3 py-2 rounded-full bg-emerald-600/90 hover:bg-emerald-500 text-white text-xs font-bold shadow-xl backdrop-blur transition-all" />

        {/* Scrollable notebook */}
        <div
          ref={scrollRef}
          className="w-full h-full overflow-y-auto overflow-x-hidden overscroll-x-none"
          style={{ background: DESK_BG, touchAction: "pan-y" }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            className="flex flex-col items-center w-full max-w-full"
            style={{
              paddingTop: 60 + PAGE_GAP,
              paddingBottom: PAGE_GAP * 4,
              gap: PAGE_GAP,
              transformOrigin: "top center",
              transform: `scale(${zoom})`,
            }}
          >
            {pages.map((page, idx) => (
              <div key={page.id} className="flex flex-col items-center">
                <div
                  className="relative rounded-lg shadow-sm overflow-hidden border border-neutral-200"
                  style={{ width: PAGE_W, height: PAGE_H, ...GRID_CSS }}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  <canvas
                    ref={(el) => {
                      if (el) canvasMap.current.set(page.id, el);
                      else canvasMap.current.delete(page.id);
                    }}
                    style={{
                      display: "block",
                      position: "absolute",
                      inset: 0,
                      width: PAGE_W,
                      height: PAGE_H,
                      cursor: canvasCursor,
                      touchAction: "none",
                    }}
                    onPointerDown={(e) => onDown(e, idx)}
                    onPointerMove={(e) => onMove(e, idx)}
                    onPointerUp={onUp}
                    onPointerCancel={onUp}
                    onPointerLeave={() => {
                      setCursorPt(null);
                      setEraserPt(null);
                    }}
                    onDoubleClick={(e) => onDblClick(e, idx)}
                    onContextMenu={onContextMenu}
                  />

                  {(() => {
                    const pageSelected = elements.some(
                      (e) => e.pageIndex === idx && selectedIds.has(e.id),
                    );
                    const selBounds = pageSelected
                      ? groupBoundsFor(elements, selectedIds)
                      : null;
                    const pageHasImage =
                      singleImageSelected &&
                      elements.some(
                        (e) =>
                          e.pageIndex === idx &&
                          selectedIds.has(e.id) &&
                          e.kind === "image",
                      );
                    if (!selBounds || editText) return null;
                    return (
                      <>
                      <div
                        className="lasso-action-bar absolute z-40 flex flex-col items-center gap-1.5 pointer-events-auto"
                        style={{
                          left: selBounds.x + selBounds.w / 2,
                          top: Math.max(8, selBounds.y - 56),
                          transform: "translateX(-50%)",
                        }}
                        onContextMenu={(e) => e.preventDefault()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <div
                          className="flex items-center gap-0.5 px-2.5 py-1.5 rounded-full border border-neutral-200/80 shadow-sm"
                          style={{
                            background: "rgba(255,255,255,0.92)",
                            backdropFilter: "blur(12px)",
                          }}
                          dir="rtl"
                        >
                          <ActionChip title="יישור קווים / המרה לצורות" onClick={cleanUpSelection}>
                            🪄
                          </ActionChip>
                          <ActionChip
                            title="גלגל צבעים"
                            variant={showRecolorPicker ? "active" : "default"}
                            onClick={() => {
                              setShowRecolorPicker((p) => !p);
                              setShowLassoMore(false);
                            }}
                          >
                            🌈
                          </ActionChip>
                          <ActionChip title="זיהוי מתמטיקה וטקסט (AI)" onClick={aiRecognizeSelection}>
                            🤖
                          </ActionChip>
                          <ActionChip
                            title="טרנספורמציה — שינוי גודל וסיבוב"
                            variant={transformMode ? "active" : "default"}
                            onClick={enterTransformMode}
                          >
                            📐
                          </ActionChip>
                          <span aria-hidden className="w-px h-5 bg-neutral-200 mx-0.5" />
                          <ActionChip title="גזירה (Cmd+X)" onClick={cutSelection}>
                            ✂️
                          </ActionChip>
                          <ActionChip title="שכפול (+20px)" onClick={duplicateSelection}>
                            📑
                          </ActionChip>
                          <ActionChip title="מחק" variant="danger" onClick={deleteSelection}>
                            🗑️
                          </ActionChip>
                          <ActionChip
                            title="עוד אפשרויות"
                            variant={showLassoMore ? "active" : "default"}
                            onClick={() => {
                              setShowLassoMore((p) => !p);
                              setShowRecolorPicker(false);
                            }}
                          >
                            ⋯
                          </ActionChip>
                        </div>
                        {showRecolorPicker && (
                          <div
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-neutral-200/80 shadow-sm"
                            style={{ background: "rgba(255,255,255,0.95)", backdropFilter: "blur(12px)" }}
                            dir="rtl"
                          >
                            {PALETTE.map((c) => (
                              <button
                                key={c.hex}
                                type="button"
                                title={c.label}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => recolorSelection(c.hex)}
                                className="w-6 h-6 rounded-full border-2 border-neutral-200 hover:scale-110 transition-all"
                                style={{ background: c.hex }}
                              />
                            ))}
                            <label
                              className="relative w-6 h-6 rounded-full overflow-hidden cursor-pointer border border-neutral-300"
                              title="צבע מותאם"
                            >
                              <span
                                className="absolute inset-0 rounded-full"
                                style={{
                                  background:
                                    "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)",
                                }}
                              />
                              <input
                                type="color"
                                className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                                onChange={(e) => recolorSelection(e.target.value)}
                              />
                            </label>
                          </div>
                        )}
                        {showLassoMore && (
                          <div
                            className="flex flex-col gap-0.5 px-2 py-1.5 rounded-xl border border-neutral-200/80 shadow-sm min-w-[140px] bg-white/95"
                            style={{ background: "rgba(255,255,255,0.95)", backdropFilter: "blur(12px)" }}
                            dir="rtl"
                          >
                            <button
                              type="button"
                              className="px-2 py-1.5 text-[14px] text-neutral-700 hover:bg-neutral-100 rounded-lg text-start"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={bringSelectionToFront}
                            >
                              🔝 שכבה — קדימה
                            </button>
                            <button
                              type="button"
                              className="px-2 py-1.5 text-[14px] text-neutral-700 hover:bg-neutral-100 rounded-lg text-start"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={sendSelectionToBack}
                            >
                              ↓ שכבה — אחורה
                            </button>
                            {pageHasImage && (
                              <>
                                <button
                                  type="button"
                                  className="px-2 py-1.5 text-[14px] text-neutral-700 hover:bg-neutral-100 rounded-lg text-start flex items-center justify-between"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => rotateSelectedImage(Math.PI / 2)}
                                >
                                  <span>🔄 סובב 90° (על הצד)</span>
                                </button>
                                <button
                                  type="button"
                                  className="px-2 py-1.5 text-[14px] text-neutral-700 hover:bg-neutral-100 rounded-lg text-start"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={toggleCropMode}
                                >
                                  ✂ חיתוך תמונה
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              className="px-2 py-1.5 text-[14px] text-neutral-700 hover:bg-neutral-100 rounded-lg text-start"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={copySelection}
                            >
                              📋 העתק
                            </button>
                          </div>
                        )}
                      </div>
                      </>
                    );
                  })()}

                  {editText?.pageIndex === idx && editTextBounds && (
                    <>
                      <div
                        className="text-format-bar absolute z-30 flex items-center gap-0.5 px-1.5 py-1 rounded-full border border-neutral-200/80 shadow-sm"
                        style={{
                          left: Math.max(4, Math.min(editText.x, PAGE_W - 220)),
                          top: Math.max(4, editText.y - 44),
                          background: "rgba(255,255,255,0.92)",
                          backdropFilter: "blur(12px)",
                        }}
                        dir="rtl"
                        onMouseDown={(e) => e.preventDefault()}
                        onContextMenu={(e) => e.preventDefault()}
                      >
                        <div className="relative">
                          <button
                            type="button"
                            title="גודל פונט"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setTextMenu((p) => (p === "size" ? null : "size"))}
                            className={`h-7 px-2 rounded-full flex items-center gap-0.5 text-[14px] font-bold transition-all ${
                              textMenu === "size"
                                ? "bg-neutral-900 text-white ring-1 ring-neutral-900"
                                : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
                            }`}
                          >
                            {editText.fontSize}
                            <span className="text-[11px]">▾</span>
                          </button>
                          {textMenu === "size" && (
                            <Popover width={72}>
                              <div className="flex flex-col gap-0.5">
                                {FONT_SIZE_PRESETS.map((sz) => (
                                  <button
                                    key={sz}
                                    type="button"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => {
                                      setEditText((p) => (p ? { ...p, fontSize: sz } : null));
                                      setTextMenu(null);
                                    }}
                                    className={`h-7 rounded-lg text-[14px] font-bold transition-all ${
                                      editText.fontSize === sz
                                        ? "bg-neutral-900 text-white ring-1 ring-neutral-900"
                                        : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
                                    }`}
                                  >
                                    {sz}
                                  </button>
                                ))}
                              </div>
                            </Popover>
                          )}
                        </div>

                        <div className="relative">
                          <button
                            type="button"
                            title="יישור"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setTextMenu((p) => (p === "align" ? null : "align"))}
                            className={`w-7 h-7 rounded-full flex items-center justify-center text-[14px] transition-all ${
                              textMenu === "align"
                                ? "bg-neutral-900 text-white ring-1 ring-neutral-900"
                                : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
                            }`}
                          >
                            {editText.align === "right" ? "⇥" : editText.align === "center" ? "☰" : "⇤"}
                          </button>
                          {textMenu === "align" && (
                            <Popover width={132}>
                              <div className="flex flex-col gap-0.5">
                                {(
                                  [
                                    { align: "right" as TextAlign, icon: "⇥", label: "ימין (RTL)" },
                                    { align: "center" as TextAlign, icon: "☰", label: "מרכז" },
                                    { align: "left" as TextAlign, icon: "⇤", label: "שמאל" },
                                  ] as const
                                ).map(({ align, icon, label }) => (
                                  <button
                                    key={align}
                                    type="button"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => {
                                      setEditText((p) => (p ? { ...p, align } : null));
                                      setTextMenu(null);
                                    }}
                                    className={`h-7 px-2 rounded-lg flex items-center gap-2 text-[14px] transition-all ${
                                      editText.align === align
                                        ? "bg-neutral-900 text-white ring-1 ring-neutral-900"
                                        : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
                                    }`}
                                  >
                                    <span>{icon}</span>
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </Popover>
                          )}
                        </div>

                        <button
                          type="button"
                          title="Bold"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => setEditText((p) => (p ? { ...p, bold: !p.bold } : null))}
                          className={`w-7 h-7 rounded-full text-xs font-black transition-all ${
                            editText.bold ? "bg-neutral-900 text-white ring-1 ring-neutral-900" : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
                          }`}
                        >
                          B
                        </button>
                        <button
                          type="button"
                          title="Italic"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() =>
                            setEditText((p) => (p ? { ...p, italic: !p.italic } : null))
                          }
                          className={`w-7 h-7 rounded-full text-xs italic transition-all ${
                            editText.italic ? "bg-neutral-900 text-white ring-1 ring-neutral-900" : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
                          }`}
                        >
                          I
                        </button>

                        <div className="relative">
                          <button
                            type="button"
                            title="צבע"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setTextMenu((p) => (p === "color" ? null : "color"))}
                            className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                              textMenu === "color" ? "ring-1 ring-neutral-300 bg-neutral-100" : "hover:bg-neutral-100"
                            }`}
                          >
                            <span
                              className="w-4 h-4 rounded-full border border-neutral-300"
                              style={{ background: editText.color }}
                            />
                          </button>
                          {textMenu === "color" && (
                            <Popover width={132}>
                              <div className="grid grid-cols-5 gap-1.5">
                                {PALETTE.map((c) => (
                                  <button
                                    key={c.hex}
                                    type="button"
                                    title={c.label}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => {
                                      setEditText((p) => (p ? { ...p, color: c.hex } : null));
                                      setTextMenu(null);
                                    }}
                                    className={`w-5 h-5 rounded-full border-2 transition-all hover:scale-110 ${
                                      editText.color === c.hex ? "border-neutral-900 scale-110" : "border-transparent"
                                    }`}
                                    style={{ background: c.hex }}
                                  />
                                ))}
                                <label
                                  className="relative w-5 h-5 rounded-full overflow-hidden cursor-pointer border border-neutral-300"
                                  title="צבע מותאם"
                                >
                                  <span
                                    className="absolute inset-0 rounded-full"
                                    style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)" }}
                                  />
                                  <input
                                    type="color"
                                    value={editText.color}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onChange={(e) => {
                                      const hex = e.target.value;
                                      setEditText((p) => (p ? { ...p, color: hex } : null));
                                    }}
                                    className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                                  />
                                </label>
                              </div>
                            </Popover>
                          )}
                        </div>

                        <span className="w-px h-4 bg-neutral-200" />
                        <ActionChip title="גזור" onClick={cutEditText}>
                          ✂️
                        </ActionChip>
                        <ActionChip title="שכפל" onClick={duplicateEditText}>
                          📑
                        </ActionChip>
                        <ActionChip title="מחק" variant="danger" onClick={deleteEditText}>
                          🗑️
                        </ActionChip>
                      </div>
                      <div
                        className="absolute z-15 pointer-events-none border-2 border-blue-400/60 rounded-sm"
                        style={{
                          left: editText.x - 2,
                          top: editText.y - 2,
                          width: editText.w + 4,
                          height: editTextBounds.h + 4,
                        }}
                      />
                      {(["left", "right"] as TextWidthSide[]).map((side) => (
                        <button
                          key={side}
                          type="button"
                          aria-label={side === "left" ? "resize width left" : "resize width right"}
                          className="absolute z-25 w-2.5 h-7 rounded-full bg-blue-500 border-2 border-white shadow-md cursor-ew-resize touch-none hover:bg-blue-400 transition-colors"
                          style={{
                            left: side === "left" ? editText.x - 5 : editText.x + editText.w - 5,
                            top: editText.y + editTextBounds.h / 2 - 14,
                          }}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const orig = { ...editText };
                            const origBounds = editTextBounds;
                            const onDrag = (ev: PointerEvent): void => {
                              const canvas = canvasMap.current.get(pages[idx]?.id ?? "");
                              if (!canvas) return;
                              const r = canvas.getBoundingClientRect();
                              const pt: Point = {
                                x: (ev.clientX - r.left) / zoomRef.current,
                                y: (ev.clientY - r.top) / zoomRef.current,
                              };
                              const draft: TextEl = {
                                kind: "text",
                                id: orig.id ?? "draft",
                                text: orig.text || " ",
                                color: orig.color,
                                fontSize: orig.fontSize,
                                bold: orig.bold,
                                italic: orig.italic,
                                align: orig.align,
                                w: orig.w,
                                x: orig.x,
                                y: orig.y,
                                pageIndex: orig.pageIndex,
                              };
                              const resized = resizeTextBox(draft, side, pt, origBounds);
                              setEditText((p) =>
                                p ? { ...p, x: resized.x, w: resized.w } : null,
                              );
                            };
                            const onEnd = (): void => {
                              window.removeEventListener("pointermove", onDrag);
                              window.removeEventListener("pointerup", onEnd);
                            };
                            window.addEventListener("pointermove", onDrag);
                            window.addEventListener("pointerup", onEnd);
                          }}
                        />
                      ))}
                      <textarea
                        ref={textareaRef}
                        dir="rtl"
                        value={editText.text}
                        onChange={(e) =>
                          setEditText((prev) => (prev ? { ...prev, text: e.target.value } : null))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setEditText(null);
                        }}
                        onContextMenu={(e) => e.preventDefault()}
                        className="absolute z-20 outline-none resize-none bg-transparent overflow-hidden"
                        style={{
                          left: editText.x,
                          top: editText.y,
                          width: editText.w,
                          height: editTextBounds.h,
                          margin: 0,
                          padding: `${TEXT_PADDING}px`,
                          border: "none",
                          boxSizing: "border-box",
                          color: editText.color,
                          fontSize: `${editText.fontSize}px`,
                          fontWeight: editText.bold ? "bold" : "normal",
                          fontStyle: editText.italic ? "italic" : "normal",
                          textAlign: editText.align,
                          direction: "rtl",
                          fontFamily: TEXT_FONT_FAMILY,
                          lineHeight: TEXT_LINE_HEIGHT,
                          caretColor: editText.color,
                          wordWrap: "break-word",
                          overflowWrap: "break-word",
                          whiteSpace: "pre-wrap",
                        }}
                        rows={Math.max(1, editText.text.split("\n").length)}
                      />
                    </>
                  )}
                </div>

                <p
                  className="mt-2 text-[14px] font-bold select-none pointer-events-none"
                  style={{ color: "rgba(115,115,115,0.75)" }}
                >
                  עמוד {page.pageNumber}
                </p>
              </div>
            ))}

            {/* Bottom add-page button */}
            <AddPageButton className="px-5 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold shadow-2xl transition-all" />

            <div style={{ height: PAGE_GAP * 2 }} />
          </div>
        </div>

        {aiHint && (
          <div
            className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[60] max-w-md px-4 py-2.5 rounded-full border border-neutral-200/80 shadow-sm text-sm text-neutral-800 text-center pointer-events-none bg-white/90 backdrop-blur-md"
            dir="rtl"
          >
            {aiHint}
          </div>
        )}

        {packageId && (
          <div
            className="absolute start-3 top-16 z-[55] flex flex-col items-stretch gap-2"
            dir="rtl"
          >
            <button
              type="button"
              onClick={() => setAssetsPanelOpen((o) => !o)}
              className="self-start rounded-full border border-neutral-200/80 bg-white/80 px-3 py-2 text-xs font-bold text-neutral-800 shadow-sm backdrop-blur-md hover:bg-neutral-50"
            >
              {assetsPanelOpen ? "סגור חומרים" : "חומרים לפני שיעור"}
              {!assetsLoading && preLessonAssets.length > 0
                ? ` (${preLessonAssets.length})`
                : ""}
            </button>

            {assetsPanelOpen && (
              <div className="w-72 max-h-[min(420px,50vh)] overflow-y-auto rounded-2xl border border-neutral-200/80 bg-white/90 p-3 shadow-sm backdrop-blur-md">
                <div className="mb-2 text-[14px] font-semibold text-neutral-500">
                  הזנק ללוח A4 · PreLessonAsset
                </div>
                {assetsLoading ? (
                  <div className="py-6 text-center text-xs text-neutral-500 animate-pulse">
                    טוען חומרים...
                  </div>
                ) : preLessonAssets.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-neutral-300 py-6 text-center text-xs text-neutral-500">
                    אין חומרים שהועלו לחבילה זו
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {preLessonAssets.map((asset) => (
                      <li
                        key={asset.id}
                        className="rounded-xl border border-neutral-200/80 bg-neutral-50 p-2.5"
                      >
                        <div className="mb-1.5 flex items-center gap-2">
                          <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[13px] font-bold text-amber-900 border border-amber-100">
                            {asset.assetType}
                          </span>
                          <span className="text-[13px] text-neutral-500">
                            {new Date(asset.createdAt).toLocaleDateString("he-IL")}
                          </span>
                        </div>
                        {asset.textContent && (
                          <p className="mb-2 line-clamp-2 text-[14px] text-neutral-700">
                            {asset.textContent}
                          </p>
                        )}
                        {asset.assetUrl && asset.assetType !== "TEXT_NOTE" && (
                          <p className="mb-2 truncate text-[13px] text-neutral-500" title={asset.assetUrl}>
                            {asset.assetUrl}
                          </p>
                        )}
                        <button
                          type="button"
                          disabled={insertingAssetId === asset.id}
                          onClick={() => void insertPreLessonAsset(asset)}
                          className="w-full rounded-full bg-neutral-900 px-2.5 py-1.5 text-[14px] font-bold text-white hover:bg-neutral-800 disabled:opacity-50"
                        >
                          {insertingAssetId === asset.id
                            ? "מזריק ללוח..."
                            : "Insert to Canvas"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) await handleImageFile(f);
            e.target.value = "";
          }}
        />
      </div>
    );
  },
);

ClassroomWhiteboard.displayName = "ClassroomWhiteboard";
export default ClassroomWhiteboard;
