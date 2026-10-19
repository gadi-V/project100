import { prisma } from "../prisma";
import {
  createStreamChannel,
  hasStreamCredentials,
  streamChannelIdForLesson,
} from "../stream";

/**
 * Replace a leftover mock Stream channel id with a live `lesson_<id>` channel.
 * A non-mock id is returned immediately. Missing credentials or a failed
 * create/update keep the current id so the lesson page still renders.
 */
export async function ensureLiveStreamChannel(
  lessonId: string,
  currentChannelId: string
): Promise<string> {
  if (!currentChannelId.startsWith("mock-")) {
    return currentChannelId;
  }

  if (!hasStreamCredentials()) {
    console.warn(
      `[chat-healing] Stream credentials unset — keeping ${currentChannelId} for lesson ${lessonId}`
    );
    return currentChannelId;
  }

  const liveId = streamChannelIdForLesson(lessonId);

  try {
    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { teacherId: true, studentId: true },
    });
    if (!lesson?.teacherId || !lesson.studentId) {
      console.warn(
        `[chat-healing] lesson ${lessonId} is missing participants — keeping ${currentChannelId}`
      );
      return currentChannelId;
    }

    const managers = await prisma.user.findMany({
      where: { role: { in: ["MANAGER", "ADMIN"] } },
      select: { id: true },
    });
    const memberIds = [
      lesson.teacherId,
      lesson.studentId,
      ...managers.map((manager) => manager.id),
    ];

    const createdId = await createStreamChannel(lessonId, memberIds);
    if (createdId !== liveId) {
      console.warn(
        `[chat-healing] expected Stream channel ${liveId} for lesson ${lessonId}, got ${createdId} — keeping ${currentChannelId}`
      );
      return currentChannelId;
    }

    await prisma.lesson.update({
      where: { id: lessonId },
      data: {
        chatChannel: {
          upsert: {
            create: { streamChannelId: liveId },
            update: { streamChannelId: liveId },
          },
        },
      },
    });

    return liveId;
  } catch (error) {
    console.warn(`[chat-healing] failed to heal lesson ${lessonId}:`, error);
    return currentChannelId;
  }
}
