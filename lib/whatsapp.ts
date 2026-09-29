/**
 * Central WhatsApp automation — unidirectional system notifications only.
 * Bidirectional chat stays in-app (Stream Chat); never relay participant phones.
 */

import { normalizeToE164, normalizeToWhatsAppJid } from "./utils/phone";

function getAppUrl(): string {
  return (
    process.env.APP_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    "http://localhost:3000"
  );
}

function getWhatsAppConfig(): { apiUrl: string; apiKey: string } | null {
  const apiUrl = process.env.WHATSAPP_API_URL?.trim();
  const apiKey = process.env.WHATSAPP_API_KEY?.trim();
  if (!apiUrl || !apiKey) return null;
  return { apiUrl: apiUrl.replace(/\/$/, ""), apiKey };
}

/** Personal numbers → `972XXXXXXXXX@c.us`; existing group JIDs (`…@g.us`) pass through. */
function resolveWhatsAppRecipient(target: string): { phone: string; chatId: string } {
  const trimmed = target.trim();
  const chatId = trimmed.endsWith("@g.us") ? trimmed : normalizeToWhatsAppJid(trimmed);
  return { phone: chatId.slice(0, chatId.indexOf("@")), chatId };
}

export async function sendWhatsAppText(phone: string, message: string): Promise<void> {
  const config = getWhatsAppConfig();
  const recipient = resolveWhatsAppRecipient(phone);
  const chatId = recipient.chatId;

  if (!config) {
    console.log("================== MOCK WHATSAPP (text) ==================");
    console.log(`To: ${chatId}`);
    console.log(`Message:\n${message}`);
    console.log("==========================================================");
    return;
  }

  const response = await fetch(`${config.apiUrl}/sendMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phone: recipient.phone,
      chatId,
      message,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`WhatsApp sendMessage failed (${response.status}): ${detail}`);
  }
}

async function sendWhatsAppDocument(
  phone: string,
  caption: string,
  pdfBuffer: Buffer,
  fileName = "board-summary.pdf"
): Promise<void> {
  const config = getWhatsAppConfig();
  const recipient = resolveWhatsAppRecipient(phone);
  const chatId = recipient.chatId;

  if (!config) {
    console.log("================== MOCK WHATSAPP (document) ==================");
    console.log(`To: ${chatId}`);
    console.log(`File: ${fileName} (${pdfBuffer.length} bytes)`);
    console.log(`Caption:\n${caption}`);
    console.log("==============================================================");
    return;
  }

  const form = new FormData();
  form.append("phone", recipient.phone);
  form.append("chatId", chatId);
  form.append("caption", caption);
  form.append(
    "file",
    new Blob([new Uint8Array(pdfBuffer)], { type: "application/pdf" }),
    fileName
  );

  const response = await fetch(`${config.apiUrl}/sendDocument`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`WhatsApp sendDocument failed (${response.status}): ${detail}`);
  }
}

export type LessonReminderNotificationInput = {
  phone: string;
  /** Display name of the recipient (student or teacher). */
  recipientName: string;
  lessonId: string;
  startTime: Date | string;
};

/**
 * Unidirectional reminder ~15 minutes before lesson start.
 * Deep-links into the in-app virtual classroom (not a WhatsApp chat thread).
 * Sent to both student and teacher by the cron scheduler.
 */
export async function sendLessonReminderNotification({
  phone,
  recipientName,
  lessonId,
  startTime,
}: LessonReminderNotificationInput): Promise<void> {
  const classroomUrl = `${getAppUrl()}/lessons/${lessonId}`;
  const message =
    `היי ${recipientName}, השיעור שלך מתחיל בעוד 15 דקות! 🎓\n` +
    `לחץ כאן לכניסה ישירה לכיתה הווירטואלית: ${classroomUrl}`;

  // startTime reserved for schedulers / audit; message copy is fixed at T-15.
  void startTime;

  await sendWhatsAppText(phone, message);
}

/** Sender branding — all outbound notifications originate from the business account. */
const BRAND_NAME = "PROJECT100";
const BRAND_SIGNATURE = `צוות ${BRAND_NAME}`;

export type LessonSummaryNotificationInput = {
  phone: string;
  userName: string;
  pdfBuffer: Buffer | null;
  pdfSecureUrl: string | null;
  videoStreamingUrl: string;
  /** Short, non-sensitive summary details shown in the message body. */
  lessonSummary?: string;
};

/**
 * Lesson-end summary, sent as the official business sender (never the tutor's
 * personal number): secure PDF link + recording streaming link.
 * Falls back to raw text when no PDF is available.
 */
export async function sendLessonSummaryNotification({
  phone,
  userName,
  pdfBuffer,
  pdfSecureUrl,
  videoStreamingUrl,
  lessonSummary,
}: LessonSummaryNotificationInput): Promise<void> {
  const summaryLine = lessonSummary?.trim()
    ? `\nפרטי השיעור: ${lessonSummary.trim()}\n`
    : "\n";

  const pdfLine = pdfSecureUrl
    ? `\nקישור מאובטח לקובץ ה-PDF של הלוח: ${pdfSecureUrl}\n`
    : pdfBuffer && pdfBuffer.length > 0
      ? "\nמצורף קובץ ה-PDF של הלוח המחיק.\n"
      : "";

  const message =
    `היי ${userName},\n` +
    `השיעור שלך הושלם והסיכום מוכן! ✅${summaryLine}` +
    pdfLine +
    `לצפייה בהקלטת השיעור באיכות גבוהה: ${videoStreamingUrl}\n\n` +
    `${BRAND_SIGNATURE}`;

  if (pdfBuffer && pdfBuffer.length > 0) {
    await sendWhatsAppDocument(
      phone,
      message,
      pdfBuffer
    );
    return;
  }

  await sendWhatsAppText(phone, message);
}

/** ISO-8601 date+time in the local (Israel) timezone, stable for message copy. */
function formatLocalDateTime(date: Date): string {
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  }).format(date);
}

export type LessonCancellationNotificationInput = {
  /** Recipient phone (student or teacher). */
  phone: string;
  recipientName: string;
  lessonId: string;
  subject: string;
  scheduledAt: Date;
  /** Outcome copy: "בוטל", "בוטל באיחור", "הוחלף במורה חלוף" etc. */
  outcome: string;
  extra?: string;
};

/**
 * Notification about a cancelled / late-cancelled / substituted lesson.
 * Sent from the official business account to the affected party.
 */
export async function sendLessonCancellationNotification({
  phone,
  recipientName,
  lessonId,
  subject,
  scheduledAt,
  outcome,
  extra,
}: LessonCancellationNotificationInput): Promise<void> {
  const classroomUrl = `${getAppUrl()}/lessons/${lessonId}`;
  const message =
    `היי ${recipientName},\n` +
    `${subject} המתוכנן ל-${formatLocalDateTime(scheduledAt)} — ${outcome}.\n` +
    (extra ? `${extra}\n` : "") +
    `לפרטים נוספים: ${classroomUrl}\n\n${BRAND_SIGNATURE}`;
  await sendWhatsAppText(phone, message);
}

export type ParentDiagnosticAlertInput = {
  parentPhone: string;
  parentName?: string | null;
  studentName: string;
  subject: string;
  estimatedScore: number;
  teaserUrl?: string;
};

/**
 * Notification sent to parent upon diagnostic completion (Quad-Ecosystem alignment).
 */
export async function sendParentDiagnosticAlertNotification({
  parentPhone,
  parentName,
  studentName,
  subject,
  estimatedScore,
  teaserUrl,
}: ParentDiagnosticAlertInput): Promise<void> {
  const greeting = parentName?.trim() ? `שלום ${parentName.trim()}` : "שלום";
  const portalUrl = teaserUrl || `${getAppUrl()}/onboarding/diagnostic`;

  const message =
    `${greeting},\n` +
    `האבחון הלימודי של ${studentName} במקצוע ${subject} הושלם בהצלחה! 🎯\n` +
    `ציון מוכנות משוער: ${estimatedScore}/100.\n` +
    `לצפייה בדו״ח האבחון המלא, זיהוי פערי הידע ושיבוץ מורה מומחה:\n` +
    `${portalUrl}\n\n` +
    `${BRAND_SIGNATURE}`;

  await sendWhatsAppText(parentPhone, message);
}

export type QuadGroupInviteInput = {
  recipientPhone: string;
  recipientName?: string | null;
  studentName: string;
  teacherName: string;
  groupUrl: string;
};

/**
 * Sends a single unified Quad WhatsApp group invite link to the student/parent,
 * connecting Student, Teacher, Parent, and Academic Manager in one place.
 */
export async function sendQuadGroupInvite({
  recipientPhone,
  recipientName,
  studentName,
  teacherName,
  groupUrl,
}: QuadGroupInviteInput): Promise<void> {
  const greeting = recipientName?.trim() ? `שלום ${recipientName.trim()}` : "שלום";
  const message =
    `${greeting},\n` +
    `ברוכים הבאים ל-Quad Ecosystem של ${BRAND_NAME}!\n` +
    `פתחנו עבורכם קבוצת ליווי ייעודית ב-WhatsApp המאגדת את התלמיד (${studentName}), המורה המומחה (${teacherName}), ההורים והמנהל הפדגוגי.\n\n` +
    `להצטרפות לקבוצה וקבלת סיכומי שיעור שוטפים:\n` +
    `${groupUrl}\n\n` +
    `${BRAND_SIGNATURE}`;

  await sendWhatsAppText(recipientPhone, message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Quad-group creation (WhatsApp Cloud API scaffold)
// Members: Admin (pedagogical manager) + Teacher + Student + Parent
// SINGLE lessons never call this — transactional 1-on-1 only.
// ─────────────────────────────────────────────────────────────────────────────

export type QuadGroupMemberRole = "ADMIN" | "TEACHER" | "STUDENT" | "PARENT";

export type QuadGroupMember = {
  role: QuadGroupMemberRole;
  phone: string;
  name?: string | null;
};

export type CreateQuadGroupInput = {
  /** Stable id used for mock/deterministic invite tokens. */
  studentId: string;
  studentName: string;
  members: QuadGroupMember[];
  subject?: string | null;
  teacherName?: string | null;
};

export type CreateQuadGroupResult = {
  inviteUrl: string;
  groupId: string | null;
  mocked: boolean;
};

/**
 * Scaffolds WhatsApp Cloud API quad-group creation.
 * Guards all external HTTP behind WHATSAPP_API_KEY — without it, returns a
 * deterministic mock invite URL (dev-safe, no network).
 */
export async function createWhatsAppQuadGroup(
  input: CreateQuadGroupInput
): Promise<CreateQuadGroupResult> {
  const members = input.members
    .filter((m) => m.phone?.trim())
    .map((m) => ({
      role: m.role,
      phone: normalizeToE164(m.phone).slice(1),
      name: m.name?.trim() || null,
    }));

  const mockInviteUrl = `https://chat.whatsapp.com/mock-quad-${input.studentId.slice(0, 8)}`;

  if (!process.env.WHATSAPP_API_KEY) {
    console.log("[MOCK] Quad Group created with members:", members);
    return { inviteUrl: mockInviteUrl, groupId: null, mocked: true };
  }

  const config = getWhatsAppConfig();
  if (!config) {
    console.log("[MOCK] Quad Group created with members:", members);
    return { inviteUrl: mockInviteUrl, groupId: null, mocked: true };
  }

  // WhatsApp Cloud / BSP group-create scaffold (provider-specific path).
  const subjectLabel = input.subject?.trim() || "ליווי פדגוגי";
  const groupSubject = `${BRAND_NAME} · ${input.studentName} · ${subjectLabel}`;

  const response = await fetch(`${config.apiUrl}/groups`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subject: groupSubject,
      description:
        `קבוצת ליווי מרובעת (מנהל פדגוגי + מורה + תלמיד + הורה) עבור ${input.studentName}` +
        (input.teacherName ? ` · מורה: ${input.teacherName}` : ""),
      participants: members.map((m) => ({
        phone: m.phone,
        role: m.role,
        name: m.name,
      })),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`WhatsApp create group failed (${response.status}): ${detail}`);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    inviteUrl?: string;
    invite_link?: string;
    groupId?: string;
    id?: string;
  };

  const inviteUrl =
    payload.inviteUrl ||
    payload.invite_link ||
    mockInviteUrl;
  const groupId = payload.groupId || payload.id || null;

  return { inviteUrl, groupId, mocked: false };
}

