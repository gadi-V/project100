import { BOARD_DOWNSCALE_OVER_BYTES, BOARD_UPLOAD_MAX_BYTES, imagePreparePlan } from "./prepare-board-image";

/** GIF cap, and the cap `prepareBoardImageFile` enforces on a compressed jpeg, png, or webp. */
export const BOARD_DND_MAX_BYTES = BOARD_UPLOAD_MAX_BYTES;

/**
 * Raw jpeg, png, and webp larger than this are refused before decode.
 * Smaller photos are handed to `prepareBoardImageFile`, which enforces `BOARD_UPLOAD_MAX_BYTES` on the result.
 */
export const BOARD_DND_RAW_MAX_BYTES = 25 * 1024 * 1024;

export const NOTEBOOK_NOT_READY_HINT = "המחברת עדיין לא מוכנה. נסו שוב בעוד רגע.";
export const IMAGE_STILL_TOO_LARGE_HINT = "התמונה עדיין גדולה מדי אחרי הכיווץ. נסו קובץ קטן יותר.";

/** One drop or paste may place at most this many images. */
export const BOARD_DND_MAX_FILES = 5;

/** Page-pixel cascade step. Matches the board's existing paste nudge (`PASTE_OFFSET`). */
export const BOARD_DND_STAGGER_PX = 24;

export const ACCEPTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

const ACCEPTED_IMAGE_MIME = new Set<string>(ACCEPTED_IMAGE_MIME_TYPES);

export type ImageRejectReason = "mime" | "size" | "directory" | "empty";

export type RejectedImageDrop = {
  name: string;
  reason: ImageRejectReason;
};

export type ImageTransferReport = {
  accepted: File[];
  rejected: RejectedImageDrop[];
  /** Valid images that arrived after the 5-file cap was full. */
  truncated: File[];
};

type EditableNode = {
  tagName?: string;
  isContentEditable?: boolean;
  contentEditable?: string;
  getAttribute?: (name: string) => string | null;
  classList?: { contains?: (token: string) => boolean };
  className?: string | { baseVal?: string };
  parentElement?: EditableNode | null;
  parentNode?: EditableNode | null;
};

type EntryLike = { isDirectory?: boolean };

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA"]);
const EXCALIDRAW_TEXT_EDITOR = /(?:^|\s)excalidraw-textEditor/;

function readList<T>(list: ArrayLike<T> | null | undefined): T[] {
  if (!list || typeof list.length !== "number" || list.length <= 0) return [];
  const out: T[] = [];
  try {
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      if (entry != null) out.push(entry);
    }
  } catch {
    return out;
  }
  return out;
}

function fileKey(file: File): string {
  const modified = typeof file.lastModified === "number" ? file.lastModified : 0;
  return `${file.name}\0${file.size}\0${file.type}\0${modified}`;
}

function mimeOf(file: File): string {
  return typeof file.type === "string" ? file.type.trim().toLowerCase() : "";
}

