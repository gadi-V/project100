import {
  COMMUNICATION_TEMPLATES,
  type CommunicationStructuredData,
  type RankedTopic,
} from "./communication-templates";
import { israelDateKey, israelLocalToIso, type TeacherOption } from "./student-portal-shared";

/**
 * Client-safe types, parsers and generators for the two enrollment tracks on the courses tab:
 * the pedagogic manager's post-mapping decision (weekly subscription) and the direct hours package.
 */

export const WEEKDAY_LABELS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"] as const;

export type SubscriptionType = "WEEKLY" | "TWICE_WEEKLY";

export const SUBSCRIPTION_TYPE_LABELS: Record<SubscriptionType, string> = {
  WEEKLY: "חד שבועי",
  TWICE_WEEKLY: "דו שבועי",
};

export const SLOTS_PER_SUBSCRIPTION: Record<SubscriptionType, number> = { WEEKLY: 1, TWICE_WEEKLY: 2 };

/** The monthly batch covers the next four weeks: 4 lessons (weekly) or 8 (twice weekly). */
export const RECURRING_WEEKS = 4;
export const SUBSCRIPTION_LESSON_MINUTES = 50;
/** Extra private lessons wait for a manual slot; they never reach the weekly board. */
export const PENDING_SCHEDULE_STATUS = "PENDING_SCHEDULE";

export const PARENT_TYPES = ["אדיש", "מעורב", "מתערב"] as const;
export type ParentType = (typeof PARENT_TYPES)[number];

export const EXTRA_PRIVATE_LESSON_OPTIONS = [0, 1, 2] as const;
export type ExtraPrivateLessons = (typeof EXTRA_PRIVATE_LESSON_OPTIONS)[number];

export type WeeklySlot = { weekday: number; time: string };

export const WEEKLY_TIME_OPTIONS: string[] = Array.from({ length: (21 - 8) * 4 + 1 }, (_, i) => {
  const minutes = 8 * 60 + i * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

export type PedagogicDecisionInput = {
  background: string | null;
  personalNotes: string | null;
  learningNotes: string | null;
  mainGoal: string;
  parentType: ParentType;
  subscriptionType: SubscriptionType;
  extraPrivateLessons: ExtraPrivateLessons;
  professionalManagerInvolved: boolean;
  teacherId: string;
  subject: string;
  slots: WeeklySlot[];
  /** YYYY-MM-DD, Israel calendar date. */
  startDate: string;
};

type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

const NOTE_MAX = 1000;
const SUBJECT_MAX = 80;
const MAX_START_DAYS_AHEAD = 180;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function optionalNote(value: unknown, label: string, errors: string[]): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    errors.push(`${label}: ערך לא תקין`);
    return null;
  }
  const text = value.trim();
  if (text.length > NOTE_MAX) errors.push(`${label}: עד ${NOTE_MAX} תווים`);
  return text || null;
}

function parseSlot(value: unknown): WeeklySlot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { weekday, time } = value as Record<string, unknown>;
  if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  if (typeof time !== "string" || !TIME_PATTERN.test(time)) return null;
  return { weekday, time };
}

function weekdayOfDateKey(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function addDaysToKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function isValidDateKey(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Lesson start times for the monthly batch: each weekly slot from its first occurrence on or after
 * `startDate`, repeated for `weeks` weeks. Israel wall-clock → UTC, DST-aware. Sorted ascending.
 */
export function buildRecurringOccurrences(
  slots: WeeklySlot[],
  startDate: string,
  weeks: number = RECURRING_WEEKS
): Date[] {
  const startWeekday = weekdayOfDateKey(startDate);
  const occurrences: Date[] = [];
  for (const slot of slots) {
    const firstKey = addDaysToKey(startDate, (slot.weekday - startWeekday + 7) % 7);
    for (let week = 0; week < weeks; week++) {
      const iso = israelLocalToIso(addDaysToKey(firstKey, week * 7), slot.time);
      if (iso) occurrences.push(new Date(iso));
    }
  }
  return occurrences.sort((a, b) => a.getTime() - b.getTime());
}

export function formatWeeklySlot(slot: WeeklySlot): string {
  return `יום ${WEEKDAY_LABELS[slot.weekday] ?? ""} ${slot.time}`;
}

export function formatWeeklySchedule(slots: WeeklySlot[]): string {
  return [...slots]
    .sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time))
    .map(formatWeeklySlot)
    .join(", ");
}

