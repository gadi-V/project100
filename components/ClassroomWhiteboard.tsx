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
import { applyHistoryBackward, applyHistoryForward } from "../lib/whiteboard/display-list";
import { backingStoreSize } from "../lib/whiteboard/hidpi";
import {
  GRID_STEP,
  alignRecognizedShape,
  constrainLineEnd,
  draftFromRecognized,
  shouldSnapRecognizedToGrid,
} from "../lib/whiteboard/snap-commit";
import { SnapSession } from "../lib/whiteboard/snap-session";
import type { RecognizedShape } from "../lib/whiteboard/types";
import {
  applySyncedImage,
  ensureImageInCache as cacheBoardImage,
  imageAddEvent,
  loadBoardImage,
  renderBoardPageDataUrl,
  type BoardImageEl,
} from "../lib/whiteboard/board-image";
import { prepareBoardImageFile } from "../lib/whiteboard/prepare-board-image";
import {
  BOARD_DND_STAGGER_PX,
  IMAGE_STILL_TOO_LARGE_HINT,
  NOTEBOOK_NOT_READY_HINT,
  applyImageDropDecision,
  applyPasteDecision,
  dataTransferHasFiles,
  decideImageDrop,
  clipboardDataHasBoardShapeMarker,
  decidePasteAction,
  inspectImageDataTransfer,
  issueBoardShapeMarker,
  isTargetEditable,
  mostVisiblePageIndex,
  pagePointFromClient,
  type CanvasHit,
} from "../lib/whiteboard/board-dnd";
import {
  peerSnapshotAction,
  shouldAnswerSnapshotRequest,
  shouldRequestPeerSnapshot,
} from "../lib/whiteboard/snapshot-lifecycle";
import { useWhiteboardSnapshots } from "../lib/whiteboard/useWhiteboardSnapshots";
import { useDailyWhiteboard, type DailyWhiteboardLink } from "../lib/whiteboard/useDailyWhiteboard";
import type { RemoteLaser } from "../lib/whiteboard/laser-pointer";
import {
  createDeltaApplyState,
  flushSenderDeltas,
  guardIncomingOp,
  hasHeldDeltas,
  nextDeltaSeq,
  pushSenderDelta,
  resolveBoardSenderId,
  tombstoneElement,
  type RemoteBoardEvent,
  type RemoteBoardOp,
} from "../lib/whiteboard/delta-apply";
import {
  clearStrokeParts,
  createStrokePartStore,
  replaceStrokePart,
  type StrokePartStore,
} from "../lib/whiteboard/stroke-parts";
import { planBoardDelivery } from "../lib/whiteboard/transport-policy";

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_W = 794;
const PAGE_H = 1123;
const PAGE_GAP = 32;
const DESK_BG = "#f5f5f4";
const HANDLE_R = 6;
const ROT_HANDLE_OFFSET = 32;
const BOARD_EVENT = "board_sync";
/** Stream custom events fail above 2048 bytes (error code 22). */
const STREAM_LIMIT = 2048;
/** Events stay under this so a payload never reaches Stream's 2048-byte ceiling. */
export const STREAM_SAFE_LIMIT = 1400;
/** A single stroke is split once its event approaches this size. */
const STREAM_PIECE_SPLIT = 1200;
const IMAGE_MAX_WIDTH = 400;
const PROTO_V = 6;
const SNAPSHOT_CHUNK_CAP = 10;
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

/** Ruled paper line spacing — 8mm, about 30px. */
const RULED_STEP = mmToPx(8);
const RULED_MARGIN_X = 72;

const PAPER_COLORS = {
  gridFill: "#ffffff",
  gridLine: "#f1f5f9",
  ruledFill: "#fffef8",
  ruledLine: "#e7e5e4",
  ruledMargin: "#f43f5e",
  dotFill: "#ffffff",
  dot: "#cbd5e1",
  blankFill: "#fafaf9",
} as const;

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
type ShapeKind = "rectangle" | "ellipse" | "triangle" | "line" | "arrow" | "parabola";
type StrokeStyle = "solid" | "dashed" | "dotted";
type EraserMode = "stroke" | "pixel";
type LassoStyle = "rect" | "free";
type TextAlign = "right" | "center" | "left";
type PaperStyle = "grid" | "ruled" | "dotted" | "blank";

const PAPER_OPTIONS: ReadonlyArray<{ value: PaperStyle; label: string }> = [
  { value: "grid", label: "משבצות" },
  { value: "ruled", label: "שורות" },
  { value: "dotted", label: "נקודות" },
  { value: "blank", label: "חלק" },
];

export function isPaperStyle(value: unknown): value is PaperStyle {
  return typeof value === "string" && PAPER_OPTIONS.some((option) => option.value === value);
}

/** A joiner with an empty board asks once for the room's current snapshot. */
export function shouldRequestSnapshot(elementCount: number, alreadyRequested: boolean): boolean {
  return elementCount === 0 && !alreadyRequested;
}

export function buildRequestSnapshot(senderId: string, timestamp: number): SnapshotRequestEvent {
  return { action: "request_snapshot", senderId, timestamp };
}

export function readPaperStyleChange(value: { action?: string; paperStyle?: unknown }): PaperStyle | null {
  if (value.action !== "paper_style_change") return null;
  return isPaperStyle(value.paperStyle) ? value.paperStyle : null;
}

export type WhiteboardShortcut = "copy" | "cut" | "paste" | "duplicate" | "redo" | "undo" | "delete";

/**
 * Keyboard actions for the board. Shift-Z is redo (Cmd+Shift+Z / Ctrl+Shift+Z).
 * Matching is case-insensitive so a held Shift does not turn the key into "Z"
 * and skip the shortcut.
 */
export function readWhiteboardShortcut(event: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}): WhiteboardShortcut | null {
  const mod = Boolean(event.metaKey || event.ctrlKey);
  const key = event.key;
  if (mod && key === "c") return "copy";
  if (mod && key === "x") return "cut";
  if (mod && key === "v") return "paste";
  if (mod && key === "d") return "duplicate";
  const isZ = key === "z" || key === "Z" || event.code === "KeyZ";
  if (mod && isZ && event.shiftKey) return "redo";
  if (mod && isZ) return "undo";
  if (key === "Delete" || key === "Backspace") return "delete";
  return null;
}

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
  /** Snapped outline. Drawn and transformed in place of the bounding box. */
  vertices?: Point[];
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

type ImageEl = BoardImageEl;

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
  /** Live snap ghost while the pen is dwelling. Null keeps the raw ink. */
  snap: RecognizedShape | null;
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

type SyncImage = ReturnType<typeof imageAddEvent>["add"];

type SyncEl = SyncStroke | SyncShape | SyncText | SyncImage;

interface SyncEvent {
  type?: string;
  v?: number;
  action?: string;
  senderId?: string;
  timestamp?: number;
  snapshotId?: string;
  chunkIndex?: number;
  totalChunks?: number;
  paperStyle?: string;
  elementsChunk?: unknown;
  add?: unknown;
  remove?: unknown;
  pageCount?: unknown;
  historyOp?: unknown;
  direction?: "forward" | "backward";
  historyPart?: { index: number; total: number; opId: string };
  strokePart?: number;
  /** Per-sender delta sequence. Absent on legacy peers. */
  seq?: number;
  layerOrder?: { pageIndex: number; ids: string[] };
}

export type SnapshotChunkEvent = {
  action: "snapshot_chunk";
  senderId: string;
  snapshotId: string;
  chunkIndex: number;
  totalChunks: number;
  paperStyle: PaperStyle;
  elementsChunk: SyncEl[];
};

export type SnapshotRequestEvent = {
  action: "request_snapshot";
  senderId: string;
  timestamp: number;
};

interface PageInfo {
  id: string;
  pageNumber: number;
}

export interface ClassroomWhiteboardHandle {
  /** Upload every A4 page and return the stored PDF URL. Null when export or storage does not yield one. */
  exportBoardToPdf: (targetLessonId?: string) => Promise<string | null>;
  clearCanvas: () => void;
  /** Persist notebook pages. Resolves even when the network fails. */
  flushSnapshots: () => Promise<void>;
}

export type ClassroomWhiteboardRef = ClassroomWhiteboardHandle;

type BoardRole = "STUDENT" | "TEACHER" | "ADMIN" | "MANAGER";

