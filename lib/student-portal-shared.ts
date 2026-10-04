import type { CommunicationAuthorRole, CommunicationType } from "./communication-templates";
import type { EnrollmentPlans } from "./pedagogic-decision";
import type { RescheduleBlock } from "./lesson-lifecycle";

/** Client-safe types and parsers for the staff student screen (`/portal/students/[id]`). */

export const STUDENT_TABS = [
  { key: "profile", label: "סקירה כללית" },
  { key: "meetings", label: "מפגשים" },
  { key: "communication", label: "תקשורת" },
  { key: "courses", label: "קורסים" },
  { key: "billing", label: "כספים" },
] as const;

export type StudentTabKey = (typeof STUDENT_TABS)[number]["key"];

/** Old `?tab=` values of the standing-orders tab, now part of כספים. */
export const LEGACY_BILLING_TAB_KEYS: readonly string[] = ["standing-orders", "subscriptions", "recurring"];

export function isStudentTabKey(value: unknown): value is StudentTabKey {
  return typeof value === "string" && STUDENT_TABS.some((tab) => tab.key === value);
}

export function isLegacyBillingTab(value: unknown): boolean {
  return typeof value === "string" && LEGACY_BILLING_TAB_KEYS.includes(value);
}

export const STUDENT_STATUS_OPTIONS = [
  { code: "STUDENT", label: "תלמיד" },
  { code: "CALL_BACK_PARENT", label: "לחזור להורה" },
  { code: "CALL_BACK_STUDENT", label: "לחזור לתלמיד" },
  { code: "NOT_RELEVANT", label: "לא רלוונטי" },
  { code: "NO_ANSWER", label: "לא עונה בכלל" },
  { code: "SUBSCRIPTION_CANCELLED", label: "ביטול מנוי" },
  { code: "STUCK_160", label: "תקוע 160" },
  { code: "FLOWING_160", label: "זורם 160" },
  { code: "BOILING_160", label: "רותח 160" },
  { code: "MAPPING_FAILED", label: "מיפוי נכשל" },
  { code: "UNEXCUSED_ABSENCE", label: "חיסור לא מוצדק" },
] as const;

export type StudentStatusCode = (typeof STUDENT_STATUS_OPTIONS)[number]["code"];

const STATUS_CODES = new Set<string>(STUDENT_STATUS_OPTIONS.map((option) => option.code));

/** Waiting statuses cleared once the student starts a subscription or a package. */
const WAITING_STATUS_CODES = new Set<string>(["MAPPING_FAILED", "CALL_BACK_PARENT"]);

/** Adds the active "תלמיד" status and drops waiting statuses. Unknown codes are dropped; order follows the options list. */
export function activateStudentStatuses(current: readonly string[]): StudentStatusCode[] {
  const next = new Set(current.filter((code) => STATUS_CODES.has(code) && !WAITING_STATUS_CODES.has(code)));
  next.add("STUDENT");
  return STUDENT_STATUS_OPTIONS.map((o) => o.code).filter((code) => next.has(code));
}

/** Adds the "חיסור לא מוצדק" flag after a no-show, kept until staff clear it on the profile tab. */
export function flagUnexcusedAbsence(current: readonly string[]): StudentStatusCode[] {
  const next = new Set(current.filter((code) => STATUS_CODES.has(code)));
  next.add("UNEXCUSED_ABSENCE");
  return STUDENT_STATUS_OPTIONS.map((o) => o.code).filter((code) => next.has(code));
}

/** Drops the "חיסור לא מוצדק" flag once the absence was followed up; other known codes are kept. */
export function clearUnexcusedAbsence(current: readonly string[]): StudentStatusCode[] {
  const next = new Set(current.filter((code) => STATUS_CODES.has(code) && code !== "UNEXCUSED_ABSENCE"));
  return STUDENT_STATUS_OPTIONS.map((o) => o.code).filter((code) => next.has(code));
}

export function hasOpenAbsence(statuses: readonly string[]): boolean {
  return statuses.includes("UNEXCUSED_ABSENCE");
}

export type AttendanceStatus = "PRESENT" | "ABSENT";