/** Body of `POST /api/portal/students/[id]/pedagogic-decision`. Every generated lesson must be in the future. */
export function parsePedagogicDecisionInput(
  value: unknown,
  now: Date = new Date()
): ParseResult<PedagogicDecisionInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["גוף הבקשה חסר"] };
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];

  const background = optionalNote(record.background, "רקע", errors);
  const personalNotes = optionalNote(record.personalNotes, "דגשים אישיים", errors);
  const learningNotes = optionalNote(record.learningNotes, "דגשים לימודיים", errors);
  const mainGoal = optionalNote(record.mainGoal, "מטרה מרכזית", errors);
  if (!mainGoal) errors.push("יש לציין מטרה מרכזית");

  const parentType = record.parentType;
  if (typeof parentType !== "string" || !(PARENT_TYPES as readonly string[]).includes(parentType)) {
    errors.push("יש לבחור סוג הורה");
  }

  const subscriptionType = record.subscriptionType;
  const validSubscription = subscriptionType === "WEEKLY" || subscriptionType === "TWICE_WEEKLY";
  if (!validSubscription) errors.push("יש לבחור סוג מנוי");

  const extra = record.extraPrivateLessons ?? 0;
  if (!(EXTRA_PRIVATE_LESSON_OPTIONS as readonly unknown[]).includes(extra)) {
    errors.push("תוספת ש.פ: אין, 1 או 2");
  }

  const involved = record.professionalManagerInvolved ?? false;
  if (typeof involved !== "boolean") errors.push("מעורבות מנהל מקצועי: ערך לא תקין");

  const teacherId = typeof record.teacherId === "string" ? record.teacherId.trim() : "";
  if (!teacherId) errors.push("יש לבחור מורה קבוע");

  const subject = typeof record.subject === "string" ? record.subject.trim().replace(/\s+/g, " ") : "";
  if (!subject) errors.push("יש לציין מקצוע");
  else if (subject.length > SUBJECT_MAX) errors.push(`מקצוע: עד ${SUBJECT_MAX} תווים`);

  const rawSlots = Array.isArray(record.slots) ? record.slots : [];
  const slots = rawSlots.map(parseSlot);
  if (slots.some((slot) => slot === null)) errors.push("יום או שעה לא תקינים");
  const validSlots = slots.filter((slot): slot is WeeklySlot => slot !== null);
  if (validSubscription && rawSlots.length !== SLOTS_PER_SUBSCRIPTION[subscriptionType]) {
    errors.push(
      subscriptionType === "WEEKLY" ? "במנוי חד שבועי בוחרים מועד אחד בשבוע" : "במנוי דו שבועי בוחרים שני מועדים בשבוע"
    );
  }
  if (new Set(validSlots.map((slot) => slot.weekday)).size !== validSlots.length) {
    errors.push("שני המועדים צריכים להיות בימים שונים");
  }

  const startDate = typeof record.startDate === "string" ? record.startDate.trim() : "";
  if (!isValidDateKey(startDate)) {
    errors.push("תאריך תחילה לא תקין");
  } else if (startDate < israelDateKey(now)) {
    errors.push("תאריך התחילה כבר עבר");
  } else if (startDate > israelDateKey(now, MAX_START_DAYS_AHEAD)) {
    errors.push(`תאריך התחילה עד ${MAX_START_DAYS_AHEAD} יום קדימה`);
  }

  if (errors.length === 0) {
    const first = buildRecurringOccurrences(validSlots, startDate, 1)[0];
    if (!first || first <= now) errors.push("המועד הראשון כבר עבר, בחרו תאריך תחילה מאוחר יותר");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: {
      background,
      personalNotes,
      learningNotes,
      mainGoal: mainGoal as string,
      parentType: parentType as ParentType,
      subscriptionType: subscriptionType as SubscriptionType,
      extraPrivateLessons: extra as ExtraPrivateLessons,
      professionalManagerInvolved: involved as boolean,
      teacherId,
      subject,
      slots: validSlots,
      startDate,
    },
  };
}

export type PedagogicDecisionRecord = {
  subscriptionType: SubscriptionType;
  teacherId: string;
  teacherName: string;
  subject: string;
  slots: WeeklySlot[];
  startDate: string;
  extraPrivateLessons: ExtraPrivateLessons;
  lessonsCreated: number;
};

export type PedagogicDecisionStructuredData = CommunicationStructuredData & {
  source: "PEDAGOGIC_DECISION";
  decision: PedagogicDecisionRecord;
};

