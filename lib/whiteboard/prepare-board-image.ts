export const BOARD_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const BOARD_DOWNSCALE_OVER_BYTES = 1.5 * 1024 * 1024;
export const BOARD_IMAGE_MAX_SIDE = 2000;

const DOWNSCALE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function fittedLongestSide(
  width: number,
  height: number,
  maxSide = BOARD_IMAGE_MAX_SIDE,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  const longest = Math.max(width, height);
  if (longest <= maxSide) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = maxSide / longest;
  let nextWidth = Math.max(1, Math.round(width * scale));
  let nextHeight = Math.max(1, Math.round(height * scale));
  const fittedLongest = Math.max(nextWidth, nextHeight);
  if (fittedLongest > maxSide) {
    const clamp = maxSide / fittedLongest;
    nextWidth = Math.max(1, Math.floor(nextWidth * clamp));
    nextHeight = Math.max(1, Math.floor(nextHeight * clamp));
  }
  return { width: nextWidth, height: nextHeight };
}

/** GIFs stay as uploaded. Only a jpeg, png, or webp over 1.5MB is resized. */
export function imagePreparePlan(file: { type: string; size: number }): "passthrough" | "downscale" {
  if (file.type === "image/gif") return "passthrough";
  if (DOWNSCALE_TYPES.has(file.type) && file.size > BOARD_DOWNSCALE_OVER_BYTES) return "downscale";
  return "passthrough";
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
}

/**
 * Shrink a large photo before upload. GIFs and files at or under 1.5MB are returned unchanged.
 * WebP at quality 0.82, or JPEG when the browser cannot encode WebP.
 */
export async function prepareBoardImageFile(file: File): Promise<{ file: File } | { error: "still-too-large" }> {
  if (imagePreparePlan(file) === "passthrough") return { file };

  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const size = fittedLongestSide(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { error: "still-too-large" };
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const webp = await canvasBlob(canvas, "image/webp", 0.82);
    const encoded = webp && (webp.type === "image/webp" || webp.type === "") ? webp : await canvasBlob(canvas, "image/jpeg", 0.82);
    if (!encoded || encoded.size > BOARD_UPLOAD_MAX_BYTES) return { error: "still-too-large" };
    const type = encoded.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    const name = type === "image/jpeg" ? "board.jpg" : "board.webp";
    return { file: new File([encoded], name, { type }) };
  } finally {
    bitmap.close();
  }
}
