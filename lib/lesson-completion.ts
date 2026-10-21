/**
 * Client-safe rules for closing a lesson from the meetings tab: attendance outcome, teacher compensation,
 * direct-package credit, the structured lesson / mapping summary, and the management override for
 * reschedules inside the 24 h window.
 */

import {
  getCommunicationTemplate,
  renderStructuredSummary,
  type CommunicationStructuredData,
  type RankedTopic,
  type StructuredValue,
  type TemplateField,
} from "./communication-templates";

export const ATTENDANCE_OUTCOMES = ["ATTENDED", "STUDENT_NO_SHOW", "TEACHER_CANCELLED"] as const;
export type AttendanceOutcome = (typeof ATTENDANCE_OUTCOMES)[number];

export const ATTENDANCE_OUTCOME_LABELS: Record<AttendanceOutcome, string> = {
  ATTENDED: "השיעור התקיים בהצלחה",
  STUDENT_NO_SHOW: "התלמיד לא הופיע לשיעור",
  TEACHER_CANCELLED: "ביטול ביוזמת המורה",
};

export const INTERNAL_NOTES_MAX = 1000;

/** Lessons that can still be closed; the start time must also have arrived. */
export const COMPLETABLE_STATUSES: readonly string[] = ["SCHEDULED", "IN_PROGRESS"];

/** MANAGER (pedagogic manager) and ADMIN may close any lesson and override the reschedule policy. */
export const LESSON_MANAGEMENT_ROLES: readonly string[] = ["MANAGER", "ADMIN"];

export function isLessonManagementRole(role: string): boolean {
  return LESSON_MANAGEMENT_ROLES.includes(role);
}

/** The lesson's teacher, MANAGER or ADMIN, once the lesson has started and while it is still open. */
export function canCompleteLesson(
  viewer: { id: string; role: string },
  lesson: { status: string; teacherId: string; startsAt: Date },
  now: Date
): boolean {
  if (!COMPLETABLE_STATUSES.includes(lesson.status) || lesson.startsAt > now) return false;
  return isLessonManagementRole(viewer.role) || (viewer.role === "TEACHER" && lesson.teacherId === viewer.id);
}

/** Lesson room header: the assigned teacher, MANAGER or ADMIN while the lesson is still open. */
export function canCompleteFromRoom(
  user: { id: string; role: string },
  lesson: { status: string; teacherId: string }
): boolean {
  if (!COMPLETABLE_STATUSES.includes(lesson.status)) return false;
  return isLessonManagementRole(user.role) || (user.role === "TEACHER" && lesson.teacherId === user.id);
}

/**
 * Gross value of one lesson hour and the platform share, as in `/api/lessons/complete`
 * (200 ₪, 30% platform fee, so the teacher's hourly rate is 140 ₪).
 */
export const LESSON_VALUE_PER_HOUR_ILS = 200;
export const PLATFORM_FEE_PERCENT = 0.3;
export const TEACHER_HOURLY_RATE_ILS = Math.round(LESSON_VALUE_PER_HOUR_ILS * (1 - PLATFORM_FEE_PERCENT));

export type TeacherCompensation = {
  /** Hours billed: a lesson occupies at least one 60-minute calendar block (50 min + 10 min break). */
  billedHours: number;
  lessonValue: number;
  platformFee: number;
  teacherPayout: number;
};

export function teacherCompensation(durationMinutes: number | null): TeacherCompensation {
  const billedHours = Math.max(durationMinutes ?? 60, 60) / 60;
  const lessonValue = Math.round(LESSON_VALUE_PER_HOUR_ILS * billedHours);
  const platformFee = Math.round(lessonValue * PLATFORM_FEE_PERCENT);
  return { billedHours, lessonValue, platformFee, teacherPayout: lessonValue - platformFee };
}

/** Same key as `/api/lessons/complete`, so one lesson can never be paid twice across both routes. */
export function lessonPayoutKey(lessonId: string): string {
  return `lesson-payout-${lessonId}`;
}