function extraLabel(extra: ExtraPrivateLessons): string {
  return extra === 0 ? "אין" : String(extra);
}

/** `structuredData` of the "סיכום שיחה לאחר מיפוי" log, keyed like the POST_MAPPING_CALL template. */
export function buildDecisionStructuredData(
  input: PedagogicDecisionInput,
  teacherName: string,
  lessonsCreated: number
): PedagogicDecisionStructuredData {
  return {
    template: "POST_MAPPING_CALL",
    source: "PEDAGOGIC_DECISION",
    fields: {
      background: input.background,
      personalNotes: input.personalNotes,
      learningNotes: input.learningNotes,
      mainGoal: input.mainGoal,
      parentType: input.parentType,
      subscriptionType: SUBSCRIPTION_TYPE_LABELS[input.subscriptionType],
      professionalManagerInvolvement: input.professionalManagerInvolved ? "כן" : "לא",
      schedule: formatWeeklySchedule(input.slots),
      extraPrivateLessons: extraLabel(input.extraPrivateLessons),
    },
    decision: {
      subscriptionType: input.subscriptionType,
      teacherId: input.teacherId,
      teacherName,
      subject: input.subject,
      slots: input.slots,
      startDate: input.startDate,
      extraPrivateLessons: input.extraPrivateLessons,
      lessonsCreated,
    },
  };
}

/** Summary text in the POST_MAPPING_CALL template layout, so the communication tab reads it like a typed summary. */
export function renderDecisionContent(structured: PedagogicDecisionStructuredData): string {
  const { teacherName, startDate } = structured.decision;
  const lines: string[] = [];
  for (const field of COMMUNICATION_TEMPLATES.POST_MAPPING_CALL.fields) {
    const value = structured.fields[field.key];
    lines.push(`${field.label}: ${typeof value === "string" || typeof value === "number" ? value : ""}`.trimEnd());
    // Continuation lines of a text field; after a choice field they would break the template parser.
    if (field.key === "schedule") {
      lines.push(`מורה קבוע: ${teacherName}`, `תחילת לימודים: ${startDate.split("-").reverse().join(".")}`);
    }
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readDecisionRecord(structuredData: unknown): PedagogicDecisionRecord | null {
  if (!isRecord(structuredData) || structuredData.source !== "PEDAGOGIC_DECISION") return null;
  const decision = structuredData.decision;
  if (!isRecord(decision)) return null;
  if (decision.subscriptionType !== "WEEKLY" && decision.subscriptionType !== "TWICE_WEEKLY") return null;
  const slots = Array.isArray(decision.slots) ? decision.slots.map(parseSlot) : [];
  if (slots.length === 0 || slots.some((slot) => slot === null)) return null;
  if (typeof decision.teacherName !== "string" || typeof decision.subject !== "string") return null;
  if (typeof decision.startDate !== "string") return null;
  const extra = (EXTRA_PRIVATE_LESSON_OPTIONS as readonly unknown[]).includes(decision.extraPrivateLessons)
    ? (decision.extraPrivateLessons as ExtraPrivateLessons)
    : 0;
  return {
    subscriptionType: decision.subscriptionType,
    teacherId: typeof decision.teacherId === "string" ? decision.teacherId : "",
    teacherName: decision.teacherName,
    subject: decision.subject,
    slots: slots as WeeklySlot[],
    startDate: decision.startDate,
    extraPrivateLessons: extra,
    lessonsCreated: typeof decision.lessonsCreated === "number" ? decision.lessonsCreated : 0,
  };
}

export type PedagogicDecisionResult = {
  logId: string;
  subscriptionType: SubscriptionType;
  teacherName: string;
  lessonsCreated: number;
  pendingPrivateLessons: number;
  firstLessonAt: string;
  studentStatus: string[];
};

// ─── Direct package track ───

export const DIRECT_PACKAGES = [
  { code: "PACK_5", name: "חבילת 5 שיעורים", credits: 5 },
  { code: "PACK_10", name: "חבילת 10 שיעורים", credits: 10 },
  { code: "EXAM_MARATHON", name: "חבילת מרתון בחינה", credits: 8 },
] as const;

export type DirectPackageCode = (typeof DIRECT_PACKAGES)[number]["code"];
export type DirectPackage = (typeof DIRECT_PACKAGES)[number];

export function findDirectPackage(code: unknown): DirectPackage | null {
  return DIRECT_PACKAGES.find((pkg) => pkg.code === code) ?? null;
}

export type DirectPackageInput = {
  packageCode: DirectPackageCode;
  subject: string;
  preferredTeacherId: string | null;
};

/** Body of `POST /api/portal/students/[id]/direct-package`. No mapping lesson is required. */
export function parseDirectPackageInput(value: unknown): ParseResult<DirectPackageInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["גוף הבקשה חסר"] };
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];

  const pkg = findDirectPackage(record.packageCode);
  if (!pkg) errors.push("יש לבחור חבילה");

  const subject = typeof record.subject === "string" ? record.subject.trim().replace(/\s+/g, " ") : "";
  if (!subject) errors.push("יש לציין מקצוע");
  else if (subject.length > SUBJECT_MAX) errors.push(`מקצוע: עד ${SUBJECT_MAX} תווים`);

  let preferredTeacherId: string | null = null;
  if (record.preferredTeacherId != null) {
    if (typeof record.preferredTeacherId !== "string") errors.push("מורה מועדף: ערך לא תקין");
    else preferredTeacherId = record.preferredTeacherId.trim() || null;
  }

  if (errors.length > 0 || !pkg) return { ok: false, errors };
  return { ok: true, data: { packageCode: pkg.code, subject, preferredTeacherId } };
}

