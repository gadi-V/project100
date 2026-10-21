import { prisma } from "../prisma";
import { streamDisplayName } from "../stream-display-name";
import {
  createStreamChannel,
  getStreamServerClient,
  hasStreamCredentials,
  streamChannelIdForLesson,
} from "../stream";

/**
 * Mock ids are replaced with a live `lesson_<id>` channel.
 * A real channel id keeps its id and has its current teacher and student
 * added if they are missing. Existing members are never removed.
 * Missing credentials or a failed Stream call keep the current id so the
 * lesson page still renders.
 */
export async function ensureLiveStreamChannel(
  lessonId: string,
  currentChannelId: string
): Promise<string> {
  if (currentChannelId.startsWith("mock-")) {
    return healMockChannel(lessonId, currentChannelId);
  }

  await reconcileRealChannel(lessonId, currentChannelId);
  return currentChannelId;
}

async function healMockChannel(lessonId: string, currentChannelId: string): Promise<string> {
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

function streamErrorCode(error: unknown): number | string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "number" || typeof code === "string") return code;
  }
  return null;
}

function enrolledIds(channel: {
  state?: { members?: Record<string, { user_id?: string; user?: { id?: string } }> };
}): Set<string> {
  const members = channel.state?.members ?? {};
  const ids = new Set<string>();
  for (const [key, member] of Object.entries(members)) {
    const id = member?.user_id ?? member?.user?.id ?? key;
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Create Stream users that do not exist yet, then add the current teacher
 * and student to the channel. Users Stream already has are not written, so
 * an existing display name stays as it is. A missing channel is created
 * first. Members already on the channel are left in place.
 */
async function reconcileRealChannel(lessonId: string, channelId: string): Promise<void> {
  let teacherId: string | null = null;
  let studentId: string | null = null;

  try {
    if (!hasStreamCredentials()) {
      console.warn(
        `[chat-healing] Stream credentials unset — keeping ${channelId} for lesson ${lessonId}`
      );
      return;
    }

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: {
        teacherId: true,
        studentId: true,
        teacher: { select: { id: true, name: true } },
        student: { select: { id: true, name: true } },
      },
    });
    teacherId = lesson?.teacherId ?? null;
    studentId = lesson?.studentId ?? null;
    if (!teacherId || !studentId) {
      console.warn(
        `[chat-healing] lesson ${lessonId} is missing participants — keeping ${channelId}`
      );
      return;
    }

    const memberIds = [teacherId, studentId];
    const participants = [
      { id: teacherId, name: lesson?.teacher?.name },
      { id: studentId, name: lesson?.student?.name },
    ];
    const client = getStreamServerClient();
    // A failed lookup must not fall through to upsertUsers: that call replaces
    // the user payload and would wipe a display name we could not see.
    const listed = await client.queryUsers({ id: { $in: memberIds } });
    const presentUserIds = new Set(
      (listed.users ?? []).flatMap((user) => (user.id ? [user.id] : []))
    );
    const missing = participants.filter((person) => !presentUserIds.has(person.id));
    if (missing.length > 0) {
      await client.upsertUsers(
        missing.map((person) => ({
          id: person.id,
          name: streamDisplayName(person.name, person.id),
        }))
      );
    }

    const found = await client.queryChannels(
      { type: "messaging", cid: `messaging:${channelId}` },
      [{ created_at: -1 }],
      { limit: 1, state: true, watch: false, message_limit: 0, member_limit: 100 }
    );

    if (found.length === 0) {
      const created = client.channel("messaging", channelId, {
        members: memberIds,
        created_by_id: teacherId,
      });
      await created.create();
      await created.addMembers(memberIds);
      return;
    }

    const present = enrolledIds(found[0]);
    if (memberIds.every((id) => present.has(id))) return;
    await found[0].addMembers(memberIds);
  } catch (error) {
    console.error("[ensureLiveStreamChannel] failed", {
      lessonId,
      teacherId,
      studentId,
      code: streamErrorCode(error),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