export type AttendanceMetrics = {
  attended: number;
  noShow: number;
  cancelled: number;
  /** attended / (attended + no-show), whole percent; null before any lesson took place. */
  attendanceRate: number | null;
};

const CANCELLED_LESSON_STATUSES = new Set(["CANCELLED", "CANCELLED_LATE"]);

/**
 * Meetings tab summary. A cancelled lesson counts only as cancelled; an absent mark is a no-show;
 * a present mark or a completed lesson without a mark counts as attended. Cancellations stay out of the rate.
 */
export function attendanceMetrics(
  lessons: readonly { status: string; attendanceStatus: AttendanceStatus | null }[]
): AttendanceMetrics {
  let attended = 0;
  let noShow = 0;
  let cancelled = 0;
  for (const lesson of lessons) {
    if (CANCELLED_LESSON_STATUSES.has(lesson.status)) cancelled += 1;
    else if (lesson.attendanceStatus === "ABSENT") noShow += 1;
    else if (lesson.attendanceStatus === "PRESENT" || lesson.status === "COMPLETED") attended += 1;
  }
  const held = attended + noShow;
  return { attended, noShow, cancelled, attendanceRate: held > 0 ? Math.round((attended * 100) / held) : null };
}
export type EnrollmentType = "ONE_TIME" | "SUBSCRIPTION";

export const ENROLLMENT_TYPE_LABELS: Record<EnrollmentType, string> = {
  ONE_TIME: "חד-פעמי",
  SUBSCRIPTION: "מנוי",
};

export const LESSON_STATUS_LABELS: Record<string, string> = {
  SCHEDULED: "מתוכנן",
  IN_PROGRESS: "מתקיים עכשיו",
  COMPLETED: "הסתיים",
  CANCELLED: "בוטל",
  CANCELLED_LATE: "בוטל ברגע האחרון",
  PENDING_SCHEDULE: "ממתין לשיבוץ",
};

export type StudentPortalViewer = {
  id: string;
  role: string;
  /** Profile fields and status checkboxes (REPRESENTATIVE / ADMIN / MANAGER). */
  canEditProfile: boolean;
  /** Invoice details and the כספים tab (REPRESENTATIVE / ADMIN / MANAGER). */
  canViewBilling: boolean;
};

export type StudentHeaderData = {
  id: string;
  name: string;
  createdAt: string;
};

export type StudentProfileFields = {
  firstName: string | null;
  lastName: string | null;
  grade: string | null;
  studyGroup: string | null;
  nationalId: string | null;
  city: string | null;
  /** YYYY-MM-DD */
  birthDate: string | null;
  invoiceName: string | null;
  invoiceTaxId: string | null;
};

export type ProfileTabData = StudentProfileFields & {
  phone: string;
  whatsappUrl: string | null;
  email: string | null;
  schoolName: string | null;
  age: number | null;
  parentName: string | null;
  parentPhone: string | null;
  parentWhatsappUrl: string | null;
  studentStatus: string[];
  statusUpdatedAt: string | null;
};

export type CourseRow = {
  key: string;
  kind: "COURSE" | "MAPPING";
  title: string;
  /** Recurring weekday + hours in Israel time, e.g. "יום ב׳ 17:00–18:00". */
  schedule: string[];
  enrollmentType: EnrollmentType;
  teacherName: string | null;
  nextMeetingAt: string | null;
  upcomingCount: number;
  completedCount: number;
};

export type LessonType = "MAPPING" | "REGULAR";

export const LESSON_TYPE_LABELS: Record<LessonType, string> = {
  MAPPING: "שיעור מיפוי ראשוני",
  REGULAR: "שיעור שוטף",
};