export type DirectPackageRecord = {
  packageCode: DirectPackageCode;
  packageName: string;
  credits: number;
  subject: string;
  preferredTeacherName: string | null;
};

export type DirectPackageStructuredData = { source: "DIRECT_PACKAGE"; package: DirectPackageRecord };

export function readDirectPackageRecord(structuredData: unknown): DirectPackageRecord | null {
  if (!isRecord(structuredData) || structuredData.source !== "DIRECT_PACKAGE") return null;
  const record = structuredData.package;
  if (!isRecord(record)) return null;
  const pkg = findDirectPackage(record.packageCode);
  if (!pkg || typeof record.subject !== "string") return null;
  return {
    packageCode: pkg.code,
    packageName: pkg.name,
    credits: typeof record.credits === "number" ? record.credits : pkg.credits,
    subject: record.subject,
    preferredTeacherName: typeof record.preferredTeacherName === "string" ? record.preferredTeacherName : null,
  };
}

export type DirectPackageResult = {
  logId: string;
  packageName: string;
  creditsAdded: number;
  lessonCredits: number;
  studentStatus: string[];
};

// ─── Courses tab rows ───

export type SubscriptionRow = PedagogicDecisionRecord & { id: string; decidedAt: string };
export type PackageRow = DirectPackageRecord & { id: string; assignedAt: string };

export type EnrollmentPlans = {
  subscriptions: SubscriptionRow[];
  packages: PackageRow[];
  /** Remaining lesson credits; null when the viewer may not see billing. */
  lessonCredits: number | null;
};

// ─── 360° overview ───

export type PedagogicOverview = {
  studentName: string;
  hasWhatsappGroup: boolean;
  intake: {
    createdAt: string;
    representativeName: string | null;
    grade: string;
    levelUnits: string;
    representativeNotes: string | null;
    student: {
      lastExamScore: number | null;
      nextExamDate: string | null;
      strongTopic: string;
      weakTopic: string;
      mainGoals: string;
      firstMonthTarget: string;
      classListening: string;
      focusRequest: string | null;
      notes: string | null;
    };
    parent: {
      mainGoalYear: string;
      targetScore: number | null;
      averageScore: number | null;
      motivationLevel: string;
      successDefinition: string;
      homeStudyTime: string;
      learningDisabilities: string | null;
      emotionalDifficulties: string | null;
      involvementLevel: number | null;
      notes: string | null;
    };
  } | null;
  diagnostic: {
    createdAt: string;
    subject: string;
    lastGrade: number | null;
    learningGoal: string | null;
    challenge: string;
    identifiedGaps: string[];
  } | null;
  mapping: {
    createdAt: string;
    teacherName: string;
    topicRanking: RankedTopic[];
    classLearning: string | null;
    homeLearning: string | null;
    motivation: string | null;
    personalConnection: string | null;
    formatFit: string | null;
    subscriptionRecommendation: string | null;
    mainGoal: string | null;
    lastSchoolScore: number | null;
    additionalNotes: string | null;
  } | null;
  mappingLesson: { teacherId: string; teacherName: string; subject: string; scheduledAt: string } | null;
  teachers: TeacherOption[];
};
