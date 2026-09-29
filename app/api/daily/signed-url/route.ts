import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/session";
import { prisma } from "../../../../lib/prisma";
import {
  DAILY_RECORDING_LINK_TTL_SECONDS,
  getRecordingAccessLink,
  parseDailyRecordingRef,
} from "../../../../lib/daily";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Mint a fresh, short-lived signed URL for a lesson's Daily.co recording.
 * The user must be the teacher, student, or a manager of the lesson.
 *
 * The lesson stores only the recording id (`daily-rec:<id>`); every request
 * calls Daily's `GET /recordings/:id/access-link` for a new link, so the
 * stored value never goes stale and no raw link is ever persisted or reused.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const lessonId = searchParams.get("lessonId");

  if (!lessonId) {
    return NextResponse.json(
      { error: "lessonId is required" },
      { status: 400 }
    );
  }

  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      teacherId: true,
      studentId: true,
      videoRecordingUrl: true,
    },
  });

  if (!lesson) {
    return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
  }

  const isPrivileged =
    user.role === "MANAGER" || user.role === "ADMIN";
  const isParticipant =
    lesson.teacherId === user.id || lesson.studentId === user.id;

  if (!isPrivileged && !isParticipant) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!lesson.videoRecordingUrl) {
    return NextResponse.json(
      { error: "Recording not yet available" },
      { status: 404 }
    );
  }

  const recordingId = parseDailyRecordingRef(lesson.videoRecordingUrl);
  if (!recordingId) {
    // Pre-Sprint-5 rows hold an already-expired download link with no id.
    return NextResponse.json(
      { error: "Recording link can no longer be refreshed" },
      { status: 410 }
    );
  }

  try {
    const link = await getRecordingAccessLink(recordingId);
    const expiresAtMs = Number.isFinite(link.expires)
      ? link.expires * 1000
      : Date.now() + DAILY_RECORDING_LINK_TTL_SECONDS * 1000;
    return NextResponse.json(
      {
        url: link.download_link,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error(
      `Signed URL generation failed for recording ${recordingId}:`,
      error
    );
    return NextResponse.json(
      { error: "Failed to generate signed URL" },
      { status: 502 }
    );
  }
}