export type MeetingRow = {
  id: string;
  scheduledAt: string;
  endsAt: string;
  title: string;
  teacherName: string | null;
  status: string;
  lessonType: LessonType;
  /** A quad WhatsApp group was opened or notified for this lesson. */
  whatsappLinked: boolean;
  attendanceStatus: AttendanceStatus | null;
  canMarkAttendance: boolean;
  /** The lesson is still open and the viewer may join the video room at `/lessons/[id]`. */
  canEnterRoom: boolean;
  teacherId: string;
  durationMinutes: number;
  /** Staff lifecycle actions (REPRESENTATIVE / ADMIN / MANAGER only; always false for other viewers). */
  canSchedulePending: boolean;
  canReschedule: boolean;
  /** Why a staff viewer may not reschedule this scheduled lesson (null when allowed or not applicable). */
  rescheduleBlock: RescheduleBlock | null;
  /** MANAGER / ADMIN may still move a blocked upcoming lesson as an emergency change. */
  canEmergencyReschedule: boolean;
  canCancel: boolean;
  /** Close the lesson and record attendance: the lesson's teacher, MANAGER or ADMIN, once it has started. */
  canComplete: boolean;
  /** The student's credit was taken when the lesson was booked, so a cancellation may return it. */
  creditTakenAtBooking: boolean;
  /** Replacement for an excused absence (opened from the absence follow-up). */
  isMakeup: boolean;
};

const LESSON_ROOM_OPEN_STATUSES = new Set(["SCHEDULED", "IN_PROGRESS"]);

/** Classroom page (Daily video room + board) of one lesson. */
export function lessonRoomHref(lessonId: string): string {
  return `/lessons/${encodeURIComponent(lessonId)}`;
}

export function isLessonRoomOpen(status: string): boolean {
  return LESSON_ROOM_OPEN_STATUSES.has(status);
}

/**
 * Mirrors the classroom guard (`getAuthorizedLessonById`): the assigned teacher, the student,
 * MANAGER (pedagogic manager) or ADMIN, and only while the lesson is scheduled or in progress.
 */
export function canEnterLessonRoom(
  viewer: { id: string; role: string },
  lesson: { status: string; teacherId: string; studentId?: string | null }
): boolean {
  if (!isLessonRoomOpen(lesson.status)) return false;
  if (viewer.role === "ADMIN" || viewer.role === "MANAGER") return true;
  if (viewer.role === "TEACHER") return lesson.teacherId === viewer.id;
  if (viewer.role === "STUDENT") return Boolean(lesson.studentId) && lesson.studentId === viewer.id;
  return false;
}

export type TeacherOption = { id: string; name: string };

export type ScheduleMeetingInput = {
  teacherId: string;
  subject: string;
  scheduledAt: Date;
  durationMinutes: number;
  lessonType: LessonType;
};

/** How the quad WhatsApp group reacted to a newly scheduled lesson. */
export type MeetingGroupStatus = "OPENED" | "EXISTING" | "FAILED" | "NOT_OPENED";

export type ScheduleMeetingResult = {
  lessonId: string;
  lessonType: LessonType;
  scheduledAt: string;
  durationMinutes: number;
  teacherName: string;
  groupStatus: MeetingGroupStatus;
  whatsappGroupCreated: boolean;
  /** The lesson is tied to a live group (new or existing). */
  whatsappGroupLinked: boolean;
  /** Update message posted into an existing group. */
  groupUpdateSent: boolean;
  whatsappErrorCode: string | null;
};

export const MAPPING_LESSON_MINUTES = 45;
export const REGULAR_LESSON_MINUTES = 50;
export const REGULAR_DURATION_OPTIONS = [45, 50, 60, 90] as const;
export const DEFAULT_MEETING_SUBJECT = "מתמטיקה";
const SUBJECT_MAX = 80;
const MIN_DURATION = 15;
const MAX_DURATION = 180;

export type CommunicationEntry = {
  id: string;
  createdAt: string;
  type: CommunicationType;
  courseContext: string | null;
  authorName: string;
  authorRole: CommunicationAuthorRole;
  content: string;
};

export type StandingOrderStatus = "ACTIVE" | "USED_UP" | "CANCELLED" | "NONE";

export const STANDING_ORDER_STATUS_LABELS: Record<StandingOrderStatus, string> = {
  ACTIVE: "פעיל",
  USED_UP: "החבילה נוצלה",
  CANCELLED: "המנוי בוטל",
  NONE: "אין מנוי",
};