function entryIsDirectory(item: DataTransferItem): boolean {
  const read = (item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry;
  if (typeof read !== "function") return false;
  try {
    return Boolean(read.call(item)?.isDirectory);
  } catch {
    return false;
  }
}

function fileFromItem(item: DataTransferItem): File | null {
  if (typeof item.getAsFile !== "function") return null;
  try {
    return item.getAsFile();
  } catch {
    return null;
  }
}

function emptyReport(): ImageTransferReport {
  return { accepted: [], rejected: [], truncated: [] };
}

/**
 * Split a drop or paste payload into files the board can place.
 * `items` is preferred for directory detection; `files` is always scanned as well
 * and duplicates are ignored. String items (HTML, plain text, internal markup) are skipped.
 */
export function inspectImageDataTransfer(dt: DataTransfer | null | undefined): ImageTransferReport {
  if (!dt) return emptyReport();

  const report = emptyReport();
  const seen = new Set<string>();

  const consider = (file: File | null, directory: boolean): void => {
    if (!file) {
      report.rejected.push({ name: "", reason: directory ? "directory" : "empty" });
      return;
    }
    const key = fileKey(file);
    if (seen.has(key)) return;
    seen.add(key);

    if (directory) {
      report.rejected.push({ name: file.name, reason: "directory" });
      return;
    }
    if (!Number.isFinite(file.size) || file.size <= 0) {
      report.rejected.push({ name: file.name, reason: "empty" });
      return;
    }
    const mime = mimeOf(file);
    if (!ACCEPTED_IMAGE_MIME.has(mime)) {
      report.rejected.push({ name: file.name, reason: "mime" });
      return;
    }
    if (incomingFileTooLarge(mime, file.size)) {
      report.rejected.push({ name: file.name, reason: "size" });
      return;
    }
    if (report.accepted.length >= BOARD_DND_MAX_FILES) {
      report.truncated.push(file);
      return;
    }
    report.accepted.push(file);
  };

  let items: DataTransferItem[] = [];
  try {
    items = readList(dt.items);
  } catch {
    items = [];
  }
  for (const item of items) {
    if (item.kind !== "file") continue;
    const directory = entryIsDirectory(item);
    consider(fileFromItem(item), directory);
  }

  let files: File[] = [];
  try {
    files = readList(dt.files);
  } catch {
    files = [];
  }
  for (const file of files) consider(file, false);

  return report;
}

/**
 * A GIF over 4MB cannot be compressed. A jpeg, png, or webp is refused only above the raw memory cap;
 * `imagePreparePlan` is what the upload path uses to decide that those three types can be downscaled.
 */
function incomingFileTooLarge(type: string, size: number): boolean {
  const compresses = imagePreparePlan({ type, size: BOARD_DOWNSCALE_OVER_BYTES + 1 }) === "downscale";
  if (compresses) return size > BOARD_DND_RAW_MAX_BYTES;
  return size > BOARD_UPLOAD_MAX_BYTES;
}

/** Valid images from a drop or paste, capped at 5. GIFs must already be within 4MB. */
export function imageFilesFromDataTransfer(dt: DataTransfer | null | undefined): File[] {
  return inspectImageDataTransfer(dt).accepted;
}

/**
 * True when the event target is a text field the board must not steal from.
 * Walks ancestors so a text node inside the board textarea, or inside a
 * contenteditable region, still counts. An explicit `contenteditable="false"`
 * stops the walk. This board does not use Excalidraw; the Excalidraw editor
 * classes are recognized so a focused text editor is never treated as the canvas.
 */
export function isTargetEditable(target: EventTarget | null): boolean {
  const seen = new Set<EditableNode>();
  let node = asEditableNode(target);
  while (node && !seen.has(node)) {
    seen.add(node);
    if (EDITABLE_TAGS.has(tagOf(node)) || hasExcalidrawTextEditor(node)) return true;
    const flag = contentEditableFlag(node);
    if (flag === "true") return true;
    if (flag === "false") return false;
    node = parentOf(node);
  }
  return false;
}

function asEditableNode(target: EventTarget | null): EditableNode | null {
  if (!target || typeof target !== "object") return null;
  return target as EditableNode;
}

function tagOf(node: EditableNode): string {
  return typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
}

function classText(node: EditableNode): string {
  if (typeof node.className === "string") return node.className;
  if (node.className && typeof node.className === "object" && typeof node.className.baseVal === "string") {
    return node.className.baseVal;
  }
  return "";
}

function hasExcalidrawTextEditor(node: EditableNode): boolean {
  try {
    if (node.classList?.contains?.("excalidraw-textEditorContainer")) return true;
    if (node.classList?.contains?.("excalidraw-textEditorArea")) return true;
  } catch {
    // A detached or cross-realm node can throw from classList.
  }
  return EXCALIDRAW_TEXT_EDITOR.test(classText(node));
}

function contentEditableFlag(node: EditableNode): "true" | "false" | "inherit" {
  if (node.isContentEditable === true) return "true";
  let raw: string | null = null;
  if (typeof node.contentEditable === "string" && node.contentEditable.length > 0) {
    raw = node.contentEditable;
  } else if (typeof node.getAttribute === "function") {
    try {
      raw = node.getAttribute("contenteditable");
    } catch {
      raw = null;
    }
  }
  if (typeof raw !== "string") return "inherit";
  const value = raw.trim().toLowerCase();
  if (value === "true") return "true";
  if (value === "false") return "false";
  return "inherit";
}

function parentOf(node: EditableNode): EditableNode | null {
  if (node.parentElement && typeof node.parentElement === "object") return node.parentElement;
  if (node.parentNode && typeof node.parentNode === "object") return node.parentNode;
  return null;
}

export type PagePoint = { x: number; y: number };

export type ImageBox = { width: number; height: number };

/**
 * Points for `count` images laid down from `basePoint`, stepping `offsetPx` on both axes.
 * The first point is the base. Count below 1 yields an empty list.
 */
export function calculateStaggeredOffsets(
  basePoint: PagePoint | null | undefined,
  count: number,
  offsetPx: number = BOARD_DND_STAGGER_PX,
): PagePoint[] {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const step = Number.isFinite(offsetPx) ? offsetPx : BOARD_DND_STAGGER_PX;
  const x0 = finiteCoord(basePoint?.x);
  const y0 = finiteCoord(basePoint?.y);
  const points: PagePoint[] = [];
  for (let i = 0; i < total; i += 1) {
    points.push({ x: x0 + i * step, y: y0 + i * step });
  }
  return points;
}

/**
 * Page-space origin for one image in a drop.
 * A single image is centered on the cursor when its placed size is known.
 * Several images share that origin and then cascade by 24px so they do not stack exactly.
 */
export function calculateDroppedImagePosition(
  cursorPoint: PagePoint | null | undefined,
  index: number,
  totalCount: number,
  imageDimensions?: ImageBox,
): PagePoint {
  const cursor = {
    x: finiteCoord(cursorPoint?.x),
    y: finiteCoord(cursorPoint?.y),
  };
  const origin = centeredOrigin(cursor, imageDimensions);
  const total = Number.isFinite(totalCount) ? Math.floor(totalCount) : 1;
  if (total <= 1) return origin;
  const stepIndex = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  return {
    x: origin.x + stepIndex * BOARD_DND_STAGGER_PX,
    y: origin.y + stepIndex * BOARD_DND_STAGGER_PX,
  };
}

function finiteCoord(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function centeredOrigin(cursor: PagePoint, imageDimensions: ImageBox | undefined): PagePoint {
  const width = imageDimensions?.width;
  const height = imageDimensions?.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return cursor;
  }
  return { x: cursor.x - width / 2, y: cursor.y - height / 2 };
}

/**
 * First accepted image on the clipboard, or null when the clipboard is text, HTML,
 * empty, or only non-image files. Image files win over sibling text/HTML items.
 */
export function extractImageFromClipboard(event: ClipboardEvent | null | undefined): File | null {
  if (!event) return null;
  let data: DataTransfer | null = null;
  try {
    data = event.clipboardData;
  } catch {
    return null;
  }
  return imageFilesFromDataTransfer(data)[0] ?? null;
}

export type PasteAction = "images" | "internal" | "ignore";

/**
 * Image files win over copied shapes. An editable target is left to the browser.
 * No image file and a non-empty internal clipboard keeps the existing shape paste.
 */
export function decidePasteAction(input: {
  imageFiles: readonly unknown[];
  internalClipboardCount: number;
  targetEditable: boolean;
}): PasteAction {
  if (input.targetEditable) return "ignore";
  if (input.imageFiles.length > 0) return "images";
  const count = input.internalClipboardCount;
  if (typeof count === "number" && count > 0) return "internal";
  return "ignore";
}

export type CanvasHit = {
  pageIndex: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function pagePointFromClient(
  clientX: number,
  clientY: number,
  canvas: { left: number; top: number },
  zoom: number,
): PagePoint {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    x: (clientX - canvas.left) / scale,
    y: (clientY - canvas.top) / scale,
  };
}

/** The canvas whose viewport rect contains the pointer, in the order given. */
export function canvasPageAtPoint(
  clientX: number,
  clientY: number,
  canvases: readonly CanvasHit[],
): CanvasHit | null {
  for (const canvas of canvases) {
    if (
      clientX >= canvas.left &&
      clientX <= canvas.right &&
      clientY >= canvas.top &&
      clientY <= canvas.bottom
    ) {
      return canvas;
    }
  }
  return null;
}

/** Page with the largest overlap of the scrollport. No overlap returns null. */
export function mostVisiblePageIndex(
  viewport: { left: number; top: number; right: number; bottom: number },
  pages: readonly CanvasHit[],
): number | null {
  let best: { pageIndex: number; area: number } | null = null;
  for (const page of pages) {
    const width = Math.min(viewport.right, page.right) - Math.max(viewport.left, page.left);
    const height = Math.min(viewport.bottom, page.bottom) - Math.max(viewport.top, page.top);
    if (width <= 0 || height <= 0) continue;
    const area = width * height;
    if (!best || area > best.area) best = { pageIndex: page.pageIndex, area };
  }
  return best?.pageIndex ?? null;
}

export type ImageDropDecision =
  | { type: "ignore" }
  | { type: "hint"; message: string }
  | { type: "place"; pageIndex: number; origin: PagePoint; files: File[]; hint: string | null };

/** Outside every canvas: ignore. On a canvas without a notebook: the button's hint. Otherwise place. */
export function decideImageDrop(input: {
  notebookId: string | null | undefined;
  clientX: number;
  clientY: number;
  zoom: number;
  canvases: readonly CanvasHit[];
  files: readonly File[];
  sizeRejections: number;
}): ImageDropDecision {
  const hit = canvasPageAtPoint(input.clientX, input.clientY, input.canvases);
  if (!hit) return { type: "ignore" };
  if (!input.notebookId) return { type: "hint", message: NOTEBOOK_NOT_READY_HINT };
  const files = [...input.files];
  if (files.length === 0) {
    if (input.sizeRejections > 0) return { type: "hint", message: IMAGE_STILL_TOO_LARGE_HINT };
    return { type: "ignore" };
  }
  return {
    type: "place",
    pageIndex: hit.pageIndex,
    origin: pagePointFromClient(input.clientX, input.clientY, hit, input.zoom),
    files,
    hint: input.sizeRejections > 0 ? IMAGE_STILL_TOO_LARGE_HINT : null,
  };
}

/** Each file is handed off on its own. One rejection does not skip the rest. */
export async function placeImageFiles(
  files: readonly File[],
  handleImageFile: (file: File, index: number) => Promise<void>,
): Promise<void> {
  await Promise.all(
    files.map(async (file, index) => {
      try {
        await handleImageFile(file, index);
      } catch (error) {
        console.error("[whiteboard] image file:", error);
      }
    }),
  );
}

export async function applyImageDropDecision(
  decision: ImageDropDecision,
  handleImageFile: (file: File, placement: { pageIndex: number; point: PagePoint }) => Promise<void>,
  notify: (message: string) => void,
): Promise<void> {
  if (decision.type === "ignore") return;
  if (decision.type === "hint") {
    notify(decision.message);
    return;
  }
  if (decision.hint) notify(decision.hint);
  const total = decision.files.length;
  await placeImageFiles(decision.files, (file, index) =>
    handleImageFile(file, {
      pageIndex: decision.pageIndex,
      point: calculateDroppedImagePosition(decision.origin, index, total),
    }),
  );
}

export async function applyPasteDecision(
  action: PasteAction,
  input: {
    notebookId: string | null | undefined;
    files: readonly File[];
    pageIndex: number;
    sizeRejected: boolean;
    pasteClipboard: () => void;
    handleImageFile: (file: File, placement: { pageIndex: number; staggerIndex: number }) => Promise<void>;
    notify: (message: string) => void;
  },
): Promise<void> {
  if (action === "ignore") {
    if (input.sizeRejected) input.notify(IMAGE_STILL_TOO_LARGE_HINT);
    return;
  }
  if (action === "internal") {
    if (input.sizeRejected) input.notify(IMAGE_STILL_TOO_LARGE_HINT);
    input.pasteClipboard();
    return;
  }
  if (!input.notebookId) {
    input.notify(NOTEBOOK_NOT_READY_HINT);
    return;
  }
  if (input.sizeRejected) input.notify(IMAGE_STILL_TOO_LARGE_HINT);
  await placeImageFiles(input.files, (file, index) =>
    input.handleImageFile(file, { pageIndex: input.pageIndex, staggerIndex: index }),
  );
}

/** True when a drag payload may contain files. During dragover the file list itself is often empty. */
export function dataTransferHasFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  try {
    const types = dt.types;
    if (!types || typeof types.length !== "number") return false;
    for (let i = 0; i < types.length; i += 1) {
      const type = types[i];
      if (type === "Files" || type === "application/x-moz-file") return true;
    }
    return false;
  } catch {
    return false;
  }
}
