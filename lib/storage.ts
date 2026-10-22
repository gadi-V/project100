/**
 * File storage for lesson artifacts (board PDF and whiteboard images).
 * Primary provider: Supabase Storage via REST, private bucket `lesson-boards`.
 * No extra SDK. A configured project uploads the buffer directly and returns a
 * signed URL (default 60 minutes). Local disk is used only when the keys are
 * absent and the process is a non-serverless development runtime.
 * Network failures throw StorageUploadError. Callers catch it so the lesson
 * and the canvas stay up.
 */

export const LESSON_BOARDS_BUCKET = "lesson-boards";

/** Private-bucket signed links. Override with SUPABASE_SIGNED_URL_TTL (seconds). */
export const BOARD_SIGNED_URL_TTL_SECONDS = 60 * 60;

const STORAGE_PROBE_TIMEOUT_MS = 2_500;

type SupabaseStorageConfig = {
  url: string;
  serviceKey: string;
  bucket: string;
  publicBucket: boolean;
  signedUrlTtlSeconds: number;
};

function signedUrlTtlSeconds(): number {
  const raw = process.env.SUPABASE_SIGNED_URL_TTL?.trim();
  if (!raw) return BOARD_SIGNED_URL_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return BOARD_SIGNED_URL_TTL_SECONDS;
  return parsed;
}

