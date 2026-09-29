import { prisma } from "./prisma";
import { isIntakeRecorderRole } from "./auth/staff-roles";
import { normalizeToE164 } from "./utils/phone";
import { isCommunicationType, type CommunicationAuthorRole } from "./communication-templates";
import {
  ageFromBirthDate,
  type AttendanceStatus,
  type CardLookup,
  type CommunicationEntry,
  type CourseRow,
  type MeetingRow,
  type ProfileTabData,
  type StandingOrderData,
  type StandingOrderStatus,
  type StudentPortalData,
  type StudentPortalViewer,
  type TeacherOption,
} from "./student-portal-shared";

/**
 * Server-only data access for the staff student screen and its APIs.
 * REPRESENTATIVE / ADMIN / MANAGER see every student; a TEACHER only students they teach or were
 * referred to. Anything else is refused.
 */

type Viewer = { id: string; role: string };

export type StudentAccess =
  | { ok: true; student: { id: string; name: string } }
  | { ok: false; status: 403 | 404 };

const CANCELLED_STATUSES = new Set(["CANCELLED", "CANCELLED_LATE"]);
const MEETINGS_LIMIT = 100;
const COMMUNICATION_LIMIT = 200;
const CHARGES_LIMIT = 50;
const STRIPE_LOOKUP_TIMEOUT_MS = 4000;

export async function resolveStudentAccess(viewer: Viewer, studentId: string): Promise<StudentAccess> {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, name: true, role: true },
  });
  if (!student || student.role !== "STUDENT") return { ok: false, status: 404 };

  if (isIntakeRecorderRole(viewer.role)) return { ok: true, student: { id: student.id, name: student.name } };

  if (viewer.role === "TEACHER") {
    const [lesson, referral] = await Promise.all([
      prisma.lesson.findFirst({ where: { studentId, teacherId: viewer.id }, select: { id: true } }),
      prisma.teacherReferral.findFirst({ where: { studentId, teacherId: viewer.id }, select: { id: true } }),
    ]);
    if (lesson || referral) return { ok: true, student: { id: student.id, name: student.name } };
  }

  return { ok: false, status: 403 };
}

export function buildViewer(viewer: Viewer): StudentPortalViewer {
  const staffManager = isIntakeRecorderRole(viewer.role);
  return { id: viewer.id, role: viewer.role, canEditProfile: staffManager, canViewBilling: staffManager };
}

export function whatsappUrl(phone: string | null | undefined): string | null {
  if (!phone?.trim()) return null;
  try {
    return `https://wa.me/${normalizeToE164(phone).slice(1)}`;
  } catch {
    return null;
  }
}

function toDateOnly(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

const weekdayFormat = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", weekday: "short" });
const timeFormat = new Intl.DateTimeFormat("he-IL", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

type LessonForTabs = {
  id: string;
  title: string | null;
  scheduledAt: Date;
  startTime: Date | null;
  endTime: Date | null;
  durationMinutes: number | null;
  status: string;
  teacherId: string;
  packageId: string | null;
  attendanceStatus: string | null;
  lessonType: string;
  whatsappGroupId: string | null;
  teacher: { name: string } | null;
  package: { name: string; credits: number } | null;
};

const LESSON_TAB_SELECT = {
  id: true,
  title: true,
  scheduledAt: true,
  startTime: true,
  endTime: true,
  durationMinutes: true,
  status: true,
  teacherId: true,
  packageId: true,
  attendanceStatus: true,
  lessonType: true,
  whatsappGroupId: true,
  teacher: { select: { name: true } },
  package: { select: { name: true, credits: true } },
} as const;

function lessonStart(lesson: LessonForTabs): Date {
  return lesson.startTime ?? lesson.scheduledAt;
}

function lessonEnd(lesson: LessonForTabs): Date {
  if (lesson.endTime) return lesson.endTime;
  return new Date(lessonStart(lesson).getTime() + (lesson.durationMinutes ?? 60) * 60_000);
}

function slotLabel(lesson: LessonForTabs): string {
  const start = lessonStart(lesson);
  return `${weekdayFormat.format(start)} ${timeFormat.format(start)}–${timeFormat.format(lessonEnd(lesson))}`;
}

/** Most frequent weekday/hour slots of the active lessons (at most 3). */
function recurringSchedule(lessons: LessonForTabs[]): string[] {
  const counts = new Map<string, number>();
  for (const lesson of lessons) {
    if (CANCELLED_STATUSES.has(lesson.status)) continue;
    const label = slotLabel(lesson);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label]) => label);
}

/**
 * Enrollment rows: lessons grouped by package, or by title + teacher when no package is linked.
 * A package with more than one credit, or a group with several active lessons, counts as a subscription.
 */
