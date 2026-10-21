/**
 * Read-only check of a lesson's Stream channel.
 * Usage: npx tsx scripts/check-lesson-channel.ts <lessonId>
 *
 * Prints created_by, the current member ids, and the ChatChannel row.
 * Does not create the channel, change membership, or write to the database.
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { prisma } from "../lib/prisma";
import { getStreamServerClient, hasStreamCredentials, streamChannelIdForLesson } from "../lib/stream";

loadEnv({ path: resolve(process.cwd(), ".env") });

const lessonId = process.argv[2]?.trim();

if (!lessonId) {
  console.error("Usage: npx tsx scripts/check-lesson-channel.ts <lessonId>");
  process.exit(1);
}

function createdById(
  createdBy: { id?: string } | string | null | undefined,
  createdByIdField: string | undefined
): string | null {
  if (typeof createdBy === "string" && createdBy.length > 0) return createdBy;
  if (createdBy && typeof createdBy === "object" && createdBy.id) return createdBy.id;
  return createdByIdField ?? null;
}

async function storedChatChannel(id: string) {
  const row = await prisma.chatChannel.findUnique({
    where: { lessonId: id },
    select: { id: true, lessonId: true, streamChannelId: true, createdAt: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    lessonId: row.lessonId,
    streamChannelId: row.streamChannelId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function main(): Promise<void> {
  const chatChannel = await storedChatChannel(lessonId);
  const channelId = streamChannelIdForLesson(lessonId);

  if (!hasStreamCredentials()) {
    console.error("Stream credentials are not configured");
    console.log(
      JSON.stringify({ channelId, exists: false, created_by: null, members: [], chatChannel }, null, 2)
    );
    process.exitCode = 1;
    return;
  }

  const client = getStreamServerClient();
  const found = await client.queryChannels(
    { type: "messaging", cid: `messaging:${channelId}` },
    [{ created_at: -1 }],
    { limit: 1, state: true, watch: false, message_limit: 0, member_limit: 100 }
  );
  const channel = found[0];
  if (!channel) {
    console.log(
      JSON.stringify({ channelId, exists: false, created_by: null, members: [], chatChannel }, null, 2)
    );
    return;
  }

  const page = await channel.queryMembers({});
  const members = (page.members ?? [])
    .map((member) => member.user_id ?? member.user?.id ?? null)
    .filter((id): id is string => Boolean(id));

  console.log(
    JSON.stringify(
      {
        channelId,
        exists: true,
        created_by: createdById(channel.data?.created_by, channel.data?.created_by_id),
        members,
        chatChannel,
      },
      null,
      2
    )
  );
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]"));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
