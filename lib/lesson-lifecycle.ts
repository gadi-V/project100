/**
 * Client-safe parsers and types for the staff lesson lifecycle on the meetings tab:
 * scheduling a pending private lesson, rescheduling and cancelling a scheduled lesson.
 */

/** Reschedule policy (`02-matching-scheduling`): more than 24 h before the start, once per lesson. */
export const RESCHEDULE_MIN_NOTICE_MS = 24 * 60 * 60 * 1000;
export const MAX_RESCHEDULES = 1;
export const REASON_MAX = 500;

export type RescheduleBlock = "WITHIN_24H" | "ALREADY_RESCHEDULED";

export const RESCHEDULE_BLOCK_LABELS: Record<RescheduleBlock, string> = {
  WITHIN_24H: "אפשר לשנות מועד רק עד 24 שעות לפני השיעור",
  ALREADY_RESCHEDULED: "המועד של השיעור הזה כבר שונה פעם אחת",
};

export function rescheduleBlock(
  lesson: { scheduledAt: Date; rescheduledCount: number },
  now: Date
): RescheduleBlock | null {
  if (lesson.rescheduledCount >= MAX_RESCHEDULES) return "ALREADY_RESCHEDULED";
  if (lesson.scheduledAt.getTime() - now.getTime() <= RESCHEDULE_MIN_NOTICE_MS) return "WITHIN_24H";
  return null;
}

export const QUARTER_HOUR_TIME_OPTIONS: string[] = Array.from({ length: (22 - 8) * 4 + 1 }, (_, i) => {
  const minutes = 8 * 60 + i * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

const israelClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** HH:MM of `at` in Israel time. */
export function israelTimeKey(at: Date): string {
  return israelClock.format(at);
}

type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function futureDate(value: unknown, now: Date, errors: string[]): Date | null {
  const date = typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    errors.push("תאריך ושעה לא תקינים");
    return null;
  }
  if (date <= now) {
    errors.push("המועד צריך להיות בעתיד");
    return null;
  }
  return date;
}

function reasonText(value: unknown, label: string, required: boolean, errors: string[]): string | null {
  if (value == null || value === "") {
    if (required) errors.push(`יש לציין ${label}`);
    return null;
  }
  if (typeof value !== "string") {
    errors.push(`${label}: ערך לא תקין`);
    return null;
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (!text && required) errors.push(`יש לציין ${label}`);
  if (text.length > REASON_MAX) errors.push(`${label}: עד ${REASON_MAX} תווים`);
  return text || null;
}

export type SchedulePendingInput = { lessonId: string; teacherId: string; scheduledAt: Date };

/** Body of `POST /api/portal/students/[id]/meetings/pending-schedule`. */
export function parseSchedulePendingInput(value: unknown, now: Date = new Date()): ParseResult<SchedulePendingInput> {
  const record = asRecord(value);
  if (!record) return { ok: false, errors: ["גוף הבקשה חסר"] };
  const errors: string[] = [];
  const lessonId = typeof record.lessonId === "string" ? record.lessonId.trim() : "";
  if (!lessonId) errors.push("חסר מזהה שיעור");
  const teacherId = typeof record.teacherId === "string" ? record.teacherId.trim() : "";
  if (!teacherId) errors.push("יש לבחור מורה");
  const scheduledAt = futureDate(record.scheduledAt, now, errors);
  if (errors.length > 0 || !scheduledAt) return { ok: false, errors };
  return { ok: true, data: { lessonId, teacherId, scheduledAt } };
}

export type RescheduleInput = { newScheduledAt: Date; reason: string | null; allowEmergencyOverride: boolean };

/** Body of `PATCH /api/portal/students/[id]/meetings/[meetingId]`. */
export function parseRescheduleInput(value: unknown, now: Date = new Date()): ParseResult<RescheduleInput> {
  const record = asRecord(value);
  if (!record) return { ok: false, errors: ["גוף הבקשה חסר"] };
  const errors: string[] = [];
  const newScheduledAt = futureDate(record.newScheduledAt, now, errors);
  const reason = reasonText(record.reason, "סיבת הדחייה", false, errors);
  const allowEmergencyOverride = record.allowEmergencyOverride ?? false;
  if (typeof allowEmergencyOverride !== "boolean") errors.push("אישור שינוי חריג: ערך לא תקין");
  if (errors.length > 0 || !newScheduledAt) return { ok: false, errors };
  return { ok: true, data: { newScheduledAt, reason, allowEmergencyOverride: allowEmergencyOverride as boolean } };
}

/** Amber warning in the reschedule modal when management may override the policy. */
export const EMERGENCY_OVERRIDE_WARNINGS: Record<RescheduleBlock, string> = {
  WITHIN_24H: "שיעור זה מתקיים בטווח של פחות מ-24 שעות. כהנהלה, הינך רשאי לבצע שינוי חירום",
  ALREADY_RESCHEDULED: "המועד של שיעור זה כבר שונה פעם אחת. כהנהלה, הינך רשאי לבצע שינוי חירום",
};

export const EMERGENCY_OVERRIDE_MANAGEMENT_ONLY = "שינוי מועד חריג מותר רק למנהל/ת פדגוגי/ת או לאדמין";

export type CancelInput = { cancellationReason: string; restoreCredit: boolean };

/** Body of `DELETE /api/portal/students/[id]/meetings/[meetingId]`. */
export function parseCancelInput(value: unknown): ParseResult<CancelInput> {
  const record = asRecord(value);
  if (!record) return { ok: false, errors: ["גוף הבקשה חסר"] };
  const errors: string[] = [];
  const cancellationReason = reasonText(record.cancellationReason, "סיבת הביטול", true, errors);
  const restoreCredit = record.restoreCredit ?? false;
  if (typeof restoreCredit !== "boolean") errors.push("החזרת קרדיט: ערך לא תקין");
  if (errors.length > 0 || !cancellationReason) return { ok: false, errors };
  return { ok: true, data: { cancellationReason, restoreCredit: restoreCredit as boolean } };
}

export type SchedulePendingResult = {
  lessonId: string;
  scheduledAt: string;
  teacherName: string;
};

export type RescheduleResult = {
  lessonId: string;
  scheduledAt: string;
  previousScheduledAt: string;
  /** Moved inside the 24 h window or a second time, approved by management. */
  emergencyOverride: boolean;
};

export type CancelResult = {
  lessonId: string;
  status: "CANCELLED";
  creditRestored: boolean;
  /** Balance after the restore; null when no credit was restored. */
  lessonCredits: number | null;
};

/** Lifecycle endpoints answer `{ success, data, whatsappDispatched }`. */
export type LifecycleResponse<T> = { success: boolean; data?: T; whatsappDispatched?: boolean; error?: string };