export type QuadLessonSummaryInput = {
  groupUrl?: string | null;
  groupChatId?: string | null;
  studentName: string;
  teacherName: string;
  subject: string;
  topicsMastered?: string[];
  pdfBuffer?: Buffer | null;
  pdfUrl?: string | null;
  videoStreamingUrl?: string | null;
};

/**
 * Dispatches a single post-lesson summary & vector PDF directly to the shared Quad group.
 * Optimizes cost and keeps student, parent, teacher, and manager completely aligned.
 */
export async function dispatchQuadLessonSummary({
  groupChatId,
  studentName,
  teacherName,
  subject,
  topicsMastered,
  pdfBuffer,
  pdfUrl,
  videoStreamingUrl,
}: QuadLessonSummaryInput): Promise<void> {
  if (!groupChatId?.trim().endsWith("@g.us")) {
    throw new Error("dispatchQuadLessonSummary requires a WhatsApp group chat id (…@g.us)");
  }
  const targetId = groupChatId.trim();
  const topicsPart =
    topicsMastered && topicsMastered.length > 0
      ? `\nנושאים ומיומנויות שתורגלו בהצלחה:\n• ${topicsMastered.join("\n• ")}\n`
      : "";
  const pdfLine = pdfUrl ? `\nלוח שיעור וסיכום PDF: ${pdfUrl}\n` : "";
  const videoLine = videoStreamingUrl ? `הקלטת השיעור המלאה: ${videoStreamingUrl}\n` : "";

  const message =
    `🎓 סיכום שיעור ${subject} — ${studentName}\n` +
    `מורה מוביל: ${teacherName} ✅${topicsPart}` +
    pdfLine +
    videoLine +
    `\nצוות המעקב הפדגוגי זמין כאן לכל שאלה.\n${BRAND_SIGNATURE}`;

  if (pdfBuffer && pdfBuffer.length > 0) {
    await sendWhatsAppDocument(targetId, message, pdfBuffer, `summary-${studentName}.pdf`);
    return;
  }

  await sendWhatsAppText(targetId, message);
}

