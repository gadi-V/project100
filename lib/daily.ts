/**
 * Daily.co REST helpers — room provisioning + meeting tokens.
 * Recording is server-driven (cloud); clients must never expose record controls.
 */

import crypto from "crypto";

const DAILY_API_BASE = "https://api.daily.co/v1";

export type DailyRoom = {
  id: string;
  name: string;
  url: string;
  privacy: string;
};

export type DailyAccessLink = {
  download_link: string;
  expires: number;
};

function getDailyApiKey(): string | null {
  const key = process.env.DAILY_API_KEY?.trim();
  return key || null;
}

/** Dev/build fallback when DAILY_API_KEY is unset — booking continues with a mock room. */
function mockDailyRoom(lessonId: string): DailyRoom {
  const name = dailyRoomNameForLesson(lessonId);
  return {
    id: `mock-${name}`,
    name,
    url: `https://mock.daily.co/${name}`,
    privacy: "private",
  };
}

/** Stable Daily room name derived from our Lesson id (used by webhooks). */
export function dailyRoomNameForLesson(lessonId: string): string {
  return `lesson-${lessonId}`;
}

/** Extract lesson UUID from a Daily room name like `lesson-<uuid>`. */
export function lessonIdFromDailyRoomName(roomName: string): string | null {
  const prefix = "lesson-";
  if (!roomName.startsWith(prefix)) return null;
  const id = roomName.slice(prefix.length).trim();
  return id.length > 0 ? id : null;
}