export function buildCourseRows(
  lessons: LessonForTabs[],
  intakes: { id: string; createdAt: Date; weakTopic: string; representative: { name: string } | null }[],
  now: Date
): CourseRow[] {
  const groups = new Map<string, LessonForTabs[]>();
  for (const lesson of lessons) {
    const key = lesson.packageId
      ? `package:${lesson.packageId}`
      : `lesson:${lesson.title?.trim() || "שיעור פרטי"}:${lesson.teacherId}`;
    groups.set(key, [...(groups.get(key) ?? []), lesson]);
  }

  const rows: CourseRow[] = [...groups.entries()].map(([key, group]) => {
    const sorted = [...group].sort((a, b) => lessonStart(b).getTime() - lessonStart(a).getTime());
    const latest = sorted[0];
    const active = group.filter((l) => !CANCELLED_STATUSES.has(l.status));
    const upcoming = active
      .filter((l) => l.status === "SCHEDULED" && lessonStart(l) > now)
      .sort((a, b) => lessonStart(a).getTime() - lessonStart(b).getTime());
    const isSubscription = latest.package ? latest.package.credits > 1 : active.length > 1;
    return {
      key,
      kind: "COURSE",
      title: latest.package?.name ?? (latest.title?.trim() || "שיעור פרטי"),
      schedule: recurringSchedule(group),
      enrollmentType: isSubscription ? "SUBSCRIPTION" : "ONE_TIME",
      teacherName: latest.teacher?.name ?? null,
      nextMeetingAt: upcoming[0] ? lessonStart(upcoming[0]).toISOString() : null,
      upcomingCount: upcoming.length,
      completedCount: group.filter((l) => l.status === "COMPLETED").length,
    };
  });

  rows.sort((a, b) => (b.nextMeetingAt ? 1 : 0) - (a.nextMeetingAt ? 1 : 0));

  for (const intake of intakes) {
    rows.push({
      key: `intake:${intake.id}`,
      kind: "MAPPING",
      title: `שיחת מיפוי · ${intake.weakTopic}`,
      schedule: [],
      enrollmentType: "ONE_TIME",
      teacherName: intake.representative?.name ?? null,
      nextMeetingAt: null,
      upcomingCount: 0,
      completedCount: 1,
    });
  }

  return rows;
}

export function buildMeetingRows(lessons: LessonForTabs[], viewer: Viewer, now: Date): MeetingRow[] {
  const canMarkAny = isIntakeRecorderRole(viewer.role);
  return lessons.map((lesson) => {
    const started = lessonStart(lesson) <= now;
    const ownLesson = viewer.role === "TEACHER" && lesson.teacherId === viewer.id;
    return {
      id: lesson.id,
      scheduledAt: lessonStart(lesson).toISOString(),
      endsAt: lessonEnd(lesson).toISOString(),
      title: lesson.package?.name ?? (lesson.title?.trim() || "שיעור פרטי"),
      teacherName: lesson.teacher?.name ?? null,
      status: lesson.status,
      lessonType: lesson.lessonType === "MAPPING" ? "MAPPING" : "REGULAR",
      whatsappLinked: Boolean(lesson.whatsappGroupId),
      attendanceStatus: toAttendance(lesson.attendanceStatus),
      canMarkAttendance: started && !CANCELLED_STATUSES.has(lesson.status) && (canMarkAny || ownLesson),
    };
  });
}

export async function listMeetingRows(studentId: string, viewer: Viewer, now: Date = new Date()): Promise<MeetingRow[]> {
  const lessons = await prisma.lesson.findMany({
    where: { studentId },
    orderBy: { scheduledAt: "desc" },
    take: MEETINGS_LIMIT,
    select: LESSON_TAB_SELECT,
  });
  return buildMeetingRows(lessons, viewer, now);
}

