import type { CommunicationAuthorRole, CommunicationType } from "./communication-templates";

/** Client-safe types and parsers for the staff student screen (`/portal/students/[id]`). */

export const STUDENT_TABS = [
  { key: "profile", label: "פרופיל" },
  { key: "courses", label: "קורסים" },
  { key: "meetings", label: "מפגשים" },
  { key: "communication", label: "תקשורת" },
  { key: "standing-orders", label: "הוראות קבע" },
] as const;

export type StudentTabKey = (typeof STUDENT_TABS)[number]["key"];

export function isStudentTabKey(value: unknown): value is StudentTabKey {
  return typeof value === "string" && STUDENT_TABS.some((tab) => tab.key === value);
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
] as const;

export type StudentStatusCode = (typeof STUDENT_STATUS_OPTIONS)[number]["code"];

const STATUS_CODES = new Set<string>(STUDENT_STATUS_OPTIONS.map((option) => option.code));

export type AttendanceStatus = "PRESENT" | "ABSENT";
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
};

export type StudentPortalViewer = {
  id: string;
  role: string;
  /** Profile fields and status checkboxes (REPRESENTATIVE / ADMIN / MANAGER). */
  canEditProfile: boolean;
  /** Invoice details and the standing-order tab (REPRESENTATIVE / ADMIN / MANAGER). */
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

export type MeetingRow = {
  id: string;
  scheduledAt: string;
  endsAt: string;
  title: string;
  teacherName: string | null;
  status: string;
  attendanceStatus: AttendanceStatus | null;
  canMarkAttendance: boolean;
};

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
  meetings: MeetingRow[];
  communication: CommunicationEntry[];
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