export type CardLookup =
  | { state: "FOUND"; brand: string; last4: string }
  | { state: "NO_STRIPE_PAYMENT" | "NOT_CONFIGURED" | "UNAVAILABLE" };

export type ChargeRow = {
  id: string;
  createdAt: string;
  packageType: string;
  amountPaid: number;
  creditsAdded: number;
  status: string;
};

export type StandingOrderData = {
  status: StandingOrderStatus;
  lessonCredits: number;
  card: CardLookup;
  charges: ChargeRow[];
};

export type StudentPortalData = {
  header: StudentHeaderData;
  viewer: StudentPortalViewer;
  profile: ProfileTabData;
  courses: CourseRow[];
  /** Weekly subscriptions decided by the pedagogic manager and direct hour packages. */
  plans: EnrollmentPlans;
  meetings: MeetingRow[];
  communication: CommunicationEntry[];
  /** The student has a quad WhatsApp group (`User.whatsappGroupId`) that summaries can be posted to. */
  whatsappGroupLinked: boolean;
  /** null when the viewer may not see billing. */
  standingOrders: StandingOrderData | null;
};

const israelDateTime = new Intl.DateTimeFormat("he-IL", {
  timeZone: "Asia/Jerusalem",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const israelDate = new Intl.DateTimeFormat("he-IL", {
  timeZone: "Asia/Jerusalem",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export function formatIsraelDateTime(iso: string): string {
  return israelDateTime.format(new Date(iso));
}

export function formatIsraelDay(iso: string): string {
  return israelDate.format(new Date(iso));
}

export function formatIls(amount: number): string {
  return `₪${amount.toLocaleString("he-IL")}`;
}

/** Whole years between a YYYY-MM-DD birth date and `now`. */
export function ageFromBirthDate(birthDate: string | null, now: Date = new Date()): number | null {
  if (!birthDate) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  let age = now.getUTCFullYear() - year;
  const beforeBirthday =
    now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

export function parseStudentStatuses(value: unknown): ParseResult<StudentStatusCode[]> {
  if (!Array.isArray(value)) return { ok: false, errors: ["רשימת הסטטוסים חייבת להיות מערך"] };
  const unknown = value.filter((code) => typeof code !== "string" || !STATUS_CODES.has(code));
  if (unknown.length > 0) return { ok: false, errors: ["סטטוס לא מוכר"] };
  const unique = Array.from(new Set(value as StudentStatusCode[]));
  const ordered = STUDENT_STATUS_OPTIONS.map((o) => o.code).filter((code) => unique.includes(code));
  return { ok: true, data: ordered };
}

const PROFILE_TEXT_MAX = 120;

export const PROFILE_FIELD_LABELS: Record<keyof StudentProfileFields, string> = {
  firstName: "שם פרטי",
  lastName: "שם משפחה",
  grade: "כיתה",
  studyGroup: "הקבצה",
  nationalId: "ת.ז / ח.פ",
  city: "עיר",
  birthDate: "תאריך לידה",
  invoiceName: "שם מלא לחשבונית",
  invoiceTaxId: "ת.ז / ח.פ לחשבונית",
};

const PROFILE_KEYS = Object.keys(PROFILE_FIELD_LABELS) as (keyof StudentProfileFields)[];
const ID_FIELDS = new Set<keyof StudentProfileFields>(["nationalId", "invoiceTaxId"]);

/** Partial update of the profile fields: only keys present in the body are returned. */
export function parseStudentProfileFields(value: unknown): ParseResult<Partial<StudentProfileFields>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["פרטי הפרופיל חסרים"] };
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  const data: Partial<StudentProfileFields> = {};

  for (const key of PROFILE_KEYS) {
    if (!(key in record)) continue;
    const raw = record[key];
    if (raw !== null && typeof raw !== "string") {
      errors.push(`${PROFILE_FIELD_LABELS[key]}: ערך לא תקין`);
      continue;
    }
    const text = raw?.trim() || null;
    if (text && text.length > PROFILE_TEXT_MAX) {
      errors.push(`${PROFILE_FIELD_LABELS[key]}: עד ${PROFILE_TEXT_MAX} תווים`);
      continue;
    }
    if (text && ID_FIELDS.has(key) && !/^\d{5,9}$/.test(text)) {
      errors.push(`${PROFILE_FIELD_LABELS[key]}: 5 עד 9 ספרות`);
      continue;
    }
    if (text && key === "birthDate") {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
      const date = match ? new Date(`${text}T00:00:00Z`) : null;
      if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
        errors.push(`${PROFILE_FIELD_LABELS[key]}: תאריך לא תקין`);
        continue;
      }
      const year = Number(match?.[1]);
      if (year < 1940 || year > new Date().getUTCFullYear()) {
        errors.push(`${PROFILE_FIELD_LABELS[key]}: תאריך לא תקין`);
        continue;
      }
    }
    data[key] = text;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data };
}

export function parseAttendanceInput(value: unknown): ParseResult<{ lessonId: string; status: AttendanceStatus }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["גוף הבקשה חסר"] };
  }
  const record = value as Record<string, unknown>;
  const lessonId = typeof record.lessonId === "string" ? record.lessonId.trim() : "";
  const status = record.status;
  const errors: string[] = [];
  if (!lessonId) errors.push("חסר מזהה מפגש");
  if (status !== "PRESENT" && status !== "ABSENT") errors.push("סטטוס נוכחות לא תקין");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { lessonId, status: status as AttendanceStatus } };
}

