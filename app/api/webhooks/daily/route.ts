import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import {
  isValidDailyRecordingId,
  lessonIdFromDailyRoomName,
  toDailyRecordingRef,
  verifyDailyWebhookSignature,
} from "../../../../lib/daily";

type DailyWebhookBody = {
  test?: string;
  version?: string;
  type?: string;
  id?: string;
  payload?: {
    recording_id?: string;
    id?: string;
    room_name?: string;
    download_url?: string;
    download_link?: string;
    status?: string;
    [key: string]: unknown;
  };
  event_ts?: number;
};

/**
 * Daily.co webhooks (recording lifecycle).
 * Configure in Daily dashboard: POST /api/webhooks/daily
 * Subscribe at least to: recording.ready-to-download
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const signature = request.headers.get("X-Webhook-Signature");
  const timestamp = request.headers.get("X-Webhook-Timestamp");
  const secret = process.env.DAILY_WEBHOOK_SECRET ?? "";

  // Skip signature check only for Daily's registration ping (`{ "test": "test" }`)
  // when no signature headers are present yet; still require HMAC for real events.
  let body: DailyWebhookBody;
  try {
    body = JSON.parse(rawBody) as DailyWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const isRegistrationPing = body.test === "test";

  if (!isRegistrationPing) {
    if (!verifyDailyWebhookSignature(rawBody, signature, timestamp, secret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (signature || timestamp) {
    // If Daily includes signature on the test ping, verify it too.
    if (!verifyDailyWebhookSignature(rawBody, signature, timestamp, secret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Daily sends `{ "test": "test" }` when registering the webhook — must return 200 quickly.
  if (isRegistrationPing) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const eventType = body.type ?? "unknown";
  const externalId =
    typeof body.id === "string" && body.id.length > 0
      ? body.id
      : `daily-${eventType}-${Date.now()}`;

  // Idempotency via WebhookEvent.externalId
  const existing = await prisma.webhookEvent.findUnique({
    where: { externalId },
  });
  if (existing?.processed) {
    return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
  }

  const eventRow =
    existing ??
    (await prisma.webhookEvent.create({
      data: {
        provider: "daily",
        eventType,
        externalId,
        payload: body as object,
        processed: false,
      },
    }));

  try {
    if (eventType === "recording.ready-to-download") {
      await handleRecordingReady(body);
    }

    await prisma.webhookEvent.update({
      where: { id: eventRow.id },
      data: { processed: true, processedAt: new Date(), error: null },
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Webhook handler failed";
    console.error("Daily webhook error:", error);

    await prisma.webhookEvent.update({
      where: { id: eventRow.id },
      data: { error: message },
    });

    // Return 200 for most failures so Daily does not circuit-break; log for ops.
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}

/** `payload.recording_id` per Daily docs; `payload.id` is accepted as a fallback. */
function extractRecordingId(body: DailyWebhookBody): string | null {
  const payload = body.payload ?? {};
  for (const candidate of [payload.recording_id, payload.id]) {
    if (typeof candidate === "string" && isValidDailyRecordingId(candidate.trim())) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Persists `daily-rec:<recording_id>` on the lesson. Any `download_link` in the
 * payload is ignored: it expires, and `/api/daily/signed-url` mints a fresh
 * one from the recording id on every view.
 */
async function handleRecordingReady(body: DailyWebhookBody) {
  const payload = body.payload ?? {};
  const roomName = typeof payload.room_name === "string" ? payload.room_name : null;

  if (!roomName) {
    throw new Error("recording.ready-to-download missing room_name");
  }

  const lessonId = lessonIdFromDailyRoomName(roomName);
  if (!lessonId) {
    throw new Error(`Cannot map Daily room_name to lesson: ${roomName}`);
  }

  const recordingId = extractRecordingId(body);
  if (!recordingId) {
    throw new Error("recording.ready-to-download missing a valid recording_id");
  }

  const lesson = await prisma.lesson.findUnique({ where: { id: lessonId } });
  if (!lesson) {
    throw new Error(`Lesson not found for room ${roomName} (id=${lessonId})`);
  }

  await prisma.lesson.update({
    where: { id: lessonId },
    data: { videoRecordingUrl: toDailyRecordingRef(recordingId) },
  });
}
