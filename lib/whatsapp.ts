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

export function isWhatsAppConfigured(): boolean {
  return getWhatsAppConfig() !== null;
}

export type WhatsAppSendResult = {
  /** Provider message id when the gateway returns one. */
  messageId: string | null;
  /** True when no gateway is configured and the message was only logged. */
  mocked: boolean;
};

/** Gateways differ: Green-API `idMessage`, WAHA `id` / `id._serialized`, Baileys `key.id`. */
function extractMessageId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  for (const key of ["idMessage", "messageId", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "object" && value !== null) {
      const serialized = (value as Record<string, unknown>)._serialized;
      if (typeof serialized === "string" && serialized) return serialized;
    }
  }
  const nestedKey = record.key;
  if (typeof nestedKey === "object" && nestedKey !== null) {
    const id = (nestedKey as Record<string, unknown>).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

export async function sendWhatsAppMessage(
  target: string,
  message: string,
  options: { timeoutMs?: number } = {}
): Promise<WhatsAppSendResult> {
  const config = getWhatsAppConfig();
  const recipient = resolveWhatsAppRecipient(target);
  const chatId = recipient.chatId;

  if (!config) {
    console.log("================== MOCK WHATSAPP (text) ==================");
    console.log(`To: ${chatId}`);
    console.log(`Message:\n${message}`);
    console.log("==========================================================");
    return { messageId: null, mocked: true };
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
    ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`WhatsApp sendMessage failed (${response.status}): ${detail}`);
  }

  const body: unknown = await response.json().catch(() => null);
  return { messageId: extractMessageId(body), mocked: false };
}