/** Approved teachers for the schedule-meeting dropdown, by name. */
export async function listTeacherOptions(): Promise<TeacherOption[]> {
  return prisma.user.findMany({
    where: { role: "TEACHER", isApproved: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

function toAttendance(value: string | null): AttendanceStatus | null {
  return value === "PRESENT" || value === "ABSENT" ? value : null;
}

export function isCancelledLessonStatus(status: string): boolean {
  return CANCELLED_STATUSES.has(status);
}

export async function listCommunicationEntries(studentId: string): Promise<CommunicationEntry[]> {
  const rows = await prisma.studentCommunicationLog.findMany({
    where: { studentId },
    orderBy: { createdAt: "desc" },
    take: COMMUNICATION_LIMIT,
    select: {
      id: true,
      createdAt: true,
      type: true,
      courseContext: true,
      authorName: true,
      authorRole: true,
      content: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    type: isCommunicationType(row.type) ? row.type : "GENERAL",
    courseContext: row.courseContext,
    authorName: row.authorName,
    authorRole: row.authorRole as CommunicationAuthorRole,
    content: row.content,
  }));
}

function stripeSecretKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  return key && key !== "mock" ? key : null;
}

type CardDetails = { brand?: string | null; last4?: string | null } | null | undefined;

/** Card brand + last 4 digits of the PaymentIntent behind a Stripe checkout. Read-only; never throws. */
export async function lookupStripeCard(transactionId: string | null): Promise<CardLookup> {
  if (!transactionId?.startsWith("pi_")) return { state: "NO_STRIPE_PAYMENT" };
  const key = stripeSecretKey();
  if (!key) return { state: "NOT_CONFIGURED" };

  try {
    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(key, { timeout: STRIPE_LOOKUP_TIMEOUT_MS, maxNetworkRetries: 0 });
    const intent = await stripe.paymentIntents.retrieve(transactionId, {
      expand: ["payment_method", "latest_charge"],
    });
    const method = typeof intent.payment_method === "object" ? intent.payment_method : null;
    const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
    const card: CardDetails = method?.card ?? charge?.payment_method_details?.card;
    if (card?.last4) return { state: "FOUND", brand: card.brand ?? "card", last4: card.last4 };
    return { state: "UNAVAILABLE" };
  } catch (error: unknown) {
    console.error("Stripe card lookup failed:", error instanceof Error ? error.message : error);
    return { state: "UNAVAILABLE" };
  }
}

export async function loadStandingOrders(
  studentId: string,
  lessonCredits: number,
  statuses: string[]
): Promise<StandingOrderData> {
  const payments = await prisma.payment.findMany({
    where: { studentId },
    orderBy: { createdAt: "desc" },
    take: CHARGES_LIMIT,
    select: {
      id: true,
      createdAt: true,
      packageType: true,
      amountPaid: true,
      creditsAdded: true,
      status: true,
      transactionId: true,
    },
  });

  const completed = payments.filter((p) => p.status === "COMPLETED");
  let status: StandingOrderStatus = "NONE";
  if (statuses.includes("SUBSCRIPTION_CANCELLED")) status = "CANCELLED";
  else if (lessonCredits > 0) status = "ACTIVE";
  else if (completed.length > 0) status = "USED_UP";

  const latestStripe = completed.find((p) => p.transactionId.startsWith("pi_")) ?? null;
  const card = await lookupStripeCard(latestStripe?.transactionId ?? null);

  return {
    status,
    lessonCredits,
    card,
    charges: payments.map((p) => ({
      id: p.id,
      createdAt: p.createdAt.toISOString(),
      packageType: p.packageType,
      amountPaid: p.amountPaid,
      creditsAdded: p.creditsAdded,
      status: p.status,
    })),
  };
}

/** All five tabs for one student. Call only after `resolveStudentAccess` succeeded. */
export async function loadStudentPortal(
  studentId: string,
  viewer: Viewer,
  now: Date = new Date()
): Promise<StudentPortalData | null> {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      role: true,
      schoolName: true,
      classTrack: true,
      parentName: true,
      parentPhone: true,
      lessonCredits: true,
      createdAt: true,
      studentProfile: true,
    },
  });
  if (!student || student.role !== "STUDENT") return null;

  const portalViewer = buildViewer(viewer);

  const [lessons, intakes, communication] = await Promise.all([
    prisma.lesson.findMany({
      where: { studentId },
      orderBy: { scheduledAt: "desc" },
      take: MEETINGS_LIMIT,
      select: LESSON_TAB_SELECT,
    }),
    prisma.intakeAssessment.findMany({
      where: { studentId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        grade: true,
        levelUnits: true,
        weakTopic: true,
        representative: { select: { name: true } },
      },
    }),
    listCommunicationEntries(studentId),
  ]);

  const profileRow = student.studentProfile;
  const latestIntake = intakes[0] ?? null;
  const [firstFromName, ...restOfName] = student.name.trim().split(/\s+/);
  const birthDate = toDateOnly(profileRow?.birthDate);
  const statuses = profileRow?.studentStatus ?? [];

  const profile: ProfileTabData = {
    firstName: profileRow?.firstName ?? firstFromName ?? null,
    lastName: profileRow?.lastName ?? (restOfName.join(" ") || null),
    phone: student.phone,
    whatsappUrl: whatsappUrl(student.phone),
    grade: profileRow?.grade ?? latestIntake?.grade ?? null,
    studyGroup: profileRow?.studyGroup ?? latestIntake?.levelUnits ?? student.classTrack ?? null,
    email: student.email,
    nationalId: profileRow?.nationalId ?? null,
    city: profileRow?.city ?? null,
    birthDate,
    age: ageFromBirthDate(birthDate, now),
    schoolName: student.schoolName,
    parentName: student.parentName,
    parentPhone: student.parentPhone,
    parentWhatsappUrl: whatsappUrl(student.parentPhone),
    invoiceName: portalViewer.canViewBilling ? (profileRow?.invoiceName ?? null) : null,
    invoiceTaxId: portalViewer.canViewBilling ? (profileRow?.invoiceTaxId ?? null) : null,
    studentStatus: statuses,
    statusUpdatedAt: profileRow?.statusUpdatedAt?.toISOString() ?? null,
  };

  const standingOrders = portalViewer.canViewBilling
    ? await loadStandingOrders(studentId, student.lessonCredits, statuses)
    : null;

  return {
    header: { id: student.id, name: student.name, createdAt: student.createdAt.toISOString() },
    viewer: portalViewer,
    profile,
    courses: buildCourseRows(lessons, intakes, now),
    meetings: buildMeetingRows(lessons, viewer, now),
    communication,
    standingOrders,
  };
}
