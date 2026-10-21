import { redirect } from "next/navigation";
import { getCurrentUser } from "../../../lib/session";
import { getAuthorizedLessonById } from "../../../lib/lessons";
import { prisma } from "../../../lib/prisma";
import {
  dailyRoomNameForLesson,
  ensureDailyRoom,
  generateDailyToken,
  roomNameFromDailyUrl,
} from "../../../lib/daily";
import { generateStreamToken } from "../../../lib/stream";
import { resolveLessonStreamChannelId } from "../../../lib/package-chat";
import { ensureLiveStreamChannel } from "../../../lib/services/chat-healing.service";
import LessonRoomUI from "./LessonRoomUI";

export default async function LessonPage(props: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const params = await props.params;
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login?from=/lessons/" + params.id);
  }

  // Intake representatives are never lesson participants.
  if (user.role === "REPRESENTATIVE") {
    redirect("/dashboard");
  }

  const lesson = await getAuthorizedLessonById(params.id, user.id, user.role);

  // Strict RBAC: only the lesson's teacher, student, MANAGER, or ADMIN may enter.
  if (!lesson) {
    redirect("/dashboard");
  }

  const isOwner =
    user.role === "TEACHER" ||
    user.role === "MANAGER" ||
    user.role === "ADMIN";

  // Reconcile Stream membership before the browser receives a token.
  // A Stream failure must not block the room.
  let streamChannelId: string | null = lesson.chatChannel?.streamChannelId ?? null;
  try {
    streamChannelId = (await resolveLessonStreamChannelId(lesson)) ?? streamChannelId;
  } catch (error) {
    console.error("Failed to resolve lesson Stream channel:", error);
  }
  if (streamChannelId) {
    try {
      streamChannelId = await ensureLiveStreamChannel(lesson.id, streamChannelId);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code: unknown }).code
          : null;
      console.error("[lesson-room] Stream membership reconciliation failed", {
        lessonId: lesson.id,
        teacherId: lesson.teacherId,
        studentId: lesson.studentId,
        userId: user.id,
        code,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const streamTokenPromise: Promise<string | null> = Promise.resolve().then(() => {
    try {
      return generateStreamToken(user.id);
    } catch (error) {
      console.error("Failed to generate Stream Chat token:", error);
      return null;
    }
  });

  const diagnosticPromise = isOwner
    ? prisma.diagnosticQuiz.findFirst({
        where: { studentId: lesson.studentId },
        include: { topics: true },
        orderBy: { createdAt: "desc" },
      })
    : Promise.resolve(null);

  // Ensure an active Daily room exists (provisioning / re-provisioning via the
  // REST API if it is missing or expired). Returns null when the key is unset in
  // dev so the client shows a clean placeholder instead of a red error screen.
  // Daily meeting tokens depend on this URL, so they stay sequential.
  const roomUrl = await ensureDailyRoom(lesson.id, {
    scheduledAt: lesson.scheduledAt,
    durationMinutes: lesson.durationMinutes ?? 60,
    existingRoomUrl: lesson.dailyRoomUrl,
  });

  const persistRoomPromise =
    roomUrl !== lesson.dailyRoomUrl
      ? prisma.lesson
          .update({
            where: { id: lesson.id },
            data: { dailyRoomUrl: roomUrl },
          })
          .catch((error: unknown) => {
            console.error("Failed to persist Daily room URL for lesson:", error);
          })
      : Promise.resolve(null);

  const dailyTokenPromise: Promise<string | null> = (async () => {
    if (!roomUrl) return null;
    const roomName =
      roomNameFromDailyUrl(roomUrl) ?? dailyRoomNameForLesson(lesson.id);
    try {
      return await generateDailyToken(roomName, isOwner, user.id, {
        scheduledAt: lesson.scheduledAt,
        durationMinutes: lesson.durationMinutes ?? 60,
      });
    } catch (error) {
      console.error("Failed to generate Daily meeting token:", error);
      return null;
    }
  })();

  const [, dailyToken, streamToken, studentDiagnostic] = await Promise.all([
    persistRoomPromise,
    dailyTokenPromise,
    streamTokenPromise,
    diagnosticPromise,
  ]);

  const streamApiKey =
    process.env.NEXT_PUBLIC_STREAM_API_KEY || process.env.STREAM_API_KEY || null;

  // Pedagogical Brief for Teacher / Manager / Admin
  let studentPedagogicalBrief: {
    studentName: string;
    subject: string;
    challenge: string;
    topics: Array<{
      topicName: string;
      subTopics: string[];
      weightInExam: number;
    }>;
  } | null = null;

  if (studentDiagnostic) {
    studentPedagogicalBrief = {
      studentName: lesson.student.name,
      subject: studentDiagnostic.subject,
      challenge: studentDiagnostic.challenge,
      topics: studentDiagnostic.topics.map((t) => ({
        topicName: t.topicName,
        subTopics: Array.isArray(t.subTopics) ? (t.subTopics as string[]) : [],
        weightInExam: t.weightInExam,
      })),
    };
  }

  return (
    <LessonRoomUI
      lesson={{
        id: lesson.id,
        title: lesson.title,
        status: lesson.status,
        studentId: lesson.studentId,
        teacherId: lesson.teacherId,
        roomUrl,
        dailyToken,
        streamToken,
        streamApiKey,
        scheduledAt: lesson.scheduledAt.toISOString(),
        createdAt: lesson.createdAt.toISOString(),
        chatChannel: streamChannelId
          ? { streamChannelId }
          : lesson.chatChannel,
        durationMinutes: lesson.durationMinutes,
        packageId: lesson.packageId ?? null,
        lessonType: lesson.lessonType,
      }}
      user={{
        id: user.id,
        name: user.name,
        role: user.role,
      }}
      pedagogicalBrief={studentPedagogicalBrief}
    />
  );
}
