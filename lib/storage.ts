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
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Supabase sign URL failed (${response.status}): ${detail}`);
  }

  const body = (await response.json()) as { signedURL?: string; signedUrl?: string };
  const signed = body.signedURL ?? body.signedUrl;
  if (!signed) {
    throw new Error("Supabase sign URL response missing signedURL");
  }
  // Supabase returns a path beginning with /storage/v1/... relative to the project URL.
  return signed.startsWith("http") ? signed : `${cfg.url}${signed}`;
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
    console.log("================== MOCK STORAGE (PDF upload) ==================");
    console.log(`Object: ${objectPath} (${pdfBuffer.length} bytes)`);
    console.log("Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to enable real uploads.");
    console.log("==============================================================");
    return null;
  }

  const uploadResponse = await fetch(
    `${cfg.url}/storage/v1/object/${cfg.bucket}/${objectPath}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.serviceKey}`,
        "Content-Type": "application/pdf",
        "x-upsert": "true",
        "cache-control": "3600",
      },
      body: new Uint8Array(pdfBuffer),
    }
  );

  if (!uploadResponse.ok) {
    const detail = await uploadResponse.text().catch(() => uploadResponse.statusText);
    throw new Error(
      `Supabase PDF upload failed (${uploadResponse.status}): ${detail}`
    );
  }

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
      throw new Error(
        "Board image storage is not configured: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (local disk writes are disabled on serverless/production)"
      );
    }
    const { mkdir, writeFile } = await import("fs/promises");
    const path = await import("path");
    const dir = path.join(process.cwd(), "public", "uploads", "board");
    await mkdir(dir, { recursive: true });
    const filename = `${imageId}.${ext}`;
    await writeFile(path.join(dir, filename), imageBuffer);
    console.log(`[storage] mock board image saved: /uploads/board/${filename}`);
    return `/uploads/board/${filename}`;
  }

  const uploadResponse = await fetch(
    `${cfg.url}/storage/v1/object/${cfg.bucket}/${objectPath}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.serviceKey}`,
        "Content-Type": contentType,
        "x-upsert": "true",
        "cache-control": "3600",
      },
      body: new Uint8Array(imageBuffer),
    },
  );

  if (!uploadResponse.ok) {
    const detail = await uploadResponse.text().catch(() => uploadResponse.statusText);
    throw new Error(`Supabase image upload failed (${uploadResponse.status}): ${detail}`);
  }

  return cfg.publicBucket
    ? publicObjectUrl(cfg, objectPath)
    : createSignedUrl(cfg, objectPath);
}