export type OutcomeEffects = {
  status: "COMPLETED" | "CANCELLED";
  /** `Lesson.attendanceStatus` (PRESENT | ABSENT); null leaves it untouched. */
  attendance: "PRESENT" | "ABSENT" | null;
  compensateTeacher: boolean;
  /** The lesson is consumed from the student's balance. */
  consumesCredit: boolean;
  promptSummary: boolean;
};

export function outcomeEffects(outcome: AttendanceOutcome): OutcomeEffects {
  switch (outcome) {
    case "ATTENDED":
      return { status: "COMPLETED", attendance: "PRESENT", compensateTeacher: true, consumesCredit: true, promptSummary: true };
    case "STUDENT_NO_SHOW":
      return { status: "COMPLETED", attendance: "ABSENT", compensateTeacher: true, consumesCredit: true, promptSummary: false };
    case "TEACHER_CANCELLED":
      return { status: "CANCELLED", attendance: null, compensateTeacher: false, consumesCredit: false, promptSummary: false };
  }
}

/**
 * Only the student self-booking flow (`POST /api/lessons`) takes the credit when the lesson is booked, and it
 * creates the lesson without a title. Lessons scheduled from the staff portal always carry the subject as the
 * title and are charged when they are completed.
 */
export function creditTakenAtBooking(lesson: { title: string | null }): boolean {
  return lesson.title === null;
}

type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

/** Lesson close writes one of these two templates. GENERAL attendance notes stay a separate log. */
export type LessonSummaryData = {
  template: "LESSON_SUMMARY" | "MAPPING_SUMMARY";
  fields: CommunicationStructuredData["fields"];
};

export type CompleteLessonInput = {
  attendanceStatus: AttendanceOutcome;
  internalNotes: string | null;
  /** Stored board PDF. Omitted when the room did not produce an http(s) URL. */
  boardPdfUrl?: string;
  /** Present only for an attended lesson, after the structured summary passed validation. */
  summaryData?: LessonSummaryData;
};

const SUMMARY_TEXT_MAX = 2000;

function normalizeChoice(value: string): string {
  return value.replace(/[״"]/g, '"').replace(/[׳']/g, "'").replace(/\s+/g, " ").trim();
}

function textField(value: unknown, label: string, required: boolean, errors: string[]): string | null {
  if (value == null || value === "") {
    if (required) errors.push(`חסר: ${label}`);
    return null;
  }
  if (typeof value !== "string") {
    errors.push(`${label}: ערך לא תקין`);
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) errors.push(`חסר: ${label}`);
    return null;
  }
  if (trimmed.length > SUMMARY_TEXT_MAX) errors.push(`${label}: עד ${SUMMARY_TEXT_MAX} תווים`);
  return trimmed;
}

function choiceField(value: unknown, field: TemplateField, errors: string[]): string | null {
  if (value == null || value === "") {
    if (field.required) errors.push(`חסר: ${field.label}`);
    return null;
  }
  if (typeof value !== "string") {
    errors.push(`${field.label}: ערך לא תקין`);
    return null;
  }
  const option = field.options?.find((item) => normalizeChoice(item) === normalizeChoice(value));
  if (!option) {
    errors.push(`${field.label}: בחרו אחת מהאפשרויות ${field.options?.join(" / ")}`);
    return null;
  }
  return option;
}

function scoreField(value: unknown, label: string, errors: string[]): number | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const score = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    errors.push(`${label}: ציון בין 0 ל-100`);
    return null;
  }
  return score;
}

function topicField(value: unknown, field: TemplateField, errors: string[]): RankedTopic[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${field.label}: ערך לא תקין`);
    return [];
  }
  const max = field.listSize ?? 4;
  if (value.length > max) errors.push(`${field.label}: עד ${max} נושאים`);
  const topics: RankedTopic[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${field.label}: ערך לא תקין`);
      continue;
    }
    const record = item as Record<string, unknown>;
    const topic = typeof record.topic === "string" ? record.topic.trim() : "";
    const blankScore = record.score == null || (typeof record.score === "string" && record.score.trim() === "");
    if (!topic && blankScore) continue;
    if (!topic) {
      errors.push(`${field.label}: ציון בלי נושא`);
      continue;
    }
    let score: number | null = null;
    if (!blankScore) {
      score = scoreField(record.score, field.label, errors);
      if (score == null && errors.length > 0) continue;
    }
    if (topic.length > SUMMARY_TEXT_MAX) {
      errors.push(`${field.label}: עד ${SUMMARY_TEXT_MAX} תווים`);
      continue;
    }
    topics.push({ rank: topics.length + 1, topic, score });
  }
  return topics;
}