// ─────────────────────────────────────────────────────────────────────────────
// מחולל הודעות המרה אוטומטי לפי עומק הפער (Lead Conversion & WhatsApp Closer)
// ─────────────────────────────────────────────────────────────────────────────

export type PackageSize = "SINGLE" | "TRIO" | "MULTI" | "TEN";

/**
 * Maps the diagnosed knowledge-gap depth to the recommended package:
 * ・ פער קל (1–2 נושאים)  → TRIO (3 שיעורים)
 * ・ פער עמוק (3+ נושאים) → MULTI (5 שיעורים)
 */
export function determinePackageForGapDepth(gapTopicsCount: number): {
  packageType: PackageSize;
  lessons: number;
  label: string;
} {
  if (gapTopicsCount >= 3) {
    return {
      packageType: "MULTI",
      lessons: 5,
      label: "חבילת 5 שיעורים (Multi)",
    };
  }
  if (gapTopicsCount >= 0) {
    return {
      packageType: "TRIO",
      lessons: 3,
      label: "חבילת 3 שיעורים (Trio)",
    };
  }
  return {
    packageType: "SINGLE",
    lessons: 1,
    label: "שיעור בודד",
  };
}

export type ConversionMessageInput = {
  studentName: string;
  subject: string;
  gapTopicsCount: number;
  gapTopicsNames?: string[];
  estimatedScore?: number | null;
  parentPhone?: string | null;
};

