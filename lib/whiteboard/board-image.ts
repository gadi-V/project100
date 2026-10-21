export const BOARD_IMAGE_ADD_MAX_BYTES = 1400;

export type BoardImageCrop = {
  sx: number;
  sy: number;
  sWidth: number;
  sHeight: number;
};

export type BoardImageEl = {
  kind: "image";
  id: string;
  imageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  crop: BoardImageCrop | null;
  pageIndex: number;
};

export type BoardImageSync = {
  kind: "image";
  id: string;
  imageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  crop: BoardImageCrop | null;
  pageIndex: number;
};

type Bitmap = {
  complete?: boolean;
  naturalWidth?: number;
};

export function boardImageSrc(imageId: string): string {
  return `/api/board-images/${encodeURIComponent(imageId)}`;
}

export function imageAddEvent(el: BoardImageEl): { type: "board_sync"; v: 6; add: BoardImageSync } {
  return {
    type: "board_sync",
    v: 6,
    add: {
      kind: "image",
      id: el.id,
      imageId: el.imageId,
      x: el.x,
      y: el.y,
      w: el.w,
      h: el.h,
      rotation: el.rotation,
      crop: el.crop,
      pageIndex: el.pageIndex,
    },
  };
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readCrop(value: unknown): BoardImageCrop | null {
  if (!value || typeof value !== "object") return null;
  const crop = value as Record<string, unknown>;
  if (
    typeof crop.sx !== "number" ||
    typeof crop.sy !== "number" ||
    typeof crop.sWidth !== "number" ||
    typeof crop.sHeight !== "number"
  ) {
    return null;
  }
  return { sx: crop.sx, sy: crop.sy, sWidth: crop.sWidth, sHeight: crop.sHeight };
}

/** Incoming events may still carry a legacy `url`. It is returned for one load and never copied onto the element. */
export function applySyncedImage(raw: unknown): { element: BoardImageEl; legacyUrl: string | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.kind !== "image" || typeof value.id !== "string" || value.id.length === 0) return null;
  const imageId = typeof value.imageId === "string" && value.imageId.length > 0 ? value.imageId : value.id;
  const legacyUrl = typeof value.url === "string" && value.url.length > 0 ? value.url : null;
  return {
    legacyUrl,
    element: {
      kind: "image",
      id: value.id,
      imageId,
      x: finite(value.x),
      y: finite(value.y),
      w: finite(value.w),
      h: finite(value.h),
      rotation: finite(value.rotation),
      crop: readCrop(value.crop),
      pageIndex: finite(value.pageIndex),
    },
  };
}

function bitmapReady(bitmap: Bitmap | undefined): boolean {
  return Boolean(bitmap?.complete && (bitmap.naturalWidth ?? 0) > 0);
}

/**
 * Load `/api/board-images/{id}` into the cache. A legacy url, when present, is tried first
 * and never stored. The load retries once, then gives up. `onLoad` runs after a successful decode
 * so the board can repaint.
 */
const inflightImages = new Map<string, Promise<HTMLImageElement | null>>();

export function loadBoardImage(
  el: BoardImageEl,
  cache: Map<string, HTMLImageElement>,
  onLoad?: () => void,
  legacyUrl?: string | null,
): Promise<HTMLImageElement | null> {
  const cached = cache.get(el.id);
  if (bitmapReady(cached)) return Promise.resolve(cached ?? null);
  const pending = inflightImages.get(el.id);
  if (pending) return pending;

  const primary = legacyUrl || boardImageSrc(el.imageId);
  const fallback = boardImageSrc(el.imageId);

  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    let retried = false;
    img.onload = () => {
      cache.set(el.id, img);
      onLoad?.();
      resolve(img);
    };
    img.onerror = () => {
      if (!retried) {
        retried = true;
        const current = img.src;
        const same =
          typeof current === "string" && (current === fallback || current.endsWith(fallback));
        img.src = same ? `${fallback}${fallback.includes("?") ? "&" : "?"}retry=1` : fallback;
        return;
      }
      resolve(null);
    };
    img.src = primary;
  });
  inflightImages.set(el.id, promise);
  void promise.finally(() => {
    if (inflightImages.get(el.id) === promise) inflightImages.delete(el.id);
  });
  return promise;
}

export function ensureImageInCache(
  el: BoardImageEl,
  cache: Map<string, HTMLImageElement>,
  onLoad?: () => void,
  legacyUrl?: string | null,
): void {
  void loadBoardImage(el, cache, onLoad, legacyUrl);
}

type CanvasLike = {
  width: number;
  height: number;
  getContext: (kind: "2d") => object | null;
  toDataURL: (type?: string) => string;
};

export async function renderBoardPageDataUrl<T extends Bitmap>(options: {
  pageIndex: number;
  elements: readonly { kind: string; id: string; imageId?: string; pageIndex: number }[];
  images: Map<string, T>;
  createCanvas: () => CanvasLike;
  drawBase: (ctx: CanvasRenderingContext2D) => void;
  drawImage: (ctx: CanvasRenderingContext2D, el: BoardImageEl, bitmap: T) => void;
  load?: (el: BoardImageEl) => Promise<T | null>;
}): Promise<{ dataUrl: string; included: string[]; skipped: string[] }> {
  const pageImages = options.elements.filter(
    (el): el is BoardImageEl => el.kind === "image" && el.pageIndex === options.pageIndex && typeof el.imageId === "string",
  );
  const included: string[] = [];
  const skipped: string[] = [];

  for (const el of pageImages) {
    const current = options.images.get(el.id);
    if (bitmapReady(current) || !options.load) continue;
    const loaded = await options.load(el);
    if (loaded) options.images.set(el.id, loaded);
  }

  const canvas = options.createCanvas();
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) return { dataUrl: "", included, skipped };
  options.drawBase(ctx);
  for (const el of pageImages) {
    const bitmap = options.images.get(el.id);
    if (!bitmapReady(bitmap) || !bitmap) {
      skipped.push(el.imageId);
      console.warn("[whiteboard] export skipped image", el.imageId);
      continue;
    }
    options.drawImage(ctx, el, bitmap);
    included.push(el.id);
  }

  try {
    return { dataUrl: canvas.toDataURL("image/png"), included, skipped };
  } catch (error) {
    console.warn("[whiteboard] export toDataURL failed", error);
    return { dataUrl: "", included, skipped };
  }
}