/**
 * Validates the structured summary posted with an attended lesson.
 * Regular lessons require "עבדנו על". Mapping lessons require grade, goal, format fit and subscription.
 */
export function parseLessonSummaryPayload(value: unknown): ParseResult<LessonSummaryData> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["סיכום השיעור חסר"] };
  }
  const record = value as Record<string, unknown>;
  const template = record.template;
  if (template !== "LESSON_SUMMARY" && template !== "MAPPING_SUMMARY") {
    return { ok: false, errors: ["סוג הסיכום אינו מוכר"] };
  }
  const spec = getCommunicationTemplate(template);
  const rawFields = record.fields;
  if (!spec || !rawFields || typeof rawFields !== "object" || Array.isArray(rawFields)) {
    return { ok: false, errors: ["שדות הסיכום חסרים"] };
  }
  const source = rawFields as Record<string, unknown>;
  const errors: string[] = [];
  const fields: Record<string, StructuredValue> = {};
  for (const field of spec.fields) {
    const raw = source[field.key];
    if (field.kind === "list") fields[field.key] = topicField(raw, field, errors);
    else if (field.kind === "choice") fields[field.key] = choiceField(raw, field, errors);
    else if (field.kind === "score") fields[field.key] = scoreField(raw, field.label, errors);
    else fields[field.key] = textField(raw, field.label, Boolean(field.required), errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { template, fields } };
}

/** Full Hebrew summary stored on `StudentCommunicationLog.content`. */
export function formatSummaryText(template: LessonSummaryData["template"], fields: LessonSummaryData["fields"]): string {
  return renderStructuredSummary({ template, fields });
}

const STUDENT_HIDDEN_LESSON_FIELDS = ["pedagogicalBrief", "content", "structuredData", "internalNotes"] as const;

/**
 * Student dashboard / lesson list payload. Keeps the board PDF and drops teacher notes and
 * anything that belongs on `StudentCommunicationLog`.
 */
export function lessonVisibleToStudent<T extends object>(lesson: T): T {
  const visible = { ...lesson } as T & Record<string, unknown>;
  for (const key of STUDENT_HIDDEN_LESSON_FIELDS) delete visible[key];
  return visible;
}

function readBoardPdfUrl(record: Record<string, unknown>): string | null {
  for (const key of ["boardPdfUrl", "boardUrl", "excalidrawPdfUrl", "pdfUrl"] as const) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  }
  return null;
}

function isAttendanceOutcome(value: unknown): value is AttendanceOutcome {
  return typeof value === "string" && (ATTENDANCE_OUTCOMES as readonly string[]).includes(value);
}

