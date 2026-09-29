import { prisma } from "./prisma";
import { writeAuditLog } from "./audit";
import { normalizeToWhatsAppJid } from "./utils/phone";

const DEFAULT_DAILY_DOMAIN = "project100.daily.co";

function getAppUrl(): string {
  return (
    process.env.APP_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    "https://project100.vercel.app"
  );
}

function getWhatsAppConfig(): { apiUrl: string; apiKey: string } | null {
  const apiUrl = process.env.WHATSAPP_API_URL?.trim();
  const apiKey = process.env.WHATSAPP_API_KEY?.trim();
  if (!apiUrl || !apiKey) return null;
  return { apiUrl: apiUrl.replace(/\/$/, ""), apiKey };
}

function getDailyDomain(): string {
  const domain = process.env.DAILY_DOMAIN?.trim();
  if (domain) return domain;
  console.warn(
    `[teacher-welcome] DAILY_DOMAIN is not set — falling back to ${DEFAULT_DAILY_DOMAIN}`
  );
  return DEFAULT_DAILY_DOMAIN;
}

/** `chatId` must already be a normalized WhatsApp JID (`972XXXXXXXXX@c.us`). */
async function sendWhatsAppText(chatId: string, message: string): Promise<void> {
  const config = getWhatsAppConfig();

  if (!config) {
    console.log("================== MOCK WHATSAPP (teacher-welcome) ==================");
    console.log(`To: ${chatId}`);
    console.log(`Message:\n${message}`);
    console.log("=====================================================================");
    return;
  }

  const response = await fetch(`${config.apiUrl}/sendMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phone: chatId.replace(/@c\.us$/, ""),
      chatId,
      message,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`WhatsApp send failed (${response.status}): ${body}`);
  }
}

export type WelcomeEnvelopeInput = {
  teacherId: string;
  adminId?: string;
  customRoomUrl?: string;
  whatsappGroupUrl?: string;
  trainingTrackUrl?: string;
};

export type WelcomeEnvelopeResult = {
  success: boolean;
  permanentRoomUrl: string;
  welcomePackSentAt: Date;
  trainingTrackJoined: boolean;
  /** False when the teacher phone is invalid or the gateway call failed. */
  whatsappSent: boolean;
};

/**
 * Executes the automated welcome envelope when a teacher is approved:
 * 1. Generates or assigns a permanent Daily.co / Project8 virtual classroom URL.
 * 2. Updates TeacherProfile (permanentRoomUrl, welcomePackSentAt, trainingTrackJoined: true, vettingStage: APPROVED).
 * 3. Sends WhatsApp notification with welcome kit, WhatsApp Teachers Guild invite, and 50-hour training track link.
 * 4. Logs audit trail.
 */
export async function dispatchTeacherWelcomeEnvelope({
  teacherId,
  adminId,
  customRoomUrl,
  whatsappGroupUrl = "https://chat.whatsapp.com/project8-teachers-guild",
  trainingTrackUrl = `${getAppUrl()}/teachers/onboarding/status`,
}: WelcomeEnvelopeInput): Promise<WelcomeEnvelopeResult> {
  const teacher = await prisma.user.findUnique({
    where: { id: teacherId },
    include: { teacherProfile: true },
  });

  if (!teacher || teacher.role !== "TEACHER") {
    throw new Error("Teacher user not found");
  }

  const appUrl = getAppUrl();
  const slug = `tutor-${teacher.name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || teacher.id.slice(0, 8)}`;
  const permanentRoomUrl = customRoomUrl || `https://${getDailyDomain()}/${slug}`;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: teacherId },
      data: { isApproved: true },
    });

    await tx.teacherProfile.upsert({
      where: { userId: teacherId },
      create: {
        userId: teacherId,
        subjects: [],
        ageGroups: [],
        vettingStage: "APPROVED",
        permanentRoomUrl,
        welcomePackSentAt: now,
        trainingTrackJoined: true,
      },
      update: {
        vettingStage: "APPROVED",
        permanentRoomUrl,
        welcomePackSentAt: now,
        trainingTrackJoined: true,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: adminId ?? null,
        action: "TEACHER_WELCOME_ENVELOPE_DISPATCHED",
        entityType: "TeacherProfile",
        entityId: teacherId,
        metadata: {
          permanentRoomUrl,
          whatsappGroupUrl,
          trainingTrackUrl,
          sentAt: now.toISOString(),
        },
      },
    });
  });

  // Dispatch Welcome WhatsApp message
  const welcomeMessage =
    `שלום ${teacher.name}! 🌟\n` +
    `ברכותינו! מועמדותך אושרה והצטרפת לנבחרת המורים המובילה של PROJECT100! 🚀\n\n` +
    `הנה ערכת הקליטה האישית שלך:\n` +
    `1. 💻 כיתה וירטואלית קבועה שלך:\n${permanentRoomUrl}\n\n` +
    `2. 💬 קהילת המורים הרשמית ב-WhatsApp:\n${whatsappGroupUrl}\n\n` +
    `3. 🎓 מסלול הכשרה פדגוגי מואץ (50 שעות):\n${trainingTrackUrl}\n\n` +
    `4. 📅 לכניסה לדאשבורד ופתיחת שעות זמינות ביומן:\n${appUrl}/dashboard\n\n` +
    `מאחלים לך הצלחה רבה והוראה מעצימה!\n` +
    `צוות PROJECT100`;

  let chatId: string | null = null;
  try {
    chatId = normalizeToWhatsAppJid(teacher.phone);
  } catch (err) {
    console.error(
      `[teacher-welcome] Invalid phone for teacher ${teacherId}; WhatsApp welcome not sent:`,
      err instanceof Error ? err.message : err
    );
  }

  let whatsappSent = false;
  if (chatId) {
    try {
      await sendWhatsAppText(chatId, welcomeMessage);
      whatsappSent = true;
    } catch (err) {
      console.error("Failed to send WhatsApp welcome envelope:", err);
    }
  }

  return {
    success: true,
    permanentRoomUrl,
    welcomePackSentAt: now,
    trainingTrackJoined: true,
    whatsappSent,
  };
}
