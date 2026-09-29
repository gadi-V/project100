import { StreamChat } from "stream-chat";
import {
  STREAM_EMAIL_BLOCK_PATTERNS,
  STREAM_LINK_BLOCK_PATTERNS,
  STREAM_PHONE_BLOCK_PATTERNS,
} from "./chat-moderation";

const PRIVACY_PHONE_BLOCKLIST = "project8_phone_pii";
const PRIVACY_EMAIL_BLOCKLIST = "project8_email_pii";
const PRIVACY_LINK_BLOCKLIST = "project8_external_links";

export const STREAM_TOKEN_TTL_SECONDS = 4 * 60 * 60;

let streamClient: StreamChat | null = null;
let moderationReady: Promise<void> | null = null;

function getStreamApiKey(): string | null {
  const key =
    process.env.STREAM_API_KEY?.trim() ||
    process.env.NEXT_PUBLIC_STREAM_API_KEY?.trim();
  return key || null;
}

function getStreamApiSecret(): string | null {
  return process.env.STREAM_API_SECRET?.trim() || null;
}

/** True when both Stream credentials are configured for live API calls. */
export function hasStreamCredentials(): boolean {
  return Boolean(getStreamApiKey() && getStreamApiSecret());
}

/** Server-side Stream Chat client (API key + secret). Never use the secret in the browser. */
export function getStreamServerClient(): StreamChat {
  const key = getStreamApiKey();
  const secret = getStreamApiSecret();
  if (!key || !secret) {
    throw new Error(
      "STREAM_API_KEY/NEXT_PUBLIC_STREAM_API_KEY and STREAM_API_SECRET must be set for live Stream Chat"
    );
  }
  if (!streamClient) {
    streamClient = StreamChat.getInstance(key, secret);
  }
  return streamClient;
}

export function streamChannelIdForLesson(lessonId: string): string {
  return `lesson_${lessonId}`;
}

export function streamChannelIdForPackage(packageId: string): string {
  return `package-${packageId}`;
}

/** User JWT for connecting the browser SDK; hard-expires 4 hours after issuance. */
export function generateStreamToken(userId: string): string {
  if (!hasStreamCredentials()) {
    return `mock-stream-token-${userId}`;
  }
  const exp = Math.floor(Date.now() / 1000) + STREAM_TOKEN_TTL_SECONDS;
  return getStreamServerClient().createToken(userId, exp);
}

async function ensureBlockList(
  client: StreamChat,
  name: string,
  words: string[],
  type: "regex"
): Promise<void> {
  try {
    await client.createBlockList({ name, words, type });
  } catch (error: unknown) {
    // Already exists — update words so patterns stay current
    try {
      await client.updateBlockList(name, { words });
    } catch (updateError) {
      console.warn(`Stream blocklist ${name} ensure failed:`, updateError);
    }
  }
}

/**
 * Ensure Stream-side regex blocklists for phone/email (server moderation).
 * Best-effort: failures are logged and do not block channel creation.
 */
export async function ensureStreamPrivacyModeration(): Promise<void> {
  if (!hasStreamCredentials()) return;

  if (!moderationReady) {
    moderationReady = (async () => {
      const client = getStreamServerClient();
      await ensureBlockList(
        client,
        PRIVACY_PHONE_BLOCKLIST,
        STREAM_PHONE_BLOCK_PATTERNS,
        "regex"
      );
      await ensureBlockList(
        client,
        PRIVACY_EMAIL_BLOCKLIST,
        STREAM_EMAIL_BLOCK_PATTERNS,
        "regex"
      );
      await ensureBlockList(
        client,
        PRIVACY_LINK_BLOCKLIST,
        STREAM_LINK_BLOCK_PATTERNS,
        "regex"
      );

      try {
        // Attach privacy blocklists to messaging channels (block PII / external links server-side).
        await client.updateChannelType("messaging", {
          automod: "simple",
          automod_behavior: "flag",
          blocklists: [
            { blocklist: PRIVACY_PHONE_BLOCKLIST, behavior: "block" },
            { blocklist: PRIVACY_EMAIL_BLOCKLIST, behavior: "block" },
            { blocklist: PRIVACY_LINK_BLOCKLIST, behavior: "block" },
          ],
        });
      } catch (error) {
        console.warn("Stream messaging channel-type automod update skipped:", error);
      }
    })().catch((error) => {
      moderationReady = null;
      throw error;
    });
  }

  try {
    await moderationReady;
  } catch (error) {
    console.warn("Stream privacy moderation setup failed:", error);
  }
}

/**
 * Upsert a private messaging channel with the given Stream channel id
 * and member set (student, teacher, managers — no PII on user records).
 * When Stream credentials are unset, returns a mock channel id so booking can proceed.
 */
export async function ensureStreamMessagingChannel(
  channelId: string,
  memberIds: string[]
): Promise<string> {
  const uniqueMembers = [...new Set(memberIds.filter(Boolean))];
  if (uniqueMembers.length < 2) {
    throw new Error("ensureStreamMessagingChannel requires at least two member ids");
  }

  if (!hasStreamCredentials()) {
    console.warn(
      `[stream] credentials unset — returning mock channel id ${channelId}`
    );
    return channelId.startsWith("mock-") ? channelId : `mock-${channelId}`;
  }

  const client = getStreamServerClient();
  await ensureStreamPrivacyModeration();

  await client.upsertUsers(
    uniqueMembers.map((id) => ({
      id,
      name: `User ${id.slice(0, 4)}`,
    }))
  );

  const channel = client.channel("messaging", channelId, {
    members: uniqueMembers,
    created_by_id: uniqueMembers[0],
  });

  try {
    await channel.create();
  } catch (error: unknown) {
    // Channel may already exist (retry / re-seed) — ensure membership is correct
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists|duplicate/i.test(message)) {
      try {
        await channel.addMembers(uniqueMembers);
      } catch {
        throw error;
      }
    } else {
      await channel.addMembers(uniqueMembers);
    }
  }

  return channelId;
}

/**
 * Create a private messaging channel limited to the given members
 * (lesson student, teacher, and manager(s) only).
 */
export async function createStreamChannel(
  lessonId: string,
  memberIds: string[]
): Promise<string> {
  return ensureStreamMessagingChannel(
    streamChannelIdForLesson(lessonId),
    memberIds
  );
}

/**
 * Create / ensure a package-scoped Stream channel so chat history
 * persists across all lessons in the package.
 */
export async function createPackageStreamChannel(
  packageId: string,
  memberIds: string[]
): Promise<string> {
  return ensureStreamMessagingChannel(
    streamChannelIdForPackage(packageId),
    memberIds
  );
}