export async function sendWhatsAppText(phone: string, message: string): Promise<void> {
  await sendWhatsAppMessage(phone, message);
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
// Quad group (live gateway): Student + Teacher + optional Parent + Admin
// (WHATSAPP_ADMIN_PHONE). Opened only once a teacher and a first lesson exist,
// then greeted with the structured welcome message. SINGLE never opens a group.
// ─────────────────────────────────────────────────────────────────────────────

export type QuadGroupRole = "STUDENT" | "TEACHER" | "PARENT" | "ADMIN";

export type QuadGroupParticipant = { role: QuadGroupRole; chatId: string };

export type CreateQuadGroupInput = {
  student: { name: string; phone: string };
  teacher: { name: string; phone: string };
  parent?: { name?: string; phone?: string };
  lesson: { scheduledAt: Date; durationMinutes: number; subject?: string };
  questionnaireUrl?: string;
  /** Group already stored for the student (`User.whatsappGroupId`); a second group is never opened. */
  existingGroupId?: string | null;
};

export type QuadGroupErrorCode =
  | "ALREADY_EXISTS"
  | "NOT_CONFIGURED"
  | "MISSING_REQUIRED_PARTICIPANT"
  | "TIMEOUT"
  | "NETWORK"
  | "GATEWAY_ERROR"
  | "INVALID_RESPONSE";

export type QuadGroupError = { code: QuadGroupErrorCode; message: string; status?: number };

export type QuadWelcomeStatus =
  | { sent: true; messageId: string | null }
  | { sent: false; error: string };

type QuadGroupRoster = {
  groupName: string;
  participants: QuadGroupParticipant[];
  /** Roles left out because their phone was missing, invalid, or a duplicate. */
  droppedRoles: QuadGroupRole[];
};

export type CreateQuadGroupResult =
  | (QuadGroupRoster & {
      ok: true;
      chatId: string;
      inviteUrl: string | null;
      welcome: QuadWelcomeStatus;
    })
  | (QuadGroupRoster & { ok: false; error: QuadGroupError });

export const QUAD_GROUP_NAME_MAX_CHARS = 25;
export const QUAD_GATEWAY_TIMEOUT_MS = 10_000;
const QUAD_GROUP_NAME_SUFFIX = ` | ${BRAND_NAME}`;
const DEFAULT_MAPPING_LESSON_MINUTES = 60;
const HEBREW_WEEKDAYS: Record<string, string> = {
  Sun: "ראשון",
  Mon: "שני",
  Tue: "שלישי",
  Wed: "רביעי",
  Thu: "חמישי",
  Fri: "שישי",
  Sat: "שבת",
};

function charLength(text: string): number {
  return Array.from(text).length;
}

/**
 * `"<student> <subject> | PROJECT100"`, at most 25 characters. The brand suffix
 * is kept; the prefix degrades from full name + subject → first name + subject
 * → full name → first name → hard cut, instead of slicing through words.
 */
export function buildQuadGroupName(studentName: string, subject?: string | null): string {
  const name = studentName.trim().replace(/\s+/g, " ") || "תלמיד";
  const firstName = name.split(" ")[0];
  const subjectLabel = subject?.trim().replace(/\s+/g, " ") || "";
  const budget = QUAD_GROUP_NAME_MAX_CHARS - charLength(QUAD_GROUP_NAME_SUFFIX);

  const candidates = subjectLabel
    ? [`${name} ${subjectLabel}`, `${firstName} ${subjectLabel}`, name, firstName]
    : [name, firstName];
  const prefix =
    candidates.find((candidate) => charLength(candidate) <= budget) ??
    Array.from(name).slice(0, budget).join("").trim();
  return `${prefix}${QUAD_GROUP_NAME_SUFFIX}`;
}

/** Normalizes every member to a JID and drops missing, invalid or duplicate numbers. */
export function collectQuadGroupParticipants(
  input: Pick<CreateQuadGroupInput, "student" | "teacher" | "parent">
): Omit<QuadGroupRoster, "groupName"> {
  const wanted: { role: QuadGroupRole; phone: string | undefined }[] = [
    { role: "STUDENT", phone: input.student.phone },
    { role: "TEACHER", phone: input.teacher.phone },
    { role: "PARENT", phone: input.parent?.phone },
    { role: "ADMIN", phone: process.env.WHATSAPP_ADMIN_PHONE },
  ];

  const participants: QuadGroupParticipant[] = [];
  const droppedRoles: QuadGroupRole[] = [];
  for (const { role, phone } of wanted) {
    let chatId: string;
    try {
      chatId = normalizeToWhatsAppJid(phone?.trim() ?? "");
    } catch {
      droppedRoles.push(role);
      continue;
    }
    if (participants.some((p) => p.chatId === chatId)) {
      droppedRoles.push(role);
      continue;
    }
    participants.push({ role, chatId });
  }
  return { participants, droppedRoles };
}

/** Day name, `DD.MM.YYYY` and `HH:MM-HH:MM` in Israel time. */
export function formatQuadLessonWindow(
  scheduledAt: Date,
  durationMinutes: number
): { dayName: string; date: string; timeRange: string } {
  const minutes =
    Number.isFinite(durationMinutes) && durationMinutes > 0
      ? durationMinutes
      : DEFAULT_MAPPING_LESSON_MINUTES;
  const format = (date: Date) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jerusalem",
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    return {
      weekday: get("weekday"),
      date: `${get("day")}.${get("month")}.${get("year")}`,
      time: `${get("hour")}:${get("minute")}`,
    };
  };

  const start = format(scheduledAt);
  const end = format(new Date(scheduledAt.getTime() + minutes * 60 * 1000));
  return {
    dayName: HEBREW_WEEKDAYS[start.weekday] ?? start.weekday,
    date: start.date,
    timeRange: `${start.time}-${end.time}`,
  };
}