function getSupabaseStorageConfig(): SupabaseStorageConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_KEY?.trim();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || LESSON_BOARDS_BUCKET;

  if (!url || !serviceKey) return null;

  return {
    url,
    serviceKey,
    bucket,
    // The lesson-boards bucket is private. Public URLs are opt-in only.
    publicBucket: (process.env.SUPABASE_STORAGE_PUBLIC ?? "false").trim().toLowerCase() === "true",
    signedUrlTtlSeconds: signedUrlTtlSeconds(),
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

export type StorageProbe = {
  status: "up" | "down";
  latencyMs: number | null;
};

/**
 * Short liveness check for `/api/health`: GET the lesson-boards bucket.
 * Missing keys, a missing bucket, or a network error are `down` — never a throw.
 */
export async function probeLessonBoardsStorage(): Promise<StorageProbe> {
  const cfg = getSupabaseStorageConfig();
  if (!cfg) return { status: "down", latencyMs: null };

  const started = Date.now();
  try {
    const response = await fetch(`${cfg.url}/storage/v1/bucket/${cfg.bucket}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.serviceKey}`,
        apikey: cfg.serviceKey,
      },
      signal: AbortSignal.timeout(STORAGE_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return {
      status: response.ok ? "up" : "down",
      latencyMs: Date.now() - started,
    };
  } catch {
    console.error("[health] storage probe failed");
    return { status: "down", latencyMs: Date.now() - started };
  }
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
        apikey: cfg.serviceKey,
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
        apikey: cfg.serviceKey,
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

/** Object key for a board image. GIF is stored with the existing jpg extension. */
export function boardImageObjectPath(imageId: string, contentType: string): string {
  const ext =
    contentType.includes("webp") ? "webp" : contentType.includes("png") ? "png" : "jpg";
  return `board-images/${imageId}.${ext}`;
}

/** Relative object key inside the lesson-boards bucket. Rejects traversal. */
export function isSafeBoardObjectPath(objectPath: string): boolean {
  if (!objectPath || objectPath.length > 512) return false;
  if (objectPath.startsWith("/") || objectPath.includes("\\") || objectPath.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(objectPath);
}

/**
 * Read a private board object for the same-origin image route.
 * Supabase is fetched with the service key. Local dev reads `public/uploads/board`.
 * Returns null when the object is missing.
 */
export async function readBoardObject(objectPath: string): Promise<Buffer | null> {
  if (!isSafeBoardObjectPath(objectPath)) {
    return null;
  }

  const cfg = getSupabaseStorageConfig();
  if (cfg) {
    try {
      const response = await fetch(`${cfg.url}/storage/v1/object/${cfg.bucket}/${objectPath}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cfg.serviceKey}`,
          apikey: cfg.serviceKey,
        },
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      logStorageFailure("read", {
        bucket: cfg.bucket,
        reason: error instanceof Error ? error.name : "network",
      });
    }
  }

  return readBoardObjectFromDisk(objectPath);
}

async function boardDiskPath(objectPath: string): Promise<string | null> {
  if (!isSafeBoardObjectPath(objectPath)) return null;
  const path = await import("path");
  const root = path.join(process.cwd(), "public", "uploads", "board");
  const full = path.resolve(root, objectPath);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function readBoardObjectFromDisk(objectPath: string): Promise<Buffer | null> {
  if (!canUseLocalDiskStorage()) return null;
  try {
    const { readFile } = await import("fs/promises");
    const path = await import("path");
    const full = await boardDiskPath(objectPath);
    if (full) {
      try {
        return await readFile(full);
      } catch {
        const filename = path.basename(objectPath);
        if (filename !== objectPath && /^[\w.-]+$/.test(filename)) {
          return await readFile(path.join(process.cwd(), "public", "uploads", "board", filename));
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Upload an immutable board object (snapshot gzip or image bytes).
 * Local disk is the development fallback when Supabase is not configured.
 */
export async function uploadBoardObject(
  objectPath: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  if (!isSafeBoardObjectPath(objectPath)) throw new StorageUploadError();
  const cfg = getSupabaseStorageConfig();
  if (!cfg) {
    if (!canUseLocalDiskStorage()) throw unconfiguredStorageError("image");
    await writeBoardObjectToDisk(objectPath, body);
    return;
  }
  try {
    await supabasePut(cfg, objectPath, body, contentType);
  } catch (error) {
    if (process.env.NODE_ENV === "development" && canUseLocalDiskStorage()) {
      console.warn("[storage] Supabase board upload failed, saving under public/uploads/board");
      await writeBoardObjectToDisk(objectPath, body);
      return;
    }
    throw error;
  }
}

/** Delete one object. A missing object is success. Failures are logged and swallowed. */
export async function deleteBoardObject(objectPath: string): Promise<void> {
  if (!isSafeBoardObjectPath(objectPath)) return;
  const cfg = getSupabaseStorageConfig();
  if (cfg) {
    try {
      const response = await fetch(`${cfg.url}/storage/v1/object/${cfg.bucket}/${objectPath}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${cfg.serviceKey}`,
          apikey: cfg.serviceKey,
        },
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!response.ok && response.status !== 404) {
        const detail = await response.text().catch(() => "");
        logStorageFailure("delete", {
          bucket: cfg.bucket,
          status: response.status,
          reason: redactStorageDetail(detail || response.statusText, cfg.serviceKey),
        });
      }
    } catch (error) {
      logStorageFailure("delete", {
        bucket: cfg.bucket,
        reason: error instanceof Error ? error.name : "network",
      });
    }
    return;
  }
  if (!canUseLocalDiskStorage()) return;
  try {
    const { unlink } = await import("fs/promises");
    const full = await boardDiskPath(objectPath);
    if (full) await unlink(full);
  } catch {
    // Already gone.
  }
}

async function writeBoardObjectToDisk(objectPath: string, body: Buffer): Promise<void> {
  try {
    const { mkdir, writeFile } = await import("fs/promises");
    const path = await import("path");
    const full = await boardDiskPath(objectPath);
    if (!full) throw new StorageUploadError();
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  } catch (error) {
    if (error instanceof StorageUploadError) throw error;
    logStorageFailure("local-disk", {
      reason: error instanceof Error ? error.name : "io",
    });
    throw new StorageUploadError();
  }
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
  const objectPath = boardImageObjectPath(imageId, contentType);
  const ext = objectPath.split(".").pop() ?? "jpg";
  const cfg = getSupabaseStorageConfig();

  if (!cfg) {
    if (!canUseLocalDiskStorage()) {
      throw unconfiguredStorageError("image");
    }
    return writeBoardImageToDisk(imageId, imageBuffer, ext);
  }

  try {
    await supabasePut(cfg, objectPath, imageBuffer, contentType);
  } catch (error) {
    if (process.env.NODE_ENV === "development" && canUseLocalDiskStorage()) {
      console.warn("[storage] Supabase board upload failed, saving under public/uploads/board");
      return writeBoardImageToDisk(imageId, imageBuffer, ext);
    }
    throw error;
  }

  return cfg.publicBucket
    ? publicObjectUrl(cfg, objectPath)
    : createSignedUrl(cfg, objectPath);
}

async function writeBoardImageToDisk(imageId: string, imageBuffer: Buffer, ext: string): Promise<string> {
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