/** Body of `POST /api/portal/students/[id]/meetings`. The date must be in the future. */
export function parseScheduleMeetingInput(value: unknown, now: Date = new Date()): ParseResult<ScheduleMeetingInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["גוף הבקשה חסר"] };
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];

  const lessonType = record.lessonType ?? "MAPPING";
  if (lessonType !== "MAPPING" && lessonType !== "REGULAR") errors.push("סוג שיעור לא תקין");

  const teacherId = typeof record.teacherId === "string" ? record.teacherId.trim() : "";
  if (!teacherId) errors.push("יש לבחור מורה");

  const subject = typeof record.subject === "string" ? record.subject.trim().replace(/\s+/g, " ") : "";
  if (!subject) errors.push("יש לציין מקצוע");
  else if (subject.length > SUBJECT_MAX) errors.push(`מקצוע: עד ${SUBJECT_MAX} תווים`);

  const scheduledAt = typeof record.scheduledAt === "string" ? new Date(record.scheduledAt) : null;
  if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) errors.push("תאריך ושעה לא תקינים");
  else if (scheduledAt <= now) errors.push("המועד צריך להיות בעתיד");

  const defaultDuration = lessonType === "REGULAR" ? REGULAR_LESSON_MINUTES : MAPPING_LESSON_MINUTES;
  const durationMinutes = record.durationMinutes ?? defaultDuration;
  if (
    typeof durationMinutes !== "number" ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes < MIN_DURATION ||
    durationMinutes > MAX_DURATION
  ) {
    errors.push(`משך: ${MIN_DURATION} עד ${MAX_DURATION} דקות`);
  }

  if (errors.length > 0 || !scheduledAt) return { ok: false, errors };
  return {
    ok: true,
    data: {
      teacherId,
      subject,
      scheduledAt,
      durationMinutes: durationMinutes as number,
      lessonType: lessonType as LessonType,
    },
  };
}

const israelParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Jerusalem",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function israelWallClock(at: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = israelParts.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function israelOffsetMs(at: Date): number {
  const wall = israelWallClock(at);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  return wallAsUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/** YYYY-MM-DD of `at` in Israel, shifted by `addDays`. */
export function israelDateKey(at: Date, addDays = 0): string {
  const wall = israelWallClock(at);
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day + addDays)).toISOString().slice(0, 10);
}

/** Israel wall-clock date (YYYY-MM-DD) + time (HH:MM) → UTC ISO string, DST-aware. */
export function israelLocalToIso(date: string, time: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!d || !t) return null;
  const naive = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (new Date(naive).toISOString().slice(0, 10) !== date) return null;
  let instant = naive - israelOffsetMs(new Date(naive));
  const corrected = naive - israelOffsetMs(new Date(instant));
  if (corrected !== instant) instant = corrected;
  const result = new Date(instant);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
}
