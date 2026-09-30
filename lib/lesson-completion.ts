/**
 * Client-safe rules for closing a lesson from the meetings tab: attendance outcome, teacher compensation,
 * direct-package credit and the management override for reschedules inside the 24 h window.
 */

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

export type CompleteLessonInput = { attendanceStatus: AttendanceOutcome; internalNotes: string | null };

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
  return { ok: true, data: { attendanceStatus, internalNotes } };
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
};