/** Body of `POST /api/portal/students/[id]/meetings/[meetingId]/complete`. */
export function parseCompleteLessonInput(value: unknown): ParseResult<CompleteLessonInput> {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!record) return { ok: false, errors: ["גוף הבקשה חסר"] };
  const errors: string[] = [];
  const attendanceStatus = record.attendanceStatus;
  if (!isAttendanceOutcome(attendanceStatus)) errors.push("יש לבחור את מצב הנוכחות בשיעור");

  let internalNotes: string | null = null;
  if (record.internalNotes != null && record.internalNotes !== "") {
    if (typeof record.internalNotes !== "string") {
      errors.push("הערות פנימיות: ערך לא תקין");
    } else {
      internalNotes = record.internalNotes.trim() || null;
      if (internalNotes && internalNotes.length > INTERNAL_NOTES_MAX) {
        errors.push(`הערות פנימיות: עד ${INTERNAL_NOTES_MAX} תווים`);
      }
    }
  }
  if (errors.length > 0 || !isAttendanceOutcome(attendanceStatus)) return { ok: false, errors };

  let summaryData: LessonSummaryData | undefined;
  if (attendanceStatus === "ATTENDED" && record.summaryData != null) {
    const parsedSummary = parseLessonSummaryPayload(record.summaryData);
    if (!parsedSummary.ok) return { ok: false, errors: parsedSummary.errors };
    summaryData = parsedSummary.data;
  }

  const boardPdfUrl = readBoardPdfUrl(record);
  return {
    ok: true,
    data: {
      attendanceStatus,
      internalNotes,
      ...(boardPdfUrl ? { boardPdfUrl } : {}),
      ...(summaryData ? { summaryData } : {}),
    },
  };
}

/** `POST …/complete` answers these fields at the top level. */
export type CompleteLessonResponse = {
  success: boolean;
  error?: string;
  lessonId?: string;
  status?: "COMPLETED" | "CANCELLED";
  attendanceStatus?: AttendanceOutcome;
  teacherCompensated?: boolean;
  /** Teacher payout in ILS; null when the teacher is not paid. */
  compensationAmount?: number | null;
  /** One lesson was taken from the direct-package balance now. */
  creditCharged?: boolean;
  /** The credit taken at booking went back to the student (teacher cancelled). */
  creditRestored?: boolean;
  /** Balance after a credit change; null when the balance did not change. */
  lessonCredits?: number | null;
  /** Open the lesson summary form on the communication tab. */
  promptSummary?: boolean;
  /** No-show only: "חיסור לא מוצדק" was added to the student's CRM card. */
  absenceFlagged?: boolean;
  /** The quad-group notice was delivered (no-show alert, or the lesson summary with the board link). */
  whatsappDispatched?: boolean;
};

export function completeLessonEndpoint(studentId: string, lessonId: string): string {
  return `/api/portal/students/${encodeURIComponent(studentId)}/meetings/${encodeURIComponent(lessonId)}/complete`;
}

/** Posts the attendance report; resolves with the API answer or throws with the Hebrew error. */
export async function submitLessonCompletion(
  params: {
    studentId: string;
    lessonId: string;
    attendanceStatus: AttendanceOutcome;
    internalNotes: string | null;
    boardPdfUrl?: string | null;
    summaryData?: LessonSummaryData;
  },
  fetchImpl: typeof fetch = fetch
): Promise<CompleteLessonResponse> {
  const body: {
    attendanceStatus: AttendanceOutcome;
    internalNotes: string | null;
    boardPdfUrl?: string;
    summaryData?: LessonSummaryData;
  } = {
    attendanceStatus: params.attendanceStatus,
    internalNotes: params.internalNotes,
  };
  const boardPdfUrl = params.boardPdfUrl?.trim();
  if (boardPdfUrl && (boardPdfUrl.startsWith("http://") || boardPdfUrl.startsWith("https://"))) {
    body.boardPdfUrl = boardPdfUrl;
  }
  if (params.attendanceStatus === "ATTENDED" && params.summaryData) {
    body.summaryData = params.summaryData;
  }
  const res = await fetchImpl(completeLessonEndpoint(params.studentId, params.lessonId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({ success: false }))) as CompleteLessonResponse;
  if (!res.ok || !json.success) throw new Error(json.error ?? "סיום השיעור נכשל");
  return json;
}

/**
 * Where the lesson room sends the teacher after closing the lesson: the summary form on the communication tab
 * for an attended lesson, otherwise the meetings tab.
 */
export function portalAfterCompletionHref(studentId: string, lessonId: string, result: CompleteLessonResponse): string {
  const base = `/portal/students/${encodeURIComponent(studentId)}`;
  if (!result.promptSummary) return `${base}?tab=meetings`;
  return `${base}?tab=communication&autoPromptSummary=true&lessonId=${encodeURIComponent(lessonId)}`;
}
