/**
 * File storage for lesson artifacts (board PDF).
 * Primary provider: Supabase Storage via REST (no extra dependency).
 * Falls back to a local mock (logs only) when storage env is not configured,
 * so local dev keeps working without secrets.
 *
 * Swap-in alternatives (Vercel Blob / S3) can implement the same
 * `uploadLessonPdf` contract without touching callers.
 */

type SupabaseStorageConfig = {
  url: string;
  serviceKey: string;
  bucket: string;
  publicBucket: boolean;
  signedUrlTtlSeconds: number;
};

function getSupabaseStorageConfig(): SupabaseStorageConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_KEY?.trim();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "lesson-boards";

  if (!url || !serviceKey) return null;

  return {
    url,
    serviceKey,
    bucket,
    publicBucket: (process.env.SUPABASE_STORAGE_PUBLIC ?? "true").toLowerCase() !== "false",
    signedUrlTtlSeconds: Number(process.env.SUPABASE_SIGNED_URL_TTL ?? 60 * 60 * 24 * 7),
  };
}

/**
 * Local `public/uploads` fallback is dev-only: serverless filesystems are
 * read-only, and files written at runtime are never served in production.
 */
export function canUseLocalDiskStorage(): boolean {
  const isServerless = Boolean(
    process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY
  );
  return !isServerless && process.env.NODE_ENV !== "production";
}

/** Client-facing message. Never includes bucket names, keys, or upstream bodies. */
export const STORAGE_UPLOAD_CLIENT_ERROR = "Upload failed, please try again";

export class StorageUploadError extends Error {
  constructor() {
    super(STORAGE_UPLOAD_CLIENT_ERROR);
    this.name = "StorageUploadError";
  }
}

const UPLOAD_TIMEOUT_MS = 20_000;

function redactStorageDetail(detail: string, secret: string): string {
  return detail
    .split(secret)
    .join("[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 180);
}

function logStorageFailure(
  operation: string,
  detail: { bucket?: string; status?: number; reason?: string }
): void {
  console.error(`[storage] ${operation} failed`, detail);
}

function unconfiguredStorageError(kind: "pdf" | "image"): Error {
  const label = kind === "pdf" ? "Lesson PDF" : "Board image";
  return new Error(
    `${label} storage is not configured: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (local disk writes are disabled on serverless/production)`
  );
}

function publicObjectUrl(cfg: SupabaseStorageConfig, objectPath: string): string {
  return `${cfg.url}/storage/v1/object/public/${cfg.bucket}/${objectPath}`;
}

async function createSignedUrl(
  cfg: SupabaseStorageConfig,
  objectPath: string
): Promise<string> {
  const response = await fetch(
    `${cfg.url}/storage/v1/object/sign/${cfg.bucket}/${objectPath}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: cfg.signedUrlTtlSeconds }),
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    logStorageFailure("sign-url", {
      bucket: cfg.bucket,
      status: response.status,
      reason: redactStorageDetail(detail || response.statusText, cfg.serviceKey),
    });
    throw new StorageUploadError();
  }

  const body = (await response.json()) as { signedURL?: string; signedUrl?: string };
  const signed = body.signedURL ?? body.signedUrl;
  if (!signed) {
    logStorageFailure("sign-url", { bucket: cfg.bucket, reason: "missing signedURL" });
    throw new StorageUploadError();
  }
  // Supabase returns a path beginning with /storage/v1/... relative to the project URL.
  return signed.startsWith("http") ? signed : `${cfg.url}${signed}`;
}

async function supabasePut(
  cfg: SupabaseStorageConfig,
  objectPath: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const bytes = new Uint8Array(body.byteLength);
  bytes.set(body);

  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(`${cfg.url}/storage/v1/object/${cfg.bucket}/${objectPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.serviceKey}`,
        "Content-Type": contentType,
        "x-upsert": "true",
        "cache-control": "3600",
      },
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    logStorageFailure("upload", {
      bucket: cfg.bucket,
      reason: error instanceof Error ? error.name : "network",
    });
    throw new StorageUploadError();
  }

  if (!uploadResponse.ok) {
    const detail = await uploadResponse.text().catch(() => "");
    logStorageFailure("upload", {
      bucket: cfg.bucket,
      status: uploadResponse.status,
      reason: redactStorageDetail(detail || uploadResponse.statusText, cfg.serviceKey),
    });
    throw new StorageUploadError();
  }
}

/**
 * Upload the lesson board PDF and return a resolvable URL (public or signed).
 * Returns null when storage is not configured (mock mode).
 */
export async function uploadLessonPdf(
  lessonId: string,
  pdfBuffer: Buffer,
  fileName = "board-summary.pdf"
): Promise<string | null> {
  const objectPath = `lessons/${lessonId}/${fileName}`;
  const cfg = getSupabaseStorageConfig();

  if (!cfg) {
    if (!canUseLocalDiskStorage()) {
      throw unconfiguredStorageError("pdf");
    }
    console.log("================== MOCK STORAGE (PDF upload) ==================");
    console.log(`Object: ${objectPath} (${pdfBuffer.length} bytes)`);
    console.log("Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to enable real uploads.");
    console.log("==============================================================");
    return null;
  }

  await supabasePut(cfg, objectPath, pdfBuffer, "application/pdf");

  return cfg.publicBucket
    ? publicObjectUrl(cfg, objectPath)
    : createSignedUrl(cfg, objectPath);
}

/**
 * Upload a whiteboard image (webp/jpeg/png) and return a resolvable URL.
 * Without Supabase: local `/uploads/board/…` in development only; throws on
 * serverless / production instead of writing to disk.
 */
export async function uploadBoardImage(
  imageId: string,
  imageBuffer: Buffer,
  contentType: string,
): Promise<string> {
  const ext =
    contentType.includes("webp") ? "webp" : contentType.includes("png") ? "png" : "jpg";
  const objectPath = `board-images/${imageId}.${ext}`;
  const cfg = getSupabaseStorageConfig();

  if (!cfg) {
    if (!canUseLocalDiskStorage()) {
      throw unconfiguredStorageError("image");
    }
    try {
      const { mkdir, writeFile } = await import("fs/promises");
      const path = await import("path");
      const dir = path.join(process.cwd(), "public", "uploads", "board");
      await mkdir(dir, { recursive: true });
      const filename = `${imageId}.${ext}`;
      await writeFile(path.join(dir, filename), imageBuffer);
      console.log(`[storage] mock board image saved: /uploads/board/${filename}`);
      return `/uploads/board/${filename}`;
    } catch (error) {
      logStorageFailure("local-disk", {
        reason: error instanceof Error ? error.name : "io",
      });
      throw new StorageUploadError();
    }
  }

  await supabasePut(cfg, objectPath, imageBuffer, contentType);

  return cfg.publicBucket
    ? publicObjectUrl(cfg, objectPath)
    : createSignedUrl(cfg, objectPath);
}
