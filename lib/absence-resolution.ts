import type { Role } from "@prisma/client";
import { formatIsraelDateTime } from "./student-portal-shared";

/** Client-safe rules for following up an unexcused absence (`POST /api/portal/students/[id]/resolve-absence`). */

/** MANAGER is the pedagogic manager. Teachers and students may not close an absence. */
export const ABSENCE_RESOLUTION_ROLES: Role[] = ["MANAGER", "ADMIN", "REPRESENTATIVE"];

export const ABSENCE_RESOLUTION_TYPES = ["EXCUSED_MAKEUP", "EXCUSED_NO_MAKEUP", "UNEXCUSED_CLOSED"] as const;
export type AbsenceResolutionType = (typeof ABSENCE_RESOLUTION_TYPES)[number];

export const ABSENCE_RESOLUTION_LABELS: Record<AbsenceResolutionType, string> = {
  EXCUSED_MAKEUP: "חיסור מוצדק, נפתח שיעור השלמה",
  EXCUSED_NO_MAKEUP: "חיסור מוצדק, ללא שיעור השלמה",
  UNEXCUSED_CLOSED: "חיסור לא מוצדק, הטיפול נסגר",
};

export const ABSENCE_REASON_MAX = 500;
export const ABSENCE_NOTES_MAX = 1000;

/** `Lesson.lessonType` of a replacement lesson. It waits in PENDING_SCHEDULE until staff pick a slot. */
export const MAKEUP_LESSON_TYPE = "MAKEUP";
export const MAKEUP_LESSON_LABEL = "שיעור השלמה";
export const ABSENCE_RESOLUTION_CONTEXT = "שיחת בירור חיסור";

const MAKEUP_SUFFIX = ` · ${MAKEUP_LESSON_LABEL}`;

export function isMakeupLesson(lesson: { lessonType?: string | null }): boolean {
  return lesson.lessonType === MAKEUP_LESSON_TYPE;
}

export function makeupLessonTitle(absentTitle: string | null): string {
  const subject = (absentTitle?.trim() || "שיעור פרטי").replace(MAKEUP_SUFFIX, "");
  return `${subject}${MAKEUP_SUFFIX}`;
}

export type ResolveAbsenceInput = {
  reason: string;
  resolutionType: AbsenceResolutionType;
  notes: string | null;
  /** The missed lesson; defaults to the student's latest lesson marked absent. */
  lessonId: string | null;
};

type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function isResolutionType(value: unknown): value is AbsenceResolutionType {
  return typeof value === "string" && (ABSENCE_RESOLUTION_TYPES as readonly string[]).includes(value);
}

export function parseResolveAbsenceInput(value: unknown): ParseResult<ResolveAbsenceInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["גוף הבקשה חסר"] };
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];

  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (!reason) errors.push("יש לפרט את סיבת החיסור");
  else if (reason.length > ABSENCE_REASON_MAX) errors.push(`סיבת החיסור: עד ${ABSENCE_REASON_MAX} תווים`);

  if (!isResolutionType(record.resolutionType)) errors.push("יש לבחור את אופן הטיפול בחיסור");

  let notes: string | null = null;
  if (record.notes !== undefined && record.notes !== null) {
    if (typeof record.notes !== "string") errors.push("הערות: ערך לא תקין");
    else {
      notes = record.notes.trim() || null;
      if (notes && notes.length > ABSENCE_NOTES_MAX) errors.push(`הערות: עד ${ABSENCE_NOTES_MAX} תווים`);
    }
  }

  let lessonId: string | null = null;
  if (record.lessonId !== undefined && record.lessonId !== null) {
    if (typeof record.lessonId !== "string" || !record.lessonId.trim()) errors.push("מזהה שיעור לא תקין");
    else lessonId = record.lessonId.trim();
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { reason, resolutionType: record.resolutionType as AbsenceResolutionType, notes, lessonId } };
}

export function renderAbsenceResolutionContent(params: {
  resolutionType: AbsenceResolutionType;
  reason: string;
  notes: string | null;
  absentLesson: { title: string | null; startsAt: Date } | null;
  makeupLessonCreated: boolean;
}): string {
  const { resolutionType, reason, notes, absentLesson, makeupLessonCreated } = params;
  return [
    ABSENCE_RESOLUTION_CONTEXT,
    ...(absentLesson
      ? [`השיעור שהוחסר: ${absentLesson.title?.trim() || "שיעור פרטי"} (${formatIsraelDateTime(absentLesson.startsAt.toISOString())})`]
      : []),
    `סיבת החיסור: ${reason}`,
    `הכרעה: ${ABSENCE_RESOLUTION_LABELS[resolutionType]}`,
    ...(makeupLessonCreated ? ["נפתח שיעור השלמה שממתין לשיבוץ מועד בלשונית המפגשים"] : []),
    'התגית "חיסור לא מוצדק" הוסרה מהתיק',
    ...(notes ? [`הערות פנימיות: ${notes}`] : []),
  ].join("\n");
}

export type ResolveAbsenceResponse =
  | {
      success: true;
      absenceResolved: true;
      makeupLessonCreated: boolean;
      makeupLessonId: string | null;
      studentStatus: string[];
    }
  | { success: false; error: string };

export function resolveAbsenceEndpoint(studentId: string): string {
  return `/api/portal/students/${encodeURIComponent(studentId)}/resolve-absence`;
}

export type ResolveAbsenceSuccess = Extract<ResolveAbsenceResponse, { success: true }>;

/** Posts the follow-up; throws the API's Hebrew error so the modal can show it. */
export async function submitAbsenceResolution(
  params: { studentId: string } & Omit<ResolveAbsenceInput, "lessonId"> & { lessonId?: string | null },
  fetchImpl: typeof fetch = fetch
): Promise<ResolveAbsenceSuccess> {
  const { studentId, ...payload } = params;
  const res = await fetchImpl(resolveAbsenceEndpoint(studentId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({ success: false, error: "" }))) as ResolveAbsenceResponse;
  if (!res.ok || !json.success) {
    throw new Error((!json.success && json.error) || "שמירת הטיפול בחיסור נכשלה");
  }
  return json;
}