export function buildQuadWelcomeMessage(input: {
  studentName: string;
  teacherName: string;
  scheduledAt: Date;
  durationMinutes: number;
  questionnaireUrl: string;
}): string {
  const { dayName, date, timeRange } = formatQuadLessonWindow(
    input.scheduledAt,
    input.durationMinutes
  );
  return (
    `היי ${input.studentName.trim()}, ברוך הבא ל-${BRAND_NAME} ובהצלחה! 🎉\n` +
    `ביום ${dayName} ${date} יתקיים שיעור המיפוי שלך בשעה ${timeRange}\n` +
    `עד אז מוזמן לענות על השאלון המצורף:\n` +
    `${input.questionnaireUrl}\n\n` +
    `נשמח לקבל כאן את הלו״ז השבועי שלך - חוגים, אימונים וזמנים פנויים, ובנוסף צילום של המבחן האחרון על מנת שנוכל לעבור עליו לפני המיפוי.\n\n` +
    `📌 חלוקת פעילות בקבוצה:\n` +
    `- ${input.teacherName.trim()} ילווה אותך במעטפת הלימודית ובכל הקשור לחומר המקצועי (המורה ישלח כאן בהמשך סרטון היכרות אישי).\n` +
    `- צוות המערכת זמין כאן לכל נושאי לו״ז, שינויים, תשלומים ובירוקרטיה.`
  );
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "object" && value !== null) {
      const serialized = (value as Record<string, unknown>)._serialized;
      if (typeof serialized === "string" && serialized.trim()) return serialized.trim();
    }
  }
  return null;
}

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Opens the quad group on the gateway (`POST {WHATSAPP_API_URL}/createGroup`
 * with `{ groupName, chatIds }`) and posts the welcome message into it.
 * Never throws: every failure comes back as a structured `{ ok: false, error }`,
 * and a failed welcome send is reported on an otherwise successful result.
 */