export function roomNameFromDailyUrl(roomUrl: string): string | null {
  try {
    const pathname = new URL(roomUrl).pathname;
    const name = pathname.replace(/^\//, "").split("/")[0];
    return name || null;
  } catch {
    return null;
  }
}

async function dailyFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const apiKey = getDailyApiKey();
  if (!apiKey) {
    throw new Error("DAILY_API_KEY environment variable is not set");
  }
  const response = await fetch(`${DAILY_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail =
      typeof body === "object" && body && "error" in body
        ? JSON.stringify(body)
        : response.statusText;
    throw new Error(`Daily API ${path} failed (${response.status}): ${detail}`);
  }

  return body as T;
}

/**
 * Create a private Daily room for a lesson.
 *
 * Room properties are kept to the intersection supported on all Daily plans
 * (including Free): `exp`, `eject_at_room_exp`, `enable_chat` (in-app chat is
 * handled by Stream), and `enable_screenshare`.
 *
 * `exp` is computed as `scheduledAt + durationMinutes + 10%` by default:
 * e.g. a 60-minute lesson gets 60 + 6 minutes = 66 total minutes of room
 * availability from the scheduled start. `eject_at_room_exp: true` makes Daily
 * kick everyone out and close the room automatically when `exp` passes.
 *
 * Cloud recording is a paid feature — it is only sent when the plan/organization
 * opts in via `DAILY_ENABLE_CLOUD_RECORDING=true`. Otherwise the property is
 * omitted entirely so Free accounts are not blocked from creating rooms.
 */
export async function createDailyRoom(
  lessonId: string,
  options: {
    /** Lesson scheduled start. When absent, falls back to Date.now(). */
    scheduledAt?: Date;
    /** Planned lesson duration in minutes. Defaults to 60. */
    durationMinutes?: number;
    /** Explicit expiry override — takes precedence over duration-based calc. */
    expiresAt?: Date;
  } = {}
): Promise<DailyRoom> {
  if (!getDailyApiKey()) {
    console.warn(
      `[daily] DAILY_API_KEY unset — returning mock room for lesson ${lessonId}`
    );
    return mockDailyRoom(lessonId);
  }

  const name = dailyRoomNameForLesson(lessonId);

  const scheduledAt = options.scheduledAt ?? new Date();

  // The room `exp` (Unix seconds) must ALWAYS be in the future — at least 4
  // hours out — so joining (or re-provisioning) an old test lesson never throws
  // a Daily 400. `exp = max(now + 4h, scheduledAt + 4h)`.
  const MIN_EXP_SECONDS = 4 * 60 * 60; // 4 hours
  const minExp = Math.floor(Date.now() / 1000) + MIN_EXP_SECONDS;
  const lessonExp = Math.floor(scheduledAt.getTime() / 1000) + MIN_EXP_SECONDS;
  const exp = Math.max(minExp, lessonExp);

  const properties: Record<string, unknown> = {
    exp,
    eject_at_room_exp: true,
    enable_chat: false,
    enable_screenshare: true,
  };

  if (process.env.DAILY_ENABLE_CLOUD_RECORDING === "true") {
    properties.enable_recording = "cloud";
  }

  const room = await dailyFetch<DailyRoom>("/rooms", {
    method: "POST",
    body: JSON.stringify({
      name,
      privacy: "private",
      properties,
    }),
  });

  return {
    id: room.id,
    name: room.name,
    url: room.url,
    privacy: room.privacy,
  };
}

export const DAILY_TOKEN_EARLY_JOIN_MINUTES = 15;
export const DAILY_TOKEN_MAX_EXTENSION_MINUTES = 30;
const DEFAULT_LESSON_DURATION_MINUTES = 60;

/**
 * Hard join window for a lesson meeting token (Unix seconds):
 * - `nbf`: scheduledAt − 15 minutes.
 * - `exp`: scheduledAt + durationMinutes + 30-minute max extension.
 */
export function computeDailyTokenWindow(
  scheduledAt: Date,
  durationMinutes: number = DEFAULT_LESSON_DURATION_MINUTES
): { nbf: number; exp: number } {
  const start = scheduledAt.getTime();
  if (!Number.isFinite(start)) {
    throw new Error("computeDailyTokenWindow: scheduledAt is not a valid date");
  }
  const duration =
    Number.isFinite(durationMinutes) && durationMinutes > 0
      ? durationMinutes
      : DEFAULT_LESSON_DURATION_MINUTES;

  const nbfMs = start - DAILY_TOKEN_EARLY_JOIN_MINUTES * 60 * 1000;
  const expMs = start + (duration + DAILY_TOKEN_MAX_EXTENSION_MINUTES) * 60 * 1000;

  return {
    nbf: Math.floor(nbfMs / 1000),
    exp: Math.floor(expMs / 1000),
  };
}

/**
 * Meeting token for a participant, always time-boxed to the lesson window
 * (see `computeDailyTokenWindow`).
 * - Teacher / owner: is_owner + start_cloud_recording (background auto-record)
 * - Student: join-only token (no recording permissions / UI)
 */
export async function generateDailyToken(
  roomName: string,
  isOwner: boolean,
  userId: string,
  options: {
    /** Lesson scheduled start. */
    scheduledAt: Date;
    /** Planned lesson duration in minutes. Defaults to 60. */
    durationMinutes?: number;
  }
): Promise<string> {
  if (!getDailyApiKey()) {
    return `mock-daily-token-${roomName}-${userId}-${isOwner ? "owner" : "guest"}`;
  }

  const { nbf, exp } = computeDailyTokenWindow(
    options.scheduledAt,
    options.durationMinutes ?? DEFAULT_LESSON_DURATION_MINUTES
  );

  const properties: Record<string, unknown> = {
    room_name: roomName,
    user_id: userId,
    is_owner: isOwner,
    nbf,
    exp,
    // Auto cloud recording starts when the owner (teacher) joins — no client record button.
    ...(isOwner ? { start_cloud_recording: true, enable_recording: "cloud" } : {}),
  };

  const result = await dailyFetch<{ token: string }>("/meeting-tokens", {
    method: "POST",
    body: JSON.stringify({
      properties,
    }),
  });

  return result.token;
}

/** Temporary signed download URL for a finished cloud recording. */
export async function getRecordingDownloadUrl(
  recordingId: string
): Promise<string> {
  const result = await dailyFetch<DailyAccessLink>(
    `/recordings/${encodeURIComponent(recordingId)}/access-link`
  );
  return result.download_link;
}

/**
 * Verify Daily.co webhook HMAC signature.
 * Daily signs: `${X-Webhook-Timestamp}.${rawBody}` with HMAC-SHA256
 * using a base64-decoded secret (`DAILY_WEBHOOK_SECRET`), digest base64.
 * @see https://docs.daily.co/reference/rest-api/webhooks
 */
export function verifyDailyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  secret: string = process.env.DAILY_WEBHOOK_SECRET ?? ""
): boolean {
  if (!secret || !signatureHeader || !timestampHeader) {
    return false;
  }

  try {
    const base64DecodedSecret = Buffer.from(secret, "base64");
    const signedPayload = `${timestampHeader}.${rawBody}`;
    const computed = crypto
      .createHmac("sha256", base64DecodedSecret)
      .update(signedPayload)
      .digest("base64");

    const expected = Buffer.from(computed);
    const received = Buffer.from(signatureHeader);

    if (expected.length !== received.length) {
      return false;
    }

    return crypto.timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

/** Delete a Daily room (compensation when booking fails after room create). */
export async function deleteDailyRoom(roomName: string): Promise<void> {
  if (!getDailyApiKey()) {
    console.warn(`[daily] DAILY_API_KEY unset — skip delete for ${roomName}`);
    return;
  }
  await dailyFetch(`/rooms/${encodeURIComponent(roomName)}`, {
    method: "DELETE",
  });
}

/**
 * Ensure an active Daily room exists before the lesson page returns its URL.
 *
 * If the lesson has no room yet — or its stored room no longer exists on Daily
 * (e.g. it expired during a retry / dev restart) — this re-provisions one via
 * the REST API and persists it. On any failure (missing key, network, API error)
 * it returns `null` so the client renders a clean "test environment" placeholder
 * instead of a red screen.
 */
export async function ensureDailyRoom(
  lessonId: string,
  options: {
    scheduledAt?: Date;
    durationMinutes?: number;
    existingRoomUrl?: string | null;
  } = {}
): Promise<string | null> {
  // Nothing saved yet — create a fresh room (real or mock when key unset).
  if (!options.existingRoomUrl) {
    try {
      const room = await createDailyRoom(lessonId, {
        scheduledAt: options.scheduledAt,
        durationMinutes: options.durationMinutes,
      });
      return room.url;
    } catch (error) {
      console.error(`Failed to create Daily room for lesson ${lessonId}:`, error);
      return null;
    }
  }

  if (!hasDailyApiKey()) {
    // Keep the stored URL (may itself be a mock from a prior booking).
    return options.existingRoomUrl;
  }

  const roomName = roomNameFromDailyUrl(options.existingRoomUrl);
  if (!roomName) return null;

  try {
    // Validate that the stored room still resolves on the API.
    const existing = await dailyFetch<DailyRoom>(
      `/rooms/${encodeURIComponent(roomName)}`
    );
    return existing.url ?? options.existingRoomUrl;
  } catch {
    // Room is gone (expired/deleted) — re-provision it under the same name.
    try {
      const room = await createDailyRoom(lessonId, {
        scheduledAt: options.scheduledAt,
        durationMinutes: options.durationMinutes,
      });
      return room.url;
    } catch (error) {
      console.error(
        `Failed to re-provision Daily room for lesson ${lessonId}:`,
        error
      );
      return null;
    }
  }
}

/**
 * Whether a Daily room video client can be mounted. When the API key is missing
 * in development, the caller renders a clean "test environment" placeholder
 * instead of a broken red error surface.
 */
export function hasDailyApiKey(): boolean {
  return Boolean(process.env.DAILY_API_KEY);
}