/**
 * Automatic WhatsApp conversion message generated from diagnosis depth:
 * ・ לא משלח הודעה כשלא בוצע אבחון (guard).
 * ・ ממליץ על חבילת Trio לפער קל (1–2 נושאים) או Multi לפער עמוק (3+).
 */
export function buildConversionMessage({
  studentName,
  subject,
  gapTopicsCount,
  gapTopicsNames = [],
  estimatedScore,
}: ConversionMessageInput): string {
  const { label, lessons } = determinePackageForGapDepth(gapTopicsCount);

  const depthLine =
    gapTopicsCount >= 3
      ? `זוהו ${gapTopicsCount} נושאי פער עמוקים — מומלצת ${label} (${lessons} שיעורים) לסגירה סיסטמטית.`
      : `זוהו ${gapTopicsCount} נושאי פער קלים — מומלצת ${label} (${lessons} שיעורים) לחיזוק ממוקד.`;

  const namesLine =
    gapTopicsNames.length > 0
      ? `נושאים: ${gapTopicsNames.slice(0, 4).join(", ")}.\n`
      : "";

  const scoreLine =
    typeof estimatedScore === "number" && estimatedScore > 0
      ? `מדד המוכנות הנוכחי: ${estimatedScore}%. ` +
        (estimatedScore < 60
          ? "סיכון גבוה לבחינה הקרובה — רצוי להתחיל כבר השבוע."
          : "בסיס סביר — ליטוש ממוקד כעת ימקסם את הציון.")
      : "";

  return (
    `היי ${studentName},\n` +
    `סגרנו עבורך את דו״ח האבחון ב-${subject}.\n` +
    `${depthLine}\n` +
    `${namesLine}` +
    (scoreLine ? `${scoreLine}\n` : "") +
    `לשיבוץ מיידי של מורה מומחה ופתיחת קבוצת הליווי הייעודית: ${getAppUrl()}/pricing\n\n` +
    `${BRAND_SIGNATURE}`
  );
}