type ClassroomWhiteboardProps = {
  role: BoardRole;
  streamChannel?: Channel | null;
  /** When set, load PreLessonAsset items for insert-to-canvas. */
  packageId?: string | null;
  lessonId?: string | null;
  notebookId?: string | null;
  /** First notebook page for this lesson. Local page i is stored at startPage + i. */
  startPage?: number | null;
  endPage?: number | null;
  /** Lesson participant id used on the Daily data channel. */
  userId?: string | null;
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
  if (el.kind === "shape") {
    if (el.vertices && el.vertices.length > 0) {
      const xs = el.vertices.map((p) => p.x);
      const ys = el.vertices.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    return {
      x: Math.min(el.x, el.x + el.w),
      y: Math.min(el.y, el.y + el.h),
      w: Math.abs(el.w),
      h: Math.abs(el.h),
    };
  }
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

const legacyImageUrls = new Map<string, string>();
const repaintBoardRef: { current: () => void } = { current: () => {} };

function rememberLegacyImage(raw: unknown): BoardImageEl | null {
  const applied = applySyncedImage(raw);
  if (!applied) return null;
  if (applied.legacyUrl) legacyImageUrls.set(applied.element.id, applied.legacyUrl);
  return applied.element;
}

function ensureImageInCache(
  el: ImageEl,
  cache: Map<string, HTMLImageElement>,
  onLoad?: () => void,
): void {
  cacheBoardImage(el, cache, () => {
    onLoad?.();
    repaintBoardRef.current();
  }, legacyImageUrls.get(el.id));
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

export function pixelEraseStroke(stroke: StrokeEl, pt: Point, radius: number): StrokeEl[] {
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
  if (el.kind === "shape") {
    return {
      ...el,
      x: el.x + dx,
      y: el.y + dy,
      vertices: el.vertices?.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    };
  }
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
    if (el.vertices && el.vertices.length > 0) {
      const vertices = el.vertices.map((p) => ({
        x: b.x + (p.x - b.x) * sx,
        y: b.y + (p.y - b.y) * sy,
      }));
      const xs = vertices.map((p) => p.x);
      const ys = vertices.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return {
        ...el,
        vertices,
        x,
        y,
        w: Math.max(...xs) - x,
        h: Math.max(...ys) - y,
        width: el.width * Math.max(sx, sy),
      };
    }
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
  if (el.kind === "shape") {
    return {
      ...el,
      id,
      pageIndex,
      x: el.x + offset,
      y: el.y + offset,
      vertices: el.vertices?.map((p) => ({ x: p.x + offset, y: p.y + offset })),
    };
  }
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
  if (el.kind === "image") {
    const image = rememberLegacyImage(el);
    return image ? imageAddEvent(image).add : null;
  }
  return null;
}

function syncElToDraw(raw: SyncEl): DrawEl | null {
  if (!raw || typeof raw.id !== "string") return null;
  if (raw.kind === "stroke") {
    if (!Array.isArray(raw.pts)) return null;
    return {
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
  }
  if (raw.kind === "shape") return raw;
  if (raw.kind === "text") return normalizeTextEl(raw);
  if (raw.kind === "image") return rememberLegacyImage(raw);
  return null;
}

function snapshotChunkBody(
  snapshotId: string,
  senderId: string,
  paperStyle: PaperStyle,
  chunkIndex: number,
  totalChunks: number,
  elementsChunk: readonly SyncEl[],
): Record<string, unknown> {
  return {
    action: "snapshot_chunk",
    senderId,
    snapshotId,
    chunkIndex,
    totalChunks,
    paperStyle,
    elementsChunk,
  };
}

function snapshotEnvelope(payload: Record<string, unknown>): string {
  return JSON.stringify({ type: BOARD_EVENT, v: PROTO_V, ...payload });
}

function syncPieceBytes(
  piece: SyncEl,
  paperStyle: PaperStyle,
  snapshotId: string,
  senderId: string,
): number {
  return snapshotEnvelope(snapshotChunkBody(snapshotId, senderId, paperStyle, 998, 999, [piece])).length;
}

/** Split a stroke until each piece fits in one Stream event. Same id is concatenated on assemble. */
function fitSyncPiece(
  el: SyncEl,
  paperStyle: PaperStyle,
  snapshotId: string,
  senderId: string,
): SyncEl[] {
  const bytes = syncPieceBytes(el, paperStyle, snapshotId, senderId);
  if (bytes <= STREAM_PIECE_SPLIT) return [el];
  if (el.kind !== "stroke" || el.pts.length < 4) {
    return bytes <= STREAM_SAFE_LIMIT ? [el] : [];
  }
  const mid = Math.floor(el.pts.length / 4) * 2;
  if (mid < 2 || mid >= el.pts.length) {
    return bytes <= STREAM_SAFE_LIMIT ? [el] : [];
  }
  return [
    ...fitSyncPiece({ ...el, pts: el.pts.slice(0, mid) }, paperStyle, snapshotId, senderId),
    ...fitSyncPiece({ ...el, pts: el.pts.slice(mid) }, paperStyle, snapshotId, senderId),
  ];
}

function mergeSyncElements(parts: readonly SyncEl[]): DrawEl[] {
  const order: string[] = [];
  const merged = new Map<string, SyncEl>();
  for (const part of parts) {
    const prev = merged.get(part.id);
    if (!prev) {
      order.push(part.id);
      merged.set(part.id, part.kind === "stroke" ? { ...part, pts: [...part.pts] } : part);
      continue;
    }
    if (prev.kind === "stroke" && part.kind === "stroke") {
      prev.pts = [...prev.pts, ...part.pts];
    } else {
      merged.set(part.id, part);
    }
  }
  const drawn: DrawEl[] = [];
  for (const id of order) {
    const sync = merged.get(id);
    if (!sync) continue;
    const el = syncElToDraw(sync);
    if (el) drawn.push(el);
  }
  return drawn;
}

/** Same width as `nanoid()`, so a budgeted event still fits once real ids are filled in. */
const SYNC_ID_BUDGET = "012345678901234567890";

export function boardSyncEventBytes(payload: object): number {
  return JSON.stringify({ type: BOARD_EVENT, v: PROTO_V, ...(payload as Record<string, unknown>) }).length;
}

/** Skip path for an event that cannot be sent. The counter is the caller's running total. */
export function noteOverLimitPayload(
  count: number,
  bytes: number,
): { skip: boolean; nextCount: number; status: "error" | "ok" } {
  if (bytes > STREAM_SAFE_LIMIT || bytes > STREAM_LIMIT) {
    const nextCount = count + 1;
    console.warn(`[whiteboard] skipped over-limit payload #${nextCount} (${bytes}B)`);
    return { skip: true, nextCount, status: "error" };
  }
  return { skip: false, nextCount: count, status: "ok" };
}

export function gateBoardPayload(
  count: number,
  payload: object,
): { skip: boolean; nextCount: number; status: "error" | "ok"; bytes: number } {
  const bytes = boardSyncEventBytes(payload);
  return { ...noteOverLimitPayload(count, bytes), bytes };
}

function isNumberList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function coerceSyncEl(raw: unknown): SyncEl | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.kind !== "string") return null;
  if (record.kind === "stroke") {
    const el = raw as Partial<StrokeEl> & { pts?: unknown };
    if (isNumberList(el.pts)) return raw as SyncStroke;
    if (Array.isArray(el.points)) {
      return {
        kind: "stroke",
        id: record.id,
        tool: el.tool === "highlighter" ? "highlighter" : "pen",
        color: typeof el.color === "string" ? el.color : "#0f172a",
        width: typeof el.width === "number" ? el.width : 1,
        opacity: typeof el.opacity === "number" ? el.opacity : 1,
        strokeStyle: el.strokeStyle ?? "solid",
        pts: el.points.flatMap((point) => [point.x, point.y]),
        pageIndex: typeof el.pageIndex === "number" ? el.pageIndex : 0,
      };
    }
    return null;
  }
  if (record.kind === "shape" || record.kind === "text" || record.kind === "image") return raw as SyncEl;
  return null;
}

function packDrawEl(el: DrawEl): SyncEl {
  if (el.kind === "image") {
    const image = rememberLegacyImage(el);
    return image ? imageAddEvent(image).add : el;
  }
  if (el.kind !== "stroke") return el;
  return {
    kind: "stroke",
    id: el.id,
    tool: el.tool,
    color: el.color,
    width: el.width,
    opacity: el.opacity,
    strokeStyle: el.strokeStyle,
    pts: el.points.flatMap((point) => [point.x, point.y]),
    pageIndex: el.pageIndex,
  };
}

function splitStrokeToBudget(el: SyncStroke, bytesOf: (candidate: SyncStroke) => number): SyncStroke[] {
  if (bytesOf(el) <= STREAM_SAFE_LIMIT) return [el];
  const mid = Math.floor(el.pts.length / 4) * 2;
  if (mid < 2 || mid >= el.pts.length) return [el];
  return [
    ...splitStrokeToBudget({ ...el, pts: el.pts.slice(0, mid) }, bytesOf),
    ...splitStrokeToBudget({ ...el, pts: el.pts.slice(mid) }, bytesOf),
  ];
}

function liveStrokePieces(el: SyncStroke, paperStyle: PaperStyle, senderId: string): SyncStroke[] {
  if (boardSyncEventBytes({ add: el, senderId }) <= STREAM_SAFE_LIMIT) return [el];
  const fitted = fitSyncPiece(el, paperStyle, "live", senderId).filter(
    (piece): piece is SyncStroke => piece.kind === "stroke",
  );
  const seeds = fitted.length > 0 ? fitted : [el];
  return seeds.flatMap((piece) =>
    splitStrokeToBudget(piece, (candidate) =>
      boardSyncEventBytes({ add: candidate, strokePart: 999, senderId }),
    ),
  );
}

/** One pen stroke as `{add}` events that share `id` and each stay within STREAM_SAFE_LIMIT. */
export function buildStrokeAddEvents(
  stroke: StrokeEl,
  paperStyle: PaperStyle = "grid",
  senderId = SYNC_ID_BUDGET,
): Array<{ add: SyncStroke; strokePart?: number; senderId: string }> {
  const sync = toSyncEl(stroke);
  if (!sync || sync.kind !== "stroke") return [];
  const pieces = liveStrokePieces(sync, paperStyle, senderId);
  if (pieces.length <= 1) return [{ add: pieces[0] ?? sync, senderId }];
  return pieces.map((piece, index) => ({ add: piece, strokePart: index, senderId }));
}

/**
 * Apply one live `{add}`.
 * With a part store, piece `(strokeId, partIndex)` replaces that piece and the
 * stroke is rebuilt in index order. Without a store, later pieces still append
 * so a single in-order pass reassembles a stroke.
 */
export function applyLiveAdd(
  elements: readonly DrawEl[],
  event: { add?: unknown; strokePart?: number },
  parts?: StrokePartStore,
): DrawEl[] {
  const raw = coerceSyncEl(event.add);
  if (!raw) return [...elements];
  if (raw.kind === "stroke" && parts) {
    if (typeof event.strokePart !== "number") {
      clearStrokeParts(parts, raw.id);
    } else {
      const ordered = replaceStrokePart(parts, event.strokePart, raw);
      const merged = mergeSyncElements(ordered as SyncEl[]);
      return merged[0] ? upsertElement(elements, merged[0]) : [...elements];
    }
  } else if (raw.kind === "stroke" && (event.strokePart ?? 0) > 0) {
    const existing = elements.find((el) => el.id === raw.id);
    if (existing?.kind === "stroke") {
      const prev: SyncStroke = {
        kind: "stroke",
        id: existing.id,
        tool: existing.tool,
        color: existing.color,
        width: existing.width,
        opacity: existing.opacity,
        strokeStyle: existing.strokeStyle,
        pts: existing.points.flatMap((point) => [point.x, point.y]),
        pageIndex: existing.pageIndex,
      };
      const merged = mergeSyncElements([prev, raw]);
      return merged[0] ? upsertElement(elements, merged[0]) : [...elements];
    }
  }
  const drawn = syncElToDraw(raw);
  return drawn ? upsertElement(elements, drawn) : [...elements];
}

export type HistorySyncEvent = {
  historyOp: {
    id: string;
    removed: SyncEl[];
    added: SyncEl[];
    updated: Array<{ id: string; before: SyncEl; after: SyncEl }>;
  };
  direction: "forward" | "backward";
  senderId: string;
  historyPart?: { index: number; total: number; opId: string };
};

type HistoryPiece =
  | { bucket: "removed"; el: SyncEl }
  | { bucket: "added"; el: SyncEl }
  | { bucket: "updated"; update: HistorySyncEvent["historyOp"]["updated"][number] };

function historySliceBytes(el: SyncStroke, senderId: string): number {
  const empty: SyncStroke = { ...el, pts: [] };
  return boardSyncEventBytes({
    senderId,
    historyOp: {
      id: SYNC_ID_BUDGET,
      removed: [] as SyncEl[],
      added: [] as SyncEl[],
      updated: [{ id: SYNC_ID_BUDGET, before: el, after: empty }],
    },
    direction: "forward",
    historyPart: { index: 998, total: 999, opId: SYNC_ID_BUDGET },
  });
}

function expandDrawEl(el: DrawEl, senderId: string): SyncEl[] {
  const packed = packDrawEl(el);
  if (packed.kind !== "stroke") return [packed];
  const fitted = fitSyncPiece(packed, "grid", "hist", senderId).filter(
    (piece): piece is SyncStroke => piece.kind === "stroke",
  );
  const seeds = fitted.length > 0 ? fitted : [packed];
  return seeds.flatMap((piece) => splitStrokeToBudget(piece, (candidate) => historySliceBytes(candidate, senderId)));
}

function blankPartner(el: SyncEl): SyncEl {
  return el.kind === "stroke" ? { ...el, pts: [] } : el;
}

function historyPieces(op: HistoryOp, senderId: string): HistoryPiece[] {
  const pieces: HistoryPiece[] = [];
  for (const el of op.removed) {
    for (const part of expandDrawEl(el, senderId)) pieces.push({ bucket: "removed", el: part });
  }
  for (const el of op.added) {
    for (const part of expandDrawEl(el, senderId)) pieces.push({ bucket: "added", el: part });
  }
  for (const update of op.updated) {
    const beforeParts = expandDrawEl(update.before, senderId);
    const afterParts = expandDrawEl(update.after, senderId);
    const beforeBlank = blankPartner(beforeParts[0] ?? packDrawEl(update.before));
    const afterBlank = blankPartner(afterParts[0] ?? packDrawEl(update.after));
    for (const el of beforeParts) {
      pieces.push({ bucket: "updated", update: { id: update.id, before: el, after: afterBlank } });
    }
    for (const el of afterParts) {
      pieces.push({ bucket: "updated", update: { id: update.id, before: beforeBlank, after: el } });
    }
  }
  return pieces;
}

function groupHistoryPayload(
  opId: string,
  direction: "forward" | "backward",
  senderId: string,
  group: readonly HistoryPiece[],
  index: number,
  total: number,
): HistorySyncEvent {
  return {
    senderId,
    direction,
    historyOp: {
      id: opId,
      removed: group
        .filter((piece): piece is { bucket: "removed"; el: SyncEl } => piece.bucket === "removed")
        .map((piece) => piece.el),
      added: group
        .filter((piece): piece is { bucket: "added"; el: SyncEl } => piece.bucket === "added")
        .map((piece) => piece.el),
      updated: group
        .filter(
          (piece): piece is { bucket: "updated"; update: HistorySyncEvent["historyOp"]["updated"][number] } =>
            piece.bucket === "updated",
        )
        .map((piece) => piece.update),
    },
    historyPart: { index, total, opId },
  };
}

/** History ops travel with packed `pts`. Oversized ops are split and reassembled by id. */
export function buildHistorySyncEvents(
  op: HistoryOp,
  direction: "forward" | "backward",
  senderId = SYNC_ID_BUDGET,
): HistorySyncEvent[] {
  const single: HistorySyncEvent = {
    senderId,
    direction,
    historyOp: {
      id: op.id,
      removed: op.removed.map(packDrawEl),
      added: op.added.map(packDrawEl),
      updated: op.updated.map((update) => ({
        id: update.id,
        before: packDrawEl(update.before),
        after: packDrawEl(update.after),
      })),
    },
  };
  if (boardSyncEventBytes(single) <= STREAM_SAFE_LIMIT) return [single];

  const pieces = historyPieces(op, senderId);
  const groups: HistoryPiece[][] = [];
  let current: HistoryPiece[] = [];
  for (const piece of pieces) {
    const trial = [...current, piece];
    const overflows =
      current.length > 0 &&
      boardSyncEventBytes(groupHistoryPayload(op.id, direction, senderId, trial, groups.length, 999)) >
        STREAM_SAFE_LIMIT;
    if (overflows) {
      groups.push(current);
      current = [];
    }
    current.push(piece);
  }
  if (current.length > 0) groups.push(current);
  if (groups.length === 0) groups.push([]);
  return groups.map((group, index) => groupHistoryPayload(op.id, direction, senderId, group, index, groups.length));
}

type BufferedHistory = {
  direction: "forward" | "backward";
  historyOp: { id: string; removed: unknown[]; added: unknown[]; updated: unknown[] };
};

export type HistoryPartBuffer = Map<string, Array<BufferedHistory | undefined>>;

function unpackHistoryOp(raw: {
  id: string;
  removed: unknown[];
  added: unknown[];
  updated: unknown[];
}): HistoryOp {
  const removed = mergeSyncElements(raw.removed.map(coerceSyncEl).filter((el): el is SyncEl => el !== null));
  const added = mergeSyncElements(raw.added.map(coerceSyncEl).filter((el): el is SyncEl => el !== null));
  const updateOrder: string[] = [];
  const befores = new Map<string, SyncEl[]>();
  const afters = new Map<string, SyncEl[]>();
  for (const item of raw.updated) {
    if (!item || typeof item !== "object") continue;
    const update = item as { id?: unknown; before?: unknown; after?: unknown };
    if (typeof update.id !== "string") continue;
    const before = coerceSyncEl(update.before);
    const after = coerceSyncEl(update.after);
    if (!before || !after) continue;
    if (!befores.has(update.id)) {
      updateOrder.push(update.id);
      befores.set(update.id, []);
      afters.set(update.id, []);
    }
    befores.get(update.id)?.push(before);
    afters.get(update.id)?.push(after);
  }
  const updated: HistoryUpdate[] = [];
  for (const id of updateOrder) {
    const before = mergeSyncElements(befores.get(id) ?? [])[0];
    const after = mergeSyncElements(afters.get(id) ?? [])[0];
    if (before && after) updated.push({ id, before, after });
  }
  return { id: raw.id, removed, added, updated };
}

function asHistoryBody(raw: unknown): BufferedHistory["historyOp"] | null {
  if (!raw || typeof raw !== "object") return null;
  const op = raw as { id?: unknown; removed?: unknown; added?: unknown; updated?: unknown };
  if (typeof op.id !== "string" || !Array.isArray(op.removed) || !Array.isArray(op.added)) return null;
  return {
    id: op.id,
    removed: op.removed,
    added: op.added,
    updated: Array.isArray(op.updated) ? op.updated : [],
  };
}

export function noteHistorySyncEvent(
  buffers: HistoryPartBuffer,
  value: { historyOp?: unknown; direction?: unknown; historyPart?: unknown },
): { op: HistoryOp; direction: "forward" | "backward" } | null {
  if (value.direction !== "forward" && value.direction !== "backward") return null;
  const historyOp = asHistoryBody(value.historyOp);
  if (!historyOp) return null;
  const direction = value.direction;
  if (value.historyPart === undefined) return { op: unpackHistoryOp(historyOp), direction };

  if (!value.historyPart || typeof value.historyPart !== "object") return null;
  const part = value.historyPart as { index?: unknown; total?: unknown; opId?: unknown };
  if (typeof part.opId !== "string" || typeof part.index !== "number" || typeof part.total !== "number") return null;
  if (!Number.isInteger(part.index) || !Number.isInteger(part.total) || part.total <= 0) return null;
  if (part.index < 0 || part.index >= part.total) return null;

  const slots = buffers.get(part.opId) ?? Array.from({ length: part.total }, () => undefined);
  if (slots.length !== part.total || slots[part.index]) return null;
  slots[part.index] = { direction, historyOp };
  buffers.set(part.opId, slots);
  if (slots.some((slot) => !slot)) return null;

  buffers.delete(part.opId);
  const removed: unknown[] = [];
  const added: unknown[] = [];
  const updated: unknown[] = [];
  for (const slot of slots) {
    if (!slot) continue;
    removed.push(...slot.historyOp.removed);
    added.push(...slot.historyOp.added);
    updated.push(...slot.historyOp.updated);
  }
  return { op: unpackHistoryOp({ id: part.opId, removed, added, updated }), direction };
}

export function buildClearCanvasEvents(
  elements: readonly DrawEl[],
  opId: string,
  senderId = SYNC_ID_BUDGET,
): Array<HistorySyncEvent | { action: "clear"; senderId: string }> {
  const events: Array<HistorySyncEvent | { action: "clear"; senderId: string }> = [];
  if (elements.length > 0) {
    events.push(
      ...buildHistorySyncEvents({ id: opId, removed: [...elements], added: [], updated: [] }, "forward", senderId),
    );
  }
  events.push({ action: "clear", senderId });
  return events;
}

/** Pack the board into Stream events that stay under STREAM_SAFE_LIMIT. */
export function buildSnapshotChunks(
  elements: readonly DrawEl[],
  paperStyle: PaperStyle,
  snapshotId: string,
  senderId = "peer",
): SnapshotChunkEvent[] {
  const pieces: SyncEl[] = [];
  for (const el of elements) {
    const sync = toSyncEl(el);
    if (!sync) continue;
    pieces.push(...fitSyncPiece(sync, paperStyle, snapshotId, senderId));
  }

  const groups: SyncEl[][] = [];
  let bucket: SyncEl[] = [];
  const flush = (): void => {
    if (bucket.length === 0) return;
    groups.push(bucket);
    bucket = [];
  };
  for (const piece of pieces) {
    const trial = [...bucket, piece];
    const overflows =
      bucket.length > 0 &&
      snapshotEnvelope(snapshotChunkBody(snapshotId, senderId, paperStyle, 998, 999, trial)).length >
        STREAM_SAFE_LIMIT;
    if (overflows || bucket.length >= SNAPSHOT_CHUNK_CAP) flush();
    bucket.push(piece);
  }
  flush();
  if (groups.length === 0) groups.push([]);

  return groups.map((elementsChunk, chunkIndex) => ({
    action: "snapshot_chunk",
    senderId,
    snapshotId,
    chunkIndex,
    totalChunks: groups.length,
    paperStyle,
    elementsChunk,
  }));
}

/** Returns the full board once every chunk of one snapshot has arrived. */
export function noteSnapshotChunk(
  buffers: Map<string, SnapshotChunkEvent[]>,
  chunk: SnapshotChunkEvent,
): { elements: DrawEl[]; paperStyle: PaperStyle } | null {
  if (!Number.isInteger(chunk.totalChunks) || chunk.totalChunks <= 0) return null;
  if (!Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex >= chunk.totalChunks) {
    return null;
  }
  const list = buffers.get(chunk.snapshotId) ?? [];
  if (list.some((item) => item.chunkIndex === chunk.chunkIndex)) return null;
  if (list.length > 0 && list[0].totalChunks !== chunk.totalChunks) return null;
  list.push(chunk);
  buffers.set(chunk.snapshotId, list);
  if (list.length < chunk.totalChunks) return null;

  const slots: Array<SyncEl[] | undefined> = Array.from({ length: chunk.totalChunks }, () => undefined);
  let paperStyle: PaperStyle = "grid";
  for (const item of list) {
    slots[item.chunkIndex] = item.elementsChunk;
    if (isPaperStyle(item.paperStyle)) paperStyle = item.paperStyle;
  }
  if (slots.some((slot) => !slot)) return null;
  buffers.delete(chunk.snapshotId);
  return {
    elements: mergeSyncElements(slots.flatMap((slot) => slot ?? [])),
    paperStyle,
  };
}

export function parseSnapshotChunk(value: {
  action?: string;
  senderId?: unknown;
  snapshotId?: unknown;
  chunkIndex?: unknown;
  totalChunks?: unknown;
  paperStyle?: unknown;
  elementsChunk?: unknown;
}): SnapshotChunkEvent | null {
  if (value.action !== "snapshot_chunk") return null;
  if (typeof value.senderId !== "string" || typeof value.snapshotId !== "string") return null;
  if (typeof value.chunkIndex !== "number" || typeof value.totalChunks !== "number") return null;
  if (!isPaperStyle(value.paperStyle) || !Array.isArray(value.elementsChunk)) return null;
  const elementsChunk: SyncEl[] = [];
  for (const item of value.elementsChunk) {
    if (!item || typeof item !== "object") continue;
    const raw = item as SyncEl;
    if (typeof raw.kind !== "string" || typeof raw.id !== "string") continue;
    elementsChunk.push(raw);
  }
  return {
    action: "snapshot_chunk",
    senderId: value.senderId,
    snapshotId: value.snapshotId,
    chunkIndex: value.chunkIndex,
    totalChunks: value.totalChunks,
    paperStyle: value.paperStyle,
    elementsChunk,
  };
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
  if (el.shape === "parabola" && "vertices" in el && el.vertices && el.vertices.length >= 3) {
    const [start, control, end] = el.vertices;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if ("vertices" in el && el.vertices && el.vertices.length >= 2) {
    const vertices = el.vertices;
    ctx.beginPath();
    ctx.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 1; i < vertices.length; i++) ctx.lineTo(vertices[i].x, vertices[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    return;
  }
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
    case "parabola":
      break;
  }
  ctx.restore();
}

function paintSnapGhost(
  ctx: CanvasRenderingContext2D,
  shape: RecognizedShape,
  color: string,
  width: number,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([]);
  if (shape.type === "line") {
    ctx.beginPath();
    ctx.moveTo(shape.start.x, shape.start.y);
    ctx.lineTo(shape.end.x, shape.end.y);
    ctx.stroke();
  } else if (shape.type === "circle") {
    ctx.beginPath();
    ctx.arc(shape.center.x, shape.center.y, shape.radius, 0, Math.PI * 2);
    ctx.stroke();
  } else if (shape.type === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(shape.center.x, shape.center.y, shape.radiusX, shape.radiusY, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (shape.type === "parabola") {
    const controlX = 2 * shape.vertex.x - 0.5 * (shape.start.x + shape.end.x);
    const controlY = 2 * shape.vertex.y - 0.5 * (shape.start.y + shape.end.y);
    ctx.beginPath();
    ctx.moveTo(shape.start.x, shape.start.y);
    ctx.quadraticCurveTo(controlX, controlY, shape.end.x, shape.end.y);
    ctx.stroke();
  } else if (shape.type === "polygon" && shape.vertices.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(shape.vertices[0].x, shape.vertices[0].y);
    for (let i = 1; i < shape.vertices.length; i++) {
      ctx.lineTo(shape.vertices[i].x, shape.vertices[i].y);
    }
    ctx.closePath();
    ctx.stroke();
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

function paperBackgroundStyle(style: PaperStyle): React.CSSProperties {
  if (style === "ruled") {
    const margin = RULED_MARGIN_X;
    return {
      backgroundColor: PAPER_COLORS.ruledFill,
      backgroundImage: [
        `linear-gradient(to right, transparent ${margin}px, ${PAPER_COLORS.ruledMargin} ${margin}px, ${PAPER_COLORS.ruledMargin} ${margin + 1}px, transparent ${margin + 1}px)`,
        `repeating-linear-gradient(to bottom, transparent 0, transparent ${RULED_STEP - 1}px, ${PAPER_COLORS.ruledLine} ${RULED_STEP - 1}px, ${PAPER_COLORS.ruledLine} ${RULED_STEP}px)`,
      ].join(","),
    };
  }
  if (style === "dotted") {
    return {
      backgroundColor: PAPER_COLORS.dotFill,
      backgroundImage: `radial-gradient(circle, ${PAPER_COLORS.dot} 1px, transparent 1.5px)`,
      backgroundSize: `${GRID_STEP}px ${GRID_STEP}px`,
    };
  }
  if (style === "blank") {
    return {
      backgroundColor: PAPER_COLORS.blankFill,
      backgroundImage: "none",
    };
  }
  return {
    backgroundColor: PAPER_COLORS.gridFill,
    backgroundImage:
      `linear-gradient(to right, ${PAPER_COLORS.gridLine} 1px, transparent 1px),` +
      `linear-gradient(to bottom, ${PAPER_COLORS.gridLine} 1px, transparent 1px)`,
    backgroundSize: `${GRID_STEP}px ${GRID_STEP}px`,
  };
}

/** Draws the page paper so PNG/PDF export matches the on-screen background. */
function paintPaperBackground(ctx: CanvasRenderingContext2D, style: PaperStyle): void {
  ctx.save();
  ctx.setLineDash([]);
  if (style === "blank") {
    ctx.fillStyle = PAPER_COLORS.blankFill;
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    ctx.restore();
    return;
  }
  if (style === "ruled") {
    ctx.fillStyle = PAPER_COLORS.ruledFill;
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    ctx.strokeStyle = PAPER_COLORS.ruledLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = RULED_STEP; y < PAGE_H + 1; y += RULED_STEP) {
      const lineY = y - 0.5;
      ctx.moveTo(0, lineY);
      ctx.lineTo(PAGE_W, lineY);
    }
    ctx.stroke();
    ctx.strokeStyle = PAPER_COLORS.ruledMargin;
    ctx.beginPath();
    ctx.moveTo(RULED_MARGIN_X + 0.5, 0);
    ctx.lineTo(RULED_MARGIN_X + 0.5, PAGE_H);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (style === "dotted") {
    ctx.fillStyle = PAPER_COLORS.dotFill;
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    ctx.fillStyle = PAPER_COLORS.dot;
    const origin = GRID_STEP / 2;
    for (let y = origin; y < PAGE_H; y += GRID_STEP) {
      for (let x = origin; x < PAGE_W; x += GRID_STEP) {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    return;
  }
  ctx.fillStyle = PAPER_COLORS.gridFill;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.strokeStyle = PAPER_COLORS.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= PAGE_W; x += GRID_STEP) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, PAGE_H);
  }
  for (let y = 0; y <= PAGE_H; y += GRID_STEP) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(PAGE_W, y + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

async function renderPageDataUrl(
  pageIndex: number,
  pageElements: readonly DrawEl[],
  images: Map<string, HTMLImageElement>,
  style: PaperStyle,
): Promise<string> {
  const rendered = await renderBoardPageDataUrl({
    pageIndex,
    elements: pageElements,
    images,
    createCanvas: () => {
      const off = document.createElement("canvas");
      off.width = PAGE_W;
      off.height = PAGE_H;
      return off;
    },
    drawBase: (ctx) => {
      paintPaperBackground(ctx, style);
      for (const el of pageElements) {
        if (el.pageIndex !== pageIndex || el.kind === "image") continue;
        if (el.kind === "stroke")
          paintSmoothStroke(ctx, el.points, el.color, el.width, el.opacity, el.tool === "highlighter", el.strokeStyle);
        else if (el.kind === "shape") paintShape(ctx, el);
        else paintText(ctx, el);
      }
    },
    drawImage: (ctx, el, img) => paintImage(ctx, img, el),
    load: (el) => loadBoardImage(el, images, () => repaintBoardRef.current(), legacyImageUrls.get(el.id)),
  });
  return rendered.dataUrl;
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

/** Live rubber-band: Shift locks line/arrow, grid paper snaps a recognized ghost. */
function presentActiveDrawing(
  active: ActiveDrawing,
  shiftKey: boolean,
  snapToGrid: boolean,
): ActiveDrawing {
  if (!active) return null;
  if (active.kind === "shape") {
    if (!shiftKey || (active.shape !== "line" && active.shape !== "arrow")) return active;
    return { ...active, end: constrainLineEnd(active.start, active.end, true) };
  }
  if (active.kind !== "pen" || active.tool !== "pen" || !active.snap) return active;
  return {
    ...active,
    snap: alignRecognizedShape(active.snap, { snapToGrid, constrainLine: shiftKey }),
  };
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
  const surface = backingStoreSize(PAGE_W, PAGE_H, window.devicePixelRatio ?? 1);
  if (canvas.width !== surface.width || canvas.height !== surface.height) {
    canvas.width = surface.width;
    canvas.height = surface.height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.save();
  ctx.scale(surface.scale, surface.scale);
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
    if (active.kind === "pen") {
      const ghost = active.tool === "pen" && active.snap && active.snap.type !== "freehand" ? active.snap : null;
      paintSmoothStroke(
        ctx,
        active.points,
        active.color,
        active.width,
        ghost ? active.opacity * 0.28 : active.opacity,
        active.tool === "highlighter",
        active.strokeStyle,
      );
      if (ghost) paintSnapGhost(ctx, ghost, active.color, active.width);
    }
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

function clampOnPage(value: number, size: number, page: number): number {
  const max = Math.max(20, page - size - 20);
  return Math.min(Math.max(value, 20), max);
}

// ─── Main component ───────────────────────────────────────────────────────────

const ClassroomWhiteboard = forwardRef<ClassroomWhiteboardHandle, ClassroomWhiteboardProps>(
  function ClassroomWhiteboard(
    {
      role,
      streamChannel = null,
      packageId = null,
      lessonId = null,
      notebookId = null,
      startPage = null,
      endPage = null,
      userId = null,
    },
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
    const [paperStyle, setPaperStyle] = useState<PaperStyle>("grid");
    const [openMenu, setOpenMenu] = useState<
      "selection" | "pen" | "highlighter" | "eraser" | "shapes" | "paper" | null
    >(null);
    const [textMenu, setTextMenu] = useState<"size" | "align" | "color" | null>(null);
    const [showRecolorPicker, setShowRecolorPicker] = useState(false);
    const [showLassoMore, setShowLassoMore] = useState(false);
    const [transformMode, setTransformMode] = useState(false);
    const [aiHint, setAiHint] = useState<string | null>(null);
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const [syncStatus, setSyncStatus] = useState<"idle" | "live" | "error">("idle");
    const [snapshotSync, setSnapshotSync] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const [snapshotsReady, setSnapshotsReady] = useState(notebookId == null || startPage == null);
    const [peerLasers, setPeerLasers] = useState<RemoteLaser[]>([]);
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
    const pagesRef = useRef(pages);
    const snapshotHydratingRef = useRef(false);
    const selectedRef = useRef<ReadonlySet<string>>(selectedIds);
    const erasingRef = useRef(false);
    const applyRemote = useRef(false);
    const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());
    const zoomRef = useRef(zoom);
    const clipboardRef = useRef<DrawEl[]>([]);
    const shapeMarkerRef = useRef("");
    const shapeCopyArmedRef = useRef(false);
    const laserTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const snapRef = useRef<SnapSession | null>(null);
    const cursorRef = useRef<(Point & { pageIndex: number }) | null>(null);
    const livePaintRafRef = useRef<number | null>(null);
    const paintBoardRef = useRef<() => void>(() => {});
    const scheduleLivePaintRef = useRef<() => void>(() => {});
    const onUpRef = useRef<(event?: { shiftKey?: boolean }) => void>(() => {});
    const releaseCleanupRef = useRef<(() => void) | null>(null);
    const undoStackRef = useRef<HistoryOp[]>([]);
    const redoStackRef = useRef<HistoryOp[]>([]);
    const eraserSizeRef = useRef(eraserDiameter / 2);
    const broadcastRef = useRef<((payload: Record<string, unknown>) => void) | null>(null);
    const emitBoardEventRef = useRef<(payload: Record<string, unknown>) => void>(() => {});
    const clientIdRef = useRef(nanoid());
    const senderIdRef = useRef(resolveBoardSenderId(userId, clientIdRef.current));
    senderIdRef.current = resolveBoardSenderId(userId, clientIdRef.current);
    const dailyLinkRef = useRef<DailyWhiteboardLink | null>(null);
    const deltaStateRef = useRef(createDeltaApplyState());
    const strokePartsRef = useRef(createStrokePartStore());
    const reorderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyRemoteOpsRef = useRef<(ops: readonly RemoteBoardOp[]) => void>(() => {});
    const ingestRemoteEventRef = useRef<(event: RemoteBoardEvent) => void>(() => {});
    const snapshotRequestedRef = useRef(false);
    const awaitingSnapshotRef = useRef(false);
    const snapshotBuffersRef = useRef(new Map<string, SnapshotChunkEvent[]>());
    const historySyncBuffersRef = useRef<HistoryPartBuffer>(new Map());
    const skippedSyncCountRef = useRef(0);
    const paperStyleRef = useRef<PaperStyle>(paperStyle);
    const shiftPressedRef = useRef(false);
    const dragDepthRef = useRef(0);

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
      pagesRef.current = pages;
    }, [pages]);
    useEffect(() => {
      paperStyleRef.current = paperStyle;
    }, [paperStyle]);
    useEffect(() => {
      selectedRef.current = selectedIds;
    }, [selectedIds]);
    useEffect(() => {
      zoomRef.current = zoom;
    }, [zoom]);

    const { phase: snapshotPhase, noteMutation: noteSnapshotMutation, flush: flushSnapshots } =
      useWhiteboardSnapshots<DrawEl>({
        role,
        notebookId,
        lessonId,
        startPage,
        endPage,
        readBoard: () => ({
          paperStyle: paperStyleRef.current,
          pageCount: pagesRef.current.length,
          elements: elementsRef.current,
        }),
        applyServer: ({ elements: nextElements, paperStyle: nextPaper, pageCount }) => {
          snapshotHydratingRef.current = true;
          for (const el of nextElements) {
            if (el.kind === "image") ensureImageInCache(el, imgCache.current);
          }
          elementsRef.current = nextElements;
          if (isPaperStyle(nextPaper)) paperStyleRef.current = nextPaper;
          setElements(nextElements);
          if (isPaperStyle(nextPaper)) setPaperStyle(nextPaper);
          setPages((prev) => {
            if (prev.length >= pageCount) return prev;
            return [
              ...prev,
              ...Array.from({ length: pageCount - prev.length }, (_, index) => ({
                id: nanoid(),
                pageNumber: prev.length + index + 1,
              })),
            ];
          });
          scheduleLivePaintRef.current();
        },
        onStatus: setSnapshotSync,
        onReady: () => setSnapshotsReady(true),
      });
    const noteSnapshotMutationRef = useRef(noteSnapshotMutation);
    noteSnapshotMutationRef.current = noteSnapshotMutation;
    const snapshotBaselineRef = useRef(false);
    useEffect(() => {
      if (!snapshotBaselineRef.current) {
        snapshotBaselineRef.current = true;
        return;
      }
      if (snapshotHydratingRef.current) {
        snapshotHydratingRef.current = false;
        return;
      }
      noteSnapshotMutationRef.current();
    }, [elements, paperStyle, pages]);

    applyRemoteOpsRef.current = (ops) => {
      const now = Date.now();
      let next = elementsRef.current;
      let applied = 0;
      for (const op of ops) {
        const allowed = guardIncomingOp(deltaStateRef.current, op, now);
        if (!allowed) continue;
        if (allowed.op === "remove") {
          clearStrokeParts(strokePartsRef.current, allowed.id);
          if (!next.some((el) => el.id === allowed.id)) continue;
          next = next.filter((el) => el.id !== allowed.id);
          applied += 1;
          continue;
        }
        const updated = applyLiveAdd(
          next,
          { add: allowed.element, strokePart: allowed.part },
          strokePartsRef.current,
        );
        const added = updated.find((el) => el.id === allowed.id);
        if (added?.kind === "image") ensureImageInCache(added, imgCache.current);
        next = updated;
        applied += 1;
      }
      if (applied === 0) return;
      elementsRef.current = next;
      setElements(next);
      scheduleLivePaintRef.current();
    };

    const releaseHeldDeltas = (): void => {
      const released = flushSenderDeltas(deltaStateRef.current, Date.now());
      for (const event of released) applyRemoteOpsRef.current(event.ops);
      if (hasHeldDeltas(deltaStateRef.current)) armReorderFlush();
    };

    function armReorderFlush(): void {
      if (reorderTimerRef.current !== null) return;
      reorderTimerRef.current = setTimeout(() => {
        reorderTimerRef.current = null;
        releaseHeldDeltas();
      }, 25);
    }

    ingestRemoteEventRef.current = (event) => {
      const released = pushSenderDelta(deltaStateRef.current, event, Date.now());
      for (const item of released) applyRemoteOpsRef.current(item.ops);
      if (hasHeldDeltas(deltaStateRef.current)) armReorderFlush();
    };

    useEffect(() => {
      return () => {
        if (reorderTimerRef.current !== null) {
          clearTimeout(reorderTimerRef.current);
          reorderTimerRef.current = null;
        }
      };
    }, []);

    const dailyUserId = senderIdRef.current;
    const dailyLink = useDailyWhiteboard({
      userId: dailyUserId,
      readBoard: () => ({
        paperStyle: paperStyleRef.current,
        elements: elementsRef.current.flatMap((element) => {
          const sync = toSyncEl(element);
          return sync ? [{ ...sync, id: sync.id }] : [];
        }) as Array<Record<string, unknown> & { id: string }>,
      }),
      onLiveSnapshot: (board) => {
        const drawn: DrawEl[] = [];
        for (const element of board.elements) {
          const sync = coerceSyncEl(element);
          if (!sync) continue;
          const next = syncElToDraw(sync);
          if (next) drawn.push(next);
        }
        if (drawn.length === 0) return;
        const nextPaper = isPaperStyle(board.paperStyle) ? board.paperStyle : paperStyleRef.current;
        for (const el of drawn) {
          if (el.kind === "image") ensureImageInCache(el, imgCache.current);
        }
        elementsRef.current = drawn;
        paperStyleRef.current = nextPaper;
        setElements(drawn);
        setPaperStyle(nextPaper);
        const maxPage = drawn.reduce((max, el) => Math.max(max, el.pageIndex), 0);
        setPages((prev) => {
          const target = maxPage + 1;
          if (prev.length >= target) return prev;
          return [
            ...prev,
            ...Array.from({ length: target - prev.length }, (_, index) => ({
              id: nanoid(),
              pageNumber: prev.length + index + 1,
            })),
          ];
        });
        setSyncStatus("live");
        scheduleLivePaintRef.current();
      },
      onBoardDelta: (delta) => {
        ingestRemoteEventRef.current({
          senderId: delta.senderId,
          seq: delta.seq,
          ops: [
            {
              op: delta.op,
              id: delta.id,
              element: delta.element,
              part: delta.part,
            },
          ],
        });
      },
      onLasers: setPeerLasers,
      onLocalLaserIdle: () => {
        if (laserTimerRef.current) {
          clearTimeout(laserTimerRef.current);
          laserTimerRef.current = null;
        }
        setLaserPts(null);
        setLaserPage(null);
        setLaserAlpha(1);
      },
    });
    dailyLinkRef.current = dailyLink;

    useEffect(() => {
      const session = new SnapSession((preview) => {
        const cur = activeRef.current;
        if (!cur || cur.kind !== "pen" || cur.tool !== "pen") return;
        activeRef.current = { ...cur, snap: preview };
        scheduleLivePaintRef.current();
      });
      snapRef.current = session;
      return () => {
        session.dispose();
        if (snapRef.current === session) snapRef.current = null;
        releaseCleanupRef.current?.();
        releaseCleanupRef.current = null;
        if (laserTimerRef.current) {
          clearTimeout(laserTimerRef.current);
          laserTimerRef.current = null;
        }
      };
    }, []);

    paintBoardRef.current = () => {
      const liveActive = presentActiveDrawing(
        activeRef.current ?? active,
        shiftPressedRef.current,
        shouldSnapRecognizedToGrid(paperStyleRef.current),
      );
      const liveCursor = cursorRef.current;
      pages.forEach((page, idx) => {
        const canvas = canvasMap.current.get(page.id);
        if (!canvas) return;
        const cursor =
          liveCursor?.pageIndex === idx ? liveCursor : cursorPt?.pageIndex === idx ? cursorPt : null;
        renderPage(
          canvas,
          idx,
          elementsRef.current,
          liveActive,
          laserPage === idx ? laserPts : null,
          laserAlpha,
          selectedIds,
          selection,
          imgCache.current,
          eraserPt,
          eraserRadius,
          cropState,
          editText?.id ?? null,
          cursor,
          tool,
          tool === "highlighter" ? mmToPx(hlWidthMm) : mmToPx(widthMm),
          color,
          transformMode,
        );
      });
    };

    scheduleLivePaintRef.current = () => {
      if (livePaintRafRef.current !== null) return;
      livePaintRafRef.current = requestAnimationFrame(() => {
        livePaintRafRef.current = null;
        paintBoardRef.current();
      });
    };
    repaintBoardRef.current = () => scheduleLivePaintRef.current();

    useEffect(() => {
      scheduleLivePaintRef.current();
      return () => {
        if (livePaintRafRef.current !== null) {
          cancelAnimationFrame(livePaintRafRef.current);
          livePaintRafRef.current = null;
        }
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
      return pagePointFromClient(e.clientX, e.clientY, r, zoomRef.current);
    }

    const broadcastElement = useCallback((payload: Record<string, unknown>): void => {
      const deliver = (event: Record<string, unknown>): void => {
        const isDelta = event.add != null || Array.isArray(event.remove);
        const stamped: Record<string, unknown> = { ...event, senderId: senderIdRef.current };
        if (isDelta) stamped.seq = nextDeltaSeq(deltaStateRef.current);
        const plan = planBoardDelivery(stamped, dailyLinkRef.current?.isDailyActive() ?? false);
        if (plan.stream) broadcastRef.current?.(stamped);
        if (plan.daily) dailyLinkRef.current?.forwardPayload(stamped);
      };
      const add = payload.add as SyncEl | undefined;
      if (add?.kind === "stroke" && typeof payload.strokePart !== "number") {
        const pieces = liveStrokePieces(add, paperStyleRef.current, senderIdRef.current);
        const events =
          pieces.length <= 1
            ? [{ add: pieces[0] ?? add }]
            : pieces.map((piece, index) => ({ add: piece, strokePart: index }));
        for (const event of events) deliver(event);
        return;
      }
      if (Array.isArray(payload.remove) && payload.remove.length > 1 && payload.add == null) {
        for (const id of payload.remove) {
          if (typeof id === "string" && id.length > 0) deliver({ remove: [id] });
        }
        return;
      }
      deliver(payload);
    }, []);

    const broadcastHistory = useCallback((op: HistoryOp, direction: "forward" | "backward"): void => {
      for (const event of buildHistorySyncEvents(op, direction, senderIdRef.current)) {
        broadcastElement(event as unknown as Record<string, unknown>);
      }
    }, [broadcastElement]);

    const pushHistory = useCallback(
      (op: HistoryOp, sync = false): void => {
        setUndoStack((prev) => [...prev, op]);
        setRedoStack([]);
        if (sync) broadcastHistory(op, "forward");
      },
      [broadcastHistory],
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
      broadcastHistory(op, "backward");
    }, [broadcastHistory]);

    const performRedo = useCallback((): void => {
      const stack = redoStackRef.current;
      if (stack.length === 0) return;
      const op = stack[stack.length - 1];
      ensureHistoryImages(op, imgCache.current);
      setElements((prev) => applyHistoryForward(prev, op));
      setRedoStack((prev) => prev.slice(0, -1));
      setUndoStack((prev) => [...prev, op]);
      broadcastHistory(op, "forward");
    }, [broadcastHistory]);

    useEffect(() => {
      if (!streamChannel) {
        broadcastRef.current = null;
        emitBoardEventRef.current = () => {};
        snapshotRequestedRef.current = false;
        awaitingSnapshotRef.current = false;
        snapshotBuffersRef.current.clear();
        historySyncBuffersRef.current.clear();
        return;
      }
      const emit = (payload: Record<string, unknown>): void => {
        const gate = gateBoardPayload(skippedSyncCountRef.current, payload);
        if (gate.skip) {
          skippedSyncCountRef.current = gate.nextCount;
          setSyncStatus("error");
          return;
        }
        const eventPayload = { type: BOARD_EVENT, v: PROTO_V, ...payload };
        void (async () => {
          try {
            await streamChannel.sendEvent(eventPayload as unknown as Parameters<Channel["sendEvent"]>[0]);
            setSyncStatus("live");
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn("[Stream Whiteboard] Safe sendEvent failure caught:", message);
            if (!/size|limit|payload|2000|4096/i.test(message)) setSyncStatus("error");
          }
        })();
      };
      emitBoardEventRef.current = emit;
      broadcastRef.current = makeThrottle((payload: Record<string, unknown>): void => {
        if (applyRemote.current) return;
        emit(payload);
      }, 0);
      setSyncStatus("live");
    }, [streamChannel]);

    useEffect(() => {
      if (!streamChannel) return;
      historySyncBuffersRef.current.clear();

      const applySnapshot = (elements: DrawEl[], nextPaper: PaperStyle): void => {
        for (const el of elements) {
          if (el.kind === "image") ensureImageInCache(el, imgCache.current);
        }
        elementsRef.current = elements;
        paperStyleRef.current = nextPaper;
        setElements(elements);
        setPaperStyle(nextPaper);
        const maxPage = elements.reduce((max, el) => Math.max(max, el.pageIndex), 0);
        setPages((prev) => {
          const target = maxPage + 1;
          if (prev.length >= target) return prev;
          return [
            ...prev,
            ...Array.from({ length: target - prev.length }, (_, i) => ({
              id: nanoid(),
              pageNumber: prev.length + i + 1,
            })),
          ];
        });
        scheduleLivePaintRef.current();
      };

      const publishSnapshot = (): void => {
        if (!shouldAnswerSnapshotRequest(elementsRef.current.length)) return;
        const chunks = buildSnapshotChunks(
          elementsRef.current,
          paperStyleRef.current,
          nanoid(),
          senderIdRef.current,
        );
        for (const chunk of chunks) emitBoardEventRef.current(chunk);
      };

      const onEvent = (ev: SyncEvent): void => {
        if (ev.type !== BOARD_EVENT || (ev.v !== PROTO_V && ev.v !== 5 && ev.v !== 4)) return;
        if (ev.senderId === senderIdRef.current) return;
        applyRemote.current = true;
        try {
          if (ev.action === "request_snapshot") {
            publishSnapshot();
            return;
          }
          if (ev.action === "snapshot_chunk") {
            if (!awaitingSnapshotRef.current) return;
            const chunk = parseSnapshotChunk(ev);
            if (chunk) {
              const ready = noteSnapshotChunk(snapshotBuffersRef.current, chunk);
              if (ready) {
                awaitingSnapshotRef.current = false;
                if (peerSnapshotAction(ready.elements.length, elementsRef.current.length) === "ignore") {
                  return;
                }
                applySnapshot(ready.elements, ready.paperStyle);
              }
            }
            return;
          }
          if (ev.action === "paper_style_change") {
            const nextPaper = readPaperStyleChange(ev);
            if (nextPaper) {
              paperStyleRef.current = nextPaper;
              setPaperStyle(nextPaper);
            }
            return;
          }
          if (ev.action === "clear") {
            const now = Date.now();
            for (const el of elementsRef.current) tombstoneElement(deltaStateRef.current, el.id, now);
            strokePartsRef.current.clear();
            activeRef.current = null;
            cursorRef.current = null;
            elementsRef.current = [];
            setActive(null);
            setElements([]);
            setSelectedIds(new Set());
            setSelection(null);
            setEditText(null);
            setSyncStatus("live");
            return;
          }
          const historyReady = noteHistorySyncEvent(historySyncBuffersRef.current, ev);
          if (historyReady) {
            if (historyReady.direction === "forward") {
              const now = Date.now();
              for (const el of historyReady.op.removed) {
                tombstoneElement(deltaStateRef.current, el.id, now);
                clearStrokeParts(strokePartsRef.current, el.id);
              }
            }
            applyHistoryRemote(historyReady.op, historyReady.direction);
          }
          const ops: RemoteBoardOp[] = [];
          if (ev.add !== undefined && ev.add !== null && typeof ev.add === "object") {
            const record = ev.add as { id?: unknown };
            if (typeof record.id === "string" && record.id.length > 0) {
              ops.push({
                op: "add",
                id: record.id,
                element: ev.add,
                part: typeof ev.strokePart === "number" ? ev.strokePart : undefined,
              });
            }
          }
          if (Array.isArray(ev.remove)) {
            for (const id of ev.remove) {
              if (typeof id === "string" && id.length > 0) ops.push({ op: "remove", id });
            }
          }
          if (ops.length > 0) {
            ingestRemoteEventRef.current({
              senderId: typeof ev.senderId === "string" ? ev.senderId : "",
              seq: typeof ev.seq === "number" ? ev.seq : undefined,
              ops,
            });
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
      const waitingForServer = Boolean(notebookId && startPage != null && !snapshotsReady);
      const serverHydrated = Boolean(notebookId && startPage != null && snapshotsReady);
      if (
        shouldRequestPeerSnapshot({
          serverHydrated,
          waitingForServer,
          alreadyRequested: snapshotRequestedRef.current,
          elementCount: elementsRef.current.length,
        })
      ) {
        snapshotRequestedRef.current = true;
        awaitingSnapshotRef.current = true;
        emitBoardEventRef.current(buildRequestSnapshot(senderIdRef.current, Date.now()));
      }
      setSyncStatus("live");
      return () => {
        if (typeof unbound === "object" && unbound && "unsubscribe" in unbound) {
          (unbound as { unsubscribe: () => void }).unsubscribe();
        } else {
          streamChannel.off(BOARD_EVENT as "message.new", onEvent as never);
        }
      };
    }, [streamChannel, applyHistoryRemote, snapshotsReady, notebookId, startPage]);

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

    const armPointerRelease = (): void => {
      releaseCleanupRef.current?.();
      const onRelease = (event: PointerEvent): void => {
        releaseCleanupRef.current?.();
        releaseCleanupRef.current = null;
        onUpRef.current(event);
      };
      window.addEventListener("pointerup", onRelease);
      window.addEventListener("pointercancel", onRelease);
      releaseCleanupRef.current = () => {
        window.removeEventListener("pointerup", onRelease);
        window.removeEventListener("pointercancel", onRelease);
      };
    };

    const onDown = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>, pageIndex: number): void => {
        e.preventDefault();
        shiftPressedRef.current = e.shiftKey;
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
          dailyLinkRef.current?.notifyMove(pt.x, pt.y, pageIndex);
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
            snap: null,
          };
          activeRef.current = na;
          cursorRef.current = { x: pt.x, y: pt.y, pageIndex };
          e.currentTarget.style.cursor = "none";
          scheduleLivePaintRef.current();
          if (tool === "pen") {
            snapRef.current?.begin(pt.x, pt.y, performance.now());
            armPointerRelease();
          }
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
          cursorRef.current = { x: pt.x, y: pt.y, pageIndex };
          scheduleLivePaintRef.current();
        }
      },
      [tool, color, widthMm, hlWidthMm, strokeStyle, shapeKind, applyEraserAt, lassoStyle, cropState],
    );

    const onMove = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>, pageIndex: number): void => {
        shiftPressedRef.current = e.shiftKey;
        const pt = ptFrom(e);
        const live = activeRef.current;
        if (live && live.pageIndex === pageIndex && (live.kind === "pen" || live.kind === "shape")) {
          cursorRef.current = { x: pt.x, y: pt.y, pageIndex };
          if (live.kind === "pen") {
            if (live.tool === "pen") snapRef.current?.move(pt.x, pt.y, performance.now());
            const snap = activeRef.current?.kind === "pen" ? activeRef.current.snap : null;
            live.points.push(pt);
            activeRef.current = { ...live, snap };
          } else {
            activeRef.current = { ...live, end: pt };
          }
          scheduleLivePaintRef.current();
          return;
        }
        if (!live && (tool === "pen" || tool === "highlighter" || tool === "shapes")) {
          cursorRef.current = { x: pt.x, y: pt.y, pageIndex };
          e.currentTarget.style.cursor = tool === "shapes" ? "crosshair" : "none";
          scheduleLivePaintRef.current();
          return;
        }
        cursorRef.current = { x: pt.x, y: pt.y, pageIndex };
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
          dailyLinkRef.current?.notifyMove(pt.x, pt.y, pageIndex);
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
      },
      [tool, selection, applyEraserAt, cropState],
    );

    const onUp = useCallback((event?: { shiftKey?: boolean }): void => {
      if (typeof event?.shiftKey === "boolean") shiftPressedRef.current = event.shiftKey;
      releaseCleanupRef.current?.();
      releaseCleanupRef.current = null;

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
        dailyLinkRef.current?.notifyRelease();
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
      if (livePaintRafRef.current !== null) {
        cancelAnimationFrame(livePaintRafRef.current);
        livePaintRafRef.current = null;
      }
      activeRef.current = null;
      cursorRef.current = null;
      setActive(null);

      if (cur.kind === "pen") {
        const recognized = cur.tool === "pen" ? snapRef.current?.finish(performance.now()) ?? null : null;
        const aligned =
          recognized && shiftPressedRef.current
            ? alignRecognizedShape(recognized, { constrainLine: true })
            : recognized;
        const draft = aligned
          ? draftFromRecognized(aligned, {
              snapToGrid: shouldSnapRecognizedToGrid(paperStyleRef.current),
            })
          : null;
        if (draft) {
          const el: ShapeEl = {
            kind: "shape",
            id: nanoid(),
            shape: draft.shape,
            color: cur.color,
            width: cur.width,
            strokeStyle: cur.strokeStyle,
            x: draft.x,
            y: draft.y,
            w: draft.w,
            h: draft.h,
            pageIndex: cur.pageIndex,
            ...(draft.vertices ? { vertices: draft.vertices } : {}),
          };
          pushHistory({ id: nanoid(), removed: [], added: [el], updated: [] });
          setElements((prev) => [...prev, el]);
          const sync = toSyncEl(el);
          if (sync) broadcastElement({ add: sync });
        } else {
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
        }
      } else if (cur.kind === "shape") {
        const end = constrainLineEnd(
          cur.start,
          cur.end,
          shiftPressedRef.current && (cur.shape === "line" || cur.shape === "arrow"),
        );
        const el: ShapeEl = {
          kind: "shape",
          id: nanoid(),
          shape: cur.shape,
          color: cur.color,
          width: cur.width,
          strokeStyle: cur.strokeStyle,
          x: cur.start.x,
          y: cur.start.y,
          w: end.x - cur.start.x,
          h: end.y - cur.start.y,
          pageIndex: cur.pageIndex,
        };
        pushHistory({ id: nanoid(), removed: [], added: [el], updated: [] });
        setElements((prev) => [...prev, el]);
        const sync = toSyncEl(el);
        if (sync) broadcastElement({ add: sync });
      }
    }, [tool, selection, finalizeSelection, broadcastElement, pushHistory, cropState]);

    onUpRef.current = onUp;

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

    const uploadBoardFile = useCallback(async (file: File): Promise<string | null> => {
      if (!notebookId) {
        setAiHint(NOTEBOOK_NOT_READY_HINT);
        return null;
      }
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("notebookId", notebookId);
        const res = await fetch("/api/upload", { method: "POST", body: formData });
        if (!res.ok) {
          console.error("[whiteboard] upload:", await res.text());
          setAiHint("לא הצלחנו להעלות את התמונה. נסו שוב.");
          return null;
        }
        const data = (await res.json()) as { id?: string };
        if (typeof data.id !== "string" || data.id.length === 0) {
          setAiHint("לא הצלחנו להעלות את התמונה. נסו שוב.");
          return null;
        }
        return data.id;
      } catch (err) {
        console.error("[whiteboard] image error:", err);
        setAiHint("לא הצלחנו להעלות את התמונה. נסו שוב.");
        return null;
      }
    }, [notebookId]);

    const insertImageElement = useCallback(
      async (
        imageId: string,
        placement?: { pageIndex?: number; point?: { x: number; y: number }; staggerIndex?: number },
      ): Promise<boolean> => {
        const pageIndex = placement?.pageIndex ?? activePageIndex;
        const shell: ImageEl = {
          kind: "image",
          id: imageId,
          imageId,
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          rotation: 0,
          crop: null,
          pageIndex,
        };
        const img = await loadBoardImage(shell, imgCache.current, () => repaintBoardRef.current());
        if (!img) {
          setAiHint("לא הצלחנו להציג את התמונה. נסו שוב.");
          return false;
        }
        const maxH = PAGE_H - 40;
        const sc = Math.min(IMAGE_MAX_WIDTH / img.naturalWidth, maxH / img.naturalHeight, 1);
        const w = Math.max(1, Math.floor(img.naturalWidth * sc));
        const h = Math.max(1, Math.floor(img.naturalHeight * sc));
        const centeredX = Math.max(20, (PAGE_W - w) / 2);
        const centeredY = Math.max(20, (PAGE_H - h) / 2);
        const stagger = (placement?.staggerIndex ?? 0) * BOARD_DND_STAGGER_PX;
        let x = centeredX;
        let y = centeredY;
        if (placement?.point) {
          x = clampOnPage(placement.point.x + stagger, w, PAGE_W);
          y = clampOnPage(placement.point.y + stagger, h, PAGE_H);
        } else if (stagger !== 0) {
          x = clampOnPage(centeredX + stagger, w, PAGE_W);
          y = clampOnPage(centeredY + stagger, h, PAGE_H);
        }
        const el: ImageEl = {
          ...shell,
          x,
          y,
          w,
          h,
        };
        pushHistory({ id: nanoid(), removed: [], added: [el], updated: [] });
        setElements((prev) => [...prev, el]);
        const sync = toSyncEl(el);
        if (sync) broadcastElement({ add: sync });
        return true;
      },
      [activePageIndex, broadcastElement, pushHistory],
    );

    const handleImageFile = useCallback(
      async (
        file: File,
        placement?: { pageIndex?: number; point?: { x: number; y: number }; staggerIndex?: number },
      ): Promise<void> => {
        let prepared: File;
        try {
          const result = await prepareBoardImageFile(file);
          if ("error" in result) {
            setAiHint(IMAGE_STILL_TOO_LARGE_HINT);
            return;
          }
          prepared = result.file;
        } catch (err) {
          console.error("[whiteboard] image prepare:", err);
          setAiHint("לא הצלחנו להעלות את התמונה. נסו שוב.");
          return;
        }
        const imageId = await uploadBoardFile(prepared);
        if (!imageId) return;
        await insertImageElement(imageId, placement);
      },
      [insertImageElement, uploadBoardFile],
    );

    const readCanvasHits = useCallback((): CanvasHit[] => {
      const hits: CanvasHit[] = [];
      pages.forEach((page, pageIndex) => {
        const canvas = canvasMap.current.get(page.id);
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        hits.push({
          pageIndex,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        });
      });
      return hits;
    }, [pages]);

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
          const fetched = await fetch(src);
          if (!fetched.ok) {
            setAiHint("לא הצלחנו להעלות את התמונה. נסו שוב.");
            return;
          }
          const blob = await fetched.blob();
          const file = new File([blob], "asset.png", { type: blob.type || "image/png" });
          const imageId = await uploadBoardFile(file);
          if (!imageId) return;
          const ok = await insertImageElement(imageId);
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
      [insertImageElement, resolveAssetImageSrc, uploadBoardFile],
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
          broadcastElement({ add: sync });
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
      const publishShapeMarker = (armCopyEvent: boolean): void => {
        if (clipboardRef.current.length === 0) return;
        const marker = issueBoardShapeMarker();
        shapeMarkerRef.current = marker;
        if (armCopyEvent) shapeCopyArmedRef.current = true;
        try {
          const pending = navigator.clipboard?.writeText(marker);
          if (pending && typeof pending.catch === "function") void pending.catch(() => {});
        } catch {
          // The copy event handler writes the marker when this API is unavailable.
        }
      };
      const onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === "Shift") {
          if (!shiftPressedRef.current) {
            shiftPressedRef.current = true;
            scheduleLivePaintRef.current();
          }
          return;
        }
        const action = readWhiteboardShortcut(e);
        if (action === "copy") {
          if (isTargetEditable(e.target) || editText) return;
          if (selectedRef.current.size === 0) return;
          copySelection();
          publishShapeMarker(true);
        } else if (action === "cut") {
          e.preventDefault();
          if (editText) cutEditText();
          else {
            const hadSelection = selectedRef.current.size > 0;
            cutSelection();
            if (hadSelection) publishShapeMarker(false);
          }
        } else if (action === "paste") {
          return;
        } else if (action === "duplicate") {
          e.preventDefault();
          if (editText) duplicateEditText();
          else duplicateSelection();
        } else if (action === "redo") {
          e.preventDefault();
          performRedo();
        } else if (action === "undo") {
          e.preventDefault();
          performUndo();
        } else if (action === "delete") {
          if (editText) return;
          e.preventDefault();
          deleteSelection();
        }
      };
      const onKeyUp = (e: KeyboardEvent): void => {
        if (e.key !== "Shift" || !shiftPressedRef.current) return;
        shiftPressedRef.current = false;
        scheduleLivePaintRef.current();
      };
      const onBlur = (): void => {
        if (!shiftPressedRef.current) return;
        shiftPressedRef.current = false;
        scheduleLivePaintRef.current();
      };
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      window.addEventListener("blur", onBlur);
      return () => {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", onBlur);
      };
    }, [
      copySelection,
      deleteSelection,
      cutSelection,
      cutEditText,
      duplicateSelection,
      duplicateEditText,
      editText,
      performUndo,
      performRedo,
    ]);

    useEffect(() => {
      const blockFileNavigation = (event: DragEvent): void => {
        if (!dataTransferHasFiles(event.dataTransfer)) return;
        event.preventDefault();
      };
      const clearDrag = (): void => {
        dragDepthRef.current = 0;
        setIsDraggingOver(false);
      };
      window.addEventListener("dragover", blockFileNavigation);
      window.addEventListener("drop", blockFileNavigation);
      window.addEventListener("dragend", clearDrag);
      return () => {
        window.removeEventListener("dragover", blockFileNavigation);
        window.removeEventListener("drop", blockFileNavigation);
        window.removeEventListener("dragend", clearDrag);
      };
    }, []);

    useEffect(() => {
      const onCopy = (event: ClipboardEvent): void => {
        if (!shapeCopyArmedRef.current) return;
        shapeCopyArmedRef.current = false;
        if (isTargetEditable(event.target) || editText) return;
        if (clipboardRef.current.length === 0) return;
        const marker = shapeMarkerRef.current;
        if (!marker) return;
        try {
          event.clipboardData?.setData("text/plain", marker);
          event.preventDefault();
        } catch {
          // keydown writeText is the fallback when clipboardData cannot be set
        }
      };
      const onPaste = (event: ClipboardEvent): void => {
        const report = inspectImageDataTransfer(event.clipboardData);
        const targetEditable = isTargetEditable(event.target) || editText !== null;
        const action = decidePasteAction({
          imageFiles: report.accepted,
          internalClipboardCount: clipboardRef.current.length,
          targetEditable,
          hasInternalMarker: clipboardDataHasBoardShapeMarker(event.clipboardData),
        });
        if (action !== "ignore") event.preventDefault();
        const viewport = scrollRef.current?.getBoundingClientRect();
        const visible = viewport
          ? mostVisiblePageIndex(
              { left: viewport.left, top: viewport.top, right: viewport.right, bottom: viewport.bottom },
              readCanvasHits(),
            )
          : null;
        void applyPasteDecision(action, {
          notebookId,
          files: report.accepted,
          pageIndex: visible ?? activePageIndex,
          sizeRejected: !targetEditable && report.rejected.some((item) => item.reason === "size"),
          pasteClipboard,
          handleImageFile: (file, placement) => handleImageFile(file, placement),
          notify: setAiHint,
        });
      };
      window.addEventListener("copy", onCopy);
      window.addEventListener("paste", onPaste);
      return () => {
        window.removeEventListener("copy", onCopy);
        window.removeEventListener("paste", onPaste);
      };
    }, [activePageIndex, editText, handleImageFile, notebookId, pasteClipboard, readCanvasHits]);

    const collectExportFrames = useCallback(async (): Promise<ExportFrame[]> => {
      const frames: ExportFrame[] = [];
      for (let idx = 0; idx < pages.length; idx += 1) {
        const dataUrl = await renderPageDataUrl(idx, elements, imgCache.current, paperStyle);
        if (!dataUrl) continue;
        frames.push({
          pageNumber: pages[idx].pageNumber,
          width: PAGE_W,
          height: PAGE_H,
          dataUrl,
        });
      }
      return frames;
    }, [elements, pages, paperStyle]);

    const exportBoardToPdf = useCallback(
      async (targetLessonId?: string): Promise<string | null> => {
        const storageLessonId = (targetLessonId ?? lessonId ?? "").trim();
        if (!storageLessonId) return null;
        const frames = await collectExportFrames();
        if (frames.length === 0) return null;
        try {
          const res = await fetch("/api/excalidraw/export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ frames, lessonId: storageLessonId }),
          });
          if (!res.ok) {
            console.error("[whiteboard] export:", await res.text());
            return null;
          }
          const data = (await res.json()) as { url?: string | null; pdfUrl?: string | null };
          const url = data.url ?? data.pdfUrl ?? null;
          return typeof url === "string" && url.startsWith("http") ? url : null;
        } catch (err) {
          console.error("[whiteboard] export:", err);
          return null;
        }
      },
      [collectExportFrames, lessonId],
    );

    const clearCanvas = useCallback((): void => {
      if (livePaintRafRef.current !== null) {
        cancelAnimationFrame(livePaintRafRef.current);
        livePaintRafRef.current = null;
      }
      activeRef.current = null;
      cursorRef.current = null;
      const removed = elementsRef.current.slice();
      const opId = nanoid();
      elementsRef.current = [];
      setActive(null);
      setElements([]);
      setSelectedIds(new Set());
      setSelection(null);
      setEditText(null);
      if (removed.length > 0) {
        setUndoStack((prev) => [...prev, { id: opId, removed, added: [], updated: [] }]);
        setRedoStack([]);
      }
      for (const event of buildClearCanvasEvents(removed, opId, senderIdRef.current)) {
        broadcastElement(event as unknown as Record<string, unknown>);
      }
    }, [broadcastElement]);

    useImperativeHandle(
      ref,
      () => ({
        exportBoardToPdf,
        clearCanvas,
        flushSnapshots: () => flushSnapshots("complete"),
      }),
      [clearCanvas, exportBoardToPdf, flushSnapshots],
    );

    const exportPdfDirect = useCallback(async (): Promise<void> => {
      if (lessonId) {
        await exportBoardToPdf(lessonId);
      }
      const frames = await collectExportFrames();
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
    }, [collectExportFrames, exportBoardToPdf, lessonId]);

    const exportPngDirect = useCallback((): void => {
      const pageIndex = activePageIndex;
      void renderPageDataUrl(pageIndex, elements, imgCache.current, paperStyle).then((dataUrl) => {
        if (!dataUrl) return;
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `whiteboard-page-${pageIndex + 1}.png`;
        a.click();
      });
    }, [activePageIndex, elements, paperStyle]);

    const syncLabel =
      snapshotSync === "error"
        ? "השמירה לא הצליחה"
        : snapshotSync === "saving"
          ? "שומרים את המחברת"
          : !streamChannel
            ? "לוח מקומי"
            : syncStatus === "live"
              ? "מסונכרן"
              : syncStatus === "error"
                ? "שגיאה"
                : "מתחבר";

    const pagePaperStyle = paperBackgroundStyle(paperStyle);

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

    const PaperPopover = (): React.ReactElement => (
      <Popover width={248}>
        <div className="grid grid-cols-2 gap-1.5">
          {PAPER_OPTIONS.map((opt) => {
            const selected = paperStyle === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                title={opt.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setPaperStyle(opt.value);
                  paperStyleRef.current = opt.value;
                  setOpenMenu(null);
                  broadcastElement({ action: "paper_style_change", paperStyle: opt.value });
                }}
                className={`flex flex-col gap-1 rounded-xl p-1.5 text-start transition-all ${
                  selected
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-600 hover:bg-neutral-100"
                }`}
              >
                <span
                  aria-hidden
                  className={`block h-10 w-full rounded-md border ${
                    selected ? "border-white/30" : "border-neutral-200"
                  }`}
                  style={paperBackgroundStyle(opt.value)}
                />
                <span className="px-0.5 text-[13px] font-semibold">{opt.label}</span>
              </button>
            );
          })}
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
        if (!notebookId) {
          setAiHint(NOTEBOOK_NOT_READY_HINT);
          setOpenMenu(null);
          return;
        }
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

    if (snapshotPhase === "skeleton") {
      return (
        <div
          role="status"
          aria-live="polite"
          dir="ltr"
          className="relative flex h-full min-h-[140px] w-full items-center justify-center overflow-hidden bg-[#fafaf9]"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundColor: "#ffffff",
              backgroundImage:
                "linear-gradient(to right, #f1f5f9 1px, transparent 1px), linear-gradient(to bottom, #f1f5f9 1px, transparent 1px)",
              backgroundSize: "24px 24px",
            }}
          />
          <div className="relative flex items-center gap-2 rounded-full border border-neutral-200/80 bg-white/85 px-4 py-2 text-sm font-medium text-neutral-600 shadow-sm">
            <span
              aria-hidden
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900"
            />
            טוענים את המחברת
          </div>
        </div>
      );
    }

    return (
      <div
        ref={containerRef}
        className="relative w-full h-full overflow-hidden"
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

              <div className="relative shrink-0">
                <button
                  type="button"
                  title="רקע הדף"
                  onClick={() => setOpenMenu((prev) => (prev === "paper" ? null : "paper"))}
                  className={`h-8 px-2.5 shrink-0 rounded-xl text-xs font-semibold flex items-center transition-all ${
                    openMenu === "paper"
                      ? "bg-neutral-900 text-white"
                      : "bg-white text-neutral-700 border border-neutral-200 hover:bg-neutral-50"
                  }`}
                >
                  {PAPER_OPTIONS.find((opt) => opt.value === paperStyle)?.label ?? "משבצות"}
                </button>
                {openMenu === "paper" && <PaperPopover />}
              </div>

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
                    snapshotSync === "error" || syncStatus === "error"
                      ? "bg-red-400"
                      : snapshotSync === "saving"
                        ? "bg-amber-400"
                        : syncStatus === "live" || snapshotSync === "saved"
                          ? "bg-emerald-400 animate-pulse"
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
          className="w-full h-full overflow-auto overscroll-x-contain"
          style={{ background: DESK_BG, touchAction: "pan-x pan-y" }}
          onContextMenu={(e) => e.preventDefault()}
          onDragEnter={(e) => {
            if (!dataTransferHasFiles(e.dataTransfer)) return;
            e.preventDefault();
            dragDepthRef.current += 1;
            setIsDraggingOver(true);
          }}
          onDragOver={(e) => {
            if (!dataTransferHasFiles(e.dataTransfer)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(e) => {
            if (!dataTransferHasFiles(e.dataTransfer)) return;
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) setIsDraggingOver(false);
          }}
          onDrop={(e) => {
            if (!dataTransferHasFiles(e.dataTransfer)) return;
            e.preventDefault();
            dragDepthRef.current = 0;
            setIsDraggingOver(false);
            const report = inspectImageDataTransfer(e.dataTransfer);
            const decision = decideImageDrop({
              notebookId,
              clientX: e.clientX,
              clientY: e.clientY,
              zoom: zoomRef.current,
              canvases: readCanvasHits(),
              files: report.accepted,
              sizeRejections: report.rejected.filter((item) => item.reason === "size").length,
            });
            void applyImageDropDecision(
              decision,
              (file, placement) => handleImageFile(file, placement),
              setAiHint,
            );
          }}
        >
          <div
            className="mx-auto flex flex-col items-center"
            style={{
              width: PAGE_W + PAGE_GAP,
              minWidth: PAGE_W + PAGE_GAP,
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
                  style={{ width: PAGE_W, height: PAGE_H, ...pagePaperStyle }}
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
                      if (tool === "laser") dailyLinkRef.current?.notifyRelease();
                    }}
                    onDoubleClick={(e) => onDblClick(e, idx)}
                    onContextMenu={onContextMenu}
                  />
                  {peerLasers.some((laser) => laser.pageIndex === idx && laser.active) && (
                    <svg
                      aria-hidden
                      className="pointer-events-none absolute inset-0 z-20"
                      width={PAGE_W}
                      height={PAGE_H}
                      viewBox={`0 0 ${PAGE_W} ${PAGE_H}`}
                    >
                      {peerLasers
                        .filter((laser) => laser.pageIndex === idx && laser.active)
                        .map((laser) => (
                          <circle key={laser.userId} cx={laser.x} cy={laser.y} r={7} fill={laser.color} fillOpacity={0.95} />
                        ))}
                    </svg>
                  )}

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

        {isDraggingOver && (
          <div
            className="pointer-events-none absolute inset-0 z-[30] border-2 border-emerald-600/70 bg-emerald-500/10"
            aria-hidden
          />
        )}

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