export async function createWhatsAppQuadGroup(
  input: CreateQuadGroupInput
): Promise<CreateQuadGroupResult> {
  const groupName = buildQuadGroupName(input.student.name, input.lesson.subject);
  const roster = collectQuadGroupParticipants(input);
  const fail = (error: QuadGroupError): CreateQuadGroupResult => ({
    ok: false,
    error,
    groupName,
    ...roster,
  });

  if (input.existingGroupId?.trim()) {
    return fail({
      code: "ALREADY_EXISTS",
      message: "The student already has a quad group; send updates to it instead",
    });
  }

  const roles = new Set(roster.participants.map((p) => p.role));
  if (!roles.has("STUDENT") || !roles.has("TEACHER")) {
    return fail({
      code: "MISSING_REQUIRED_PARTICIPANT",
      message: "A quad group needs a valid, distinct student and teacher phone",
    });
  }

  const config = getWhatsAppConfig();
  if (!config) {
    return fail({
      code: "NOT_CONFIGURED",
      message: "WHATSAPP_API_URL / WHATSAPP_API_KEY are not set",
    });
  }

  let response: Response;
  try {
    response = await fetch(`${config.apiUrl}/createGroup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        groupName,
        chatIds: roster.participants.map((p) => p.chatId),
      }),
      signal: AbortSignal.timeout(QUAD_GATEWAY_TIMEOUT_MS),
    });
  } catch (error) {
    if (isAbortLike(error)) {
      return fail({
        code: "TIMEOUT",
        message: `WhatsApp createGroup did not respond within ${QUAD_GATEWAY_TIMEOUT_MS} ms`,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail({ code: "NETWORK", message: `WhatsApp createGroup request failed: ${message}` });
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    return fail({
      code: "GATEWAY_ERROR",
      status: response.status,
      message: `WhatsApp createGroup failed (${response.status}): ${detail || response.statusText}`,
    });
  }

  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (record.created === false) {
    return fail({
      code: "GATEWAY_ERROR",
      status: response.status,
      message: "WhatsApp gateway reported the group was not created",
    });
  }
  const chatId = stringField(record, ["chatId", "groupId", "gid", "id"]);
  if (!chatId?.endsWith("@g.us")) {
    return fail({
      code: "INVALID_RESPONSE",
      message: "WhatsApp createGroup response has no group chat id (…@g.us)",
    });
  }
  const inviteUrl = stringField(record, ["groupInviteLink", "inviteLink", "inviteUrl", "invite_link"]);

  const welcomeText = buildQuadWelcomeMessage({
    studentName: input.student.name,
    teacherName: input.teacher.name,
    scheduledAt: input.lesson.scheduledAt,
    durationMinutes: input.lesson.durationMinutes,
    questionnaireUrl: input.questionnaireUrl?.trim() || buildDiagnosticQuestionnaireUrl(),
  });

  let welcome: QuadWelcomeStatus;
  try {
    const sent = await sendWhatsAppMessage(chatId, welcomeText, {
      timeoutMs: QUAD_GATEWAY_TIMEOUT_MS,
    });
    welcome = sent.mocked
      ? { sent: false, error: "WhatsApp gateway is not configured" }
      : { sent: true, messageId: sent.messageId };
  } catch (error) {
    welcome = { sent: false, error: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, chatId, inviteUrl, welcome, groupName, ...roster };
}

/** Diagnostic questionnaire linked from the quad welcome message. */
export function buildDiagnosticQuestionnaireUrl(): string {
  return `${getAppUrl()}/onboarding/diagnostic`;
}

export type QuadLessonUpdateInput = {
  studentName: string;
  teacherName: string;
  subject: string;
  scheduledAt: Date;
  durationMinutes: number;
  lessonType: "MAPPING" | "REGULAR";
};

/** Posted to an already-open quad group when another lesson is scheduled. */
export function buildQuadLessonUpdateMessage(input: QuadLessonUpdateInput): string {
  const { dayName, date, timeRange } = formatQuadLessonWindow(
    input.scheduledAt,
    input.durationMinutes
  );
  const lessonLabel = input.lessonType === "MAPPING" ? "שיעור מיפוי" : `שיעור ${input.subject.trim()}`;
  return (
    `היי ${input.studentName.trim()}, נקבע ${lessonLabel} חדש.\n` +
    `ביום ${dayName} ${date} בשעה ${timeRange} עם ${input.teacherName.trim()}.\n` +
    (input.lessonType === "MAPPING" ? `מקצוע: ${input.subject.trim()}\n` : "") +
    `אם צריך לשנות את המועד, כתבו לנו כאן.\n\n` +
    `${BRAND_SIGNATURE}`
  );
}

/** Sends the lesson update into an existing group (`…@g.us`). Never throws. */
export async function sendQuadGroupLessonUpdate(
  groupChatId: string,
  input: QuadLessonUpdateInput
): Promise<QuadWelcomeStatus> {
  if (!groupChatId.trim().endsWith("@g.us")) {
    return { sent: false, error: "Not a WhatsApp group chat id (…@g.us)" };
  }
  try {
    const sent = await sendWhatsAppMessage(groupChatId.trim(), buildQuadLessonUpdateMessage(input), {
      timeoutMs: QUAD_GATEWAY_TIMEOUT_MS,
    });
    return sent.mocked
      ? { sent: false, error: "WhatsApp gateway is not configured" }
      : { sent: true, messageId: sent.messageId };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
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
// ・ For TRIO/MULTI it shares an already-open Quad WhatsApp group with the
//    parent; the group itself is opened by dispatch-channel once a teacher and
//    a first lesson exist. SINGLE stays transactional-only.
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

  // The live quad group needs a real teacher and a scheduled first lesson, which
  // the diagnostic funnel does not have yet: it is opened later by
  // /api/whatsapp/dispatch-channel. Here only an existing group is shared.
  const isGroupOpened = false;
  const quadGroupUrl: string | null = whatsappGroupUrl ?? null;
  let dispatchError: string | undefined;

  try {
    if (quadGroupUrl) {
      // Prefer the parent (Quad ecosystem), then the student, then the generic recipient.
      const targetPhone = parentPhone || studentPhone || recipientPhone;
      const inviteName = recipientName || studentName;
      await sendQuadGroupInvite({
        recipientPhone: targetPhone,
        recipientName: inviteName,
        studentName,
        teacherName: teacherName || "המורה שלך",
        groupUrl: quadGroupUrl,
      });
    }
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