/**
 * נוסח WhatsApp מותאם אישית לפי מסמך האפיון 1.9 — תבנית ההמרה STU-מבוססת:
 *
 * "היי [שם פרטי], בתהליך האבחון המקצועי זיהינו פער ממוקד ב-[X] נושאים
 *  ב[מסלול]. המערכת איתרה עבורך מורה מומחה... ההמלצה הפדגוגית עבורך היא
 *  חבילת [3 / 5] שיעורים, הכוללת פתיחת קבוצת WhatsApp מרובעת ייעודית..."
 */
export function buildPersonalizedDiagnosticConversion(input: {
  firstName: string;
  gapTopicsCount: number;
  trackLabel: string;
  teacherName?: string | null;
  pricingUrl?: string;
}): string {
  const { firstName, gapTopicsCount, trackLabel, teacherName, pricingUrl } = input;
  const { lessons, label } = determinePackageForGapDepth(gapTopicsCount);
  const teacherLine = teacherName
    ? ` המערכת איתרה עבורך מורה מומחה (${teacherName}).`
    : "";

  return (
    `היי ${firstName}, בתהליך האבחון המקצועי זיהינו פער ממוקד ב-${gapTopicsCount} נושאים ב${trackLabel}.` +
    `${teacherLine}` +
    ` ההמלצה הפדגוגית עבורך היא ${label} (${lessons} שיעורים), הכוללת פתיחת קבוצת WhatsApp מרובעת ייעודית` +
    ` (מנהל פדגוגי + מורה מומחה + תלמיד + הורה) לעדכונים שוטפים ולתוכנית עבודה אישית.` +
    `\nלהתחלה מהירה: ${pricingUrl ?? `${getAppUrl()}/pricing`}\n\n${BRAND_SIGNATURE}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Gap-analysis outreach — structured result (analytics + personalized copy).
// Complements the copy-only helpers above by returning the full, decision-ready
// payload (recommended package, credits, and the identified gap list) so callers
// can render dashboards, export reports, or dispatch the message directly.
// ─────────────────────────────────────────────────────────────────────────────

export interface GapAnalysisResult {
  studentName: string;
  trackName: string;
  gapsCount: number;
  identifiedGaps: string[];
  recommendedPackage: "TRIO" | "MULTI";
  creditsCount: number;
  customOutreachMessage: string;
}

/**
 * Analyzes the diagnosed knowledge-gap depth and generates a personalized
 * outreach message (spec 1.9 STU-style funnel):
 * ・ פער קל (1–2 נושאים)  → TRIO, 3 שיעורים.
 * ・ פער עמוק (3+ נושאים) → MULTI, 5 שיעורים.
 *
 * Mirrors the business rule already encoded in `determinePackageForGapDepth`
 * (never set below TRIO — SINGLE stays a transactional-only channel, never an
 * outreach recommendation).
 */
export function analyzeGapsAndGenerateOutreach(params: {
  studentName: string;
  trackName: string;
  identifiedGaps: string[];
  portalUrl?: string;
}): GapAnalysisResult {
  const {
    studentName,
    trackName,
    identifiedGaps,
    portalUrl = `${getAppUrl()}/dashboard`,
  } = params;

  const gapsCount = identifiedGaps.length;
  const isDeepGap = gapsCount >= 3;
  const recommendedPackage = isDeepGap ? "MULTI" : "TRIO";
  const creditsCount = isDeepGap ? 5 : 3;

  const customOutreachMessage =
    `היי ${studentName}, בתהליך האבחון המקצועי זיהינו פער ממוקד ב-${gapsCount} נושאים ב${trackName}. ` +
    `המערכת איתרה עבורך מורה מומחה ב${trackName} עם התאמה מדויקת לפערים שזוהו.\n\n` +
    `כדי לסגור את הפערים בצורה יסודית, ההמלצה הפדגוגית עבורך היא חבילת ${creditsCount} שיעורים, ` +
    `הכוללת כניסה למעטפת ליווי אישית ופתיחת קבוצת WhatsApp מרובעת ייעודית ` +
    `(מנהל פדגוגי, מורה מומחה, הורה ותלמיד) למעקב צמוד עד להצלחה.\n\n` +
    `לצפייה בדוח המלא ובחירת מועד לשיעור הראשון:\n${portalUrl}`;

  return {
    studentName,
    trackName,
    gapsCount,
    identifiedGaps,
    recommendedPackage,
    creditsCount,
    customOutreachMessage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Closer — full close-loop engagement for a diagnosed student.
// ・ Runs the gap analysis (spec 1.9) and derives the package + credits.
// ・ For TRIO/MULTI it opens the dedicated Quad WhatsApp group (manager +
//    expert teacher + parent + student) and invites the parent; for SINGLE it
//    stays transactional-only (no group is ever opened).
// ・ Uses ONLY the existing primitives above — never raw network calls.
// ・ Returns a structured result so callers can render/audit the action.
// ─────────────────────────────────────────────────────────────────────────────

export type WhatsAppCloserInput = {
  studentName: string;
  trackName: string;
  identifiedGaps: string[];
  /** SMS/WhatsApp target for the reachable party (parent preferred). */
  recipientPhone: string;
  recipientName?: string | null;
  portalUrl?: string;
  /** Only the two outreach packages are eligible (SINGLE never opens a group). */
  forcePackage?: "TRIO" | "MULTI";
  /** When the group is being opened, we always invite the parent — never the student's own phone if absent. */
  whatsappGroupUrl?: string;
  // ── Additive fields (kept optional to preserve the existing contract) ──
  studentId?: string | null;
  studentPhone?: string | null;
  parentPhone?: string | null;
  packageType?: PackageSize;
  teacherName?: string | null;
};

export type WhatsAppCloserResult = {
  success: boolean;
  analysis: GapAnalysisResult;
  channel: "TRANSACTIONAL_SINGLE" | "QUAD_GROUP";
  isGroupOpened: boolean;
  quadGroupUrl: string | null;
  messagePreview: string;
  dispatchError?: string;
  /** Structured dispatch summary (additive — mirrors what the API returns). */
  dispatch?: {
    channel: "TRANSACTIONAL_SINGLE" | "QUAD_GROUP";
    isGroupOpened: boolean;
    quadGroupUrl: string | null;
    dispatchError?: string;
  };
};

/**
 * Closes the diagnostic funnel end-to-end for a student:
 * gap depth → recommended package → personalized copy → Quad group (TRIO/MULTI)
 * or transactional message (SINGLE). Fail-open: when WhatsApp delivery is not
 * configured the analysis + channel decision are still returned (dry-run safe).
 */
export async function dispatchWhatsAppCloser(
  input: WhatsAppCloserInput
): Promise<WhatsAppCloserResult> {
  const {
    studentName,
    trackName,
    identifiedGaps,
    recipientPhone,
    recipientName,
    portalUrl,
    forcePackage,
    whatsappGroupUrl,
    parentPhone,
    studentPhone,
    packageType: packageTypeOverride,
    teacherName,
  } = input;

  const analysis = analyzeGapsAndGenerateOutreach({
    studentName,
    trackName,
    identifiedGaps,
    portalUrl,
  });

  // The closer only ever routes TRIO/MULTI (outreach tiers that open a Quad group).
  // SINGLE stays transactional-only and is handled by the dispatch-channel route.
  // Explicit `packageType` wins; otherwise fall back to the gap-depth analysis.
  const resolvedPackage: "TRIO" | "MULTI" =
    forcePackage ??
    (packageTypeOverride === "TRIO" || packageTypeOverride === "MULTI"
      ? packageTypeOverride
      : analysis.recommendedPackage);
  const channel = "QUAD_GROUP" as const;

  let isGroupOpened = false;
  let quadGroupUrl: string | null = whatsappGroupUrl ?? null;
  let dispatchError: string | undefined;

  try {
    if (!quadGroupUrl) {
      const created = await createWhatsAppQuadGroup({
        studentId: input.studentId || recipientPhone.replace(/\D/g, "").slice(-8) || "unknown",
        studentName,
        subject: trackName,
        teacherName: teacherName || "מורה מומחה (ישובץ בהמשך)",
        members: [
          {
            role: "ADMIN",
            phone: process.env.WHATSAPP_ADMIN_PHONE?.trim() ?? "",
            name: "מנהל פדגוגי",
          },
          {
            role: "TEACHER",
            phone: process.env.WHATSAPP_TEACHER_PLACEHOLDER_PHONE?.trim() ?? "",
            name: teacherName || "מורה מומחה (ישובץ בהמשך)",
          },
          {
            role: "STUDENT",
            phone: studentPhone || recipientPhone,
            name: studentName,
          },
          {
            role: "PARENT",
            phone: parentPhone || recipientPhone,
            name: recipientName || studentName,
          },
        ],
      });
      quadGroupUrl = created.inviteUrl;
      isGroupOpened = true;
    }

    // Prefer the parent (Quad ecosystem), then the student, then the generic recipient.
    const targetPhone = parentPhone || studentPhone || recipientPhone;
    const inviteName = recipientName || studentName;
    await sendQuadGroupInvite({
      recipientPhone: targetPhone,
      recipientName: inviteName,
      studentName,
      teacherName: teacherName || "מורה מומחה (ישובץ בהמשך)",
      groupUrl: quadGroupUrl,
    });
  } catch (error: unknown) {
    // Fail-open: the analysis is still valuable even if delivery fails.
    dispatchError = error instanceof Error ? error.message : String(error);
  }

  const dispatch = {
    channel,
    isGroupOpened,
    quadGroupUrl,
    ...(dispatchError ? { dispatchError } : {}),
  };

  return {
    success: !dispatchError,
    analysis,
    channel,
    isGroupOpened,
    quadGroupUrl,
    messagePreview: analysis.customOutreachMessage.split("\n")[0],
    dispatch,
    ...(dispatchError ? { dispatchError } : {}),
  };
}


