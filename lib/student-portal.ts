import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { isIntakeRecorderRole } from "./auth/staff-roles";
import { normalizeToE164 } from "./utils/phone";
import {
  isCommunicationType,
  type CommunicationAuthorRole,
  type CommunicationStructuredData,
  type RankedTopic,
} from "./communication-templates";
import { rescheduleBlock } from "./lesson-lifecycle";
import { canCompleteLesson, creditTakenAtBooking, isLessonManagementRole } from "./lesson-completion";
import { isMakeupLesson } from "./absence-resolution";
import { lessonAntiCollisionWindow } from "./scheduling";
import {
  PENDING_SCHEDULE_STATUS,
  readDecisionRecord,
  readDirectPackageRecord,
  type EnrollmentPlans,
  type PedagogicOverview,
} from "./pedagogic-decision";
import {
  activateStudentStatuses,
  ageFromBirthDate,
  canEnterLessonRoom,
  clearUnexcusedAbsence,
  flagUnexcusedAbsence,
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
  type StudentStatusCode,
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
  studentId?: string;
  packageId: string | null;
  attendanceStatus: string | null;
  lessonType: string;
  whatsappGroupId: string | null;
  rescheduledCount?: number;
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
  studentId: true,
  packageId: true,
  attendanceStatus: true,
  lessonType: true,
  whatsappGroupId: true,
  rescheduledCount: true,
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
    if (CANCELLED_STATUSES.has(lesson.status) || lesson.status === PENDING_SCHEDULE_STATUS) continue;
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
      canMarkAttendance:
        started &&
        !CANCELLED_STATUSES.has(lesson.status) &&
        lesson.status !== PENDING_SCHEDULE_STATUS &&
        (canMarkAny || ownLesson),
      canEnterRoom: canEnterLessonRoom(viewer, lesson),
      teacherId: lesson.teacherId,
      durationMinutes: lesson.durationMinutes ?? 60,
      ...lifecycleFlags(lesson, viewer, canMarkAny, now),
      canComplete: canCompleteLesson(
        viewer,
        { status: lesson.status, teacherId: lesson.teacherId, startsAt: lessonStart(lesson) },
        now
      ),
      creditTakenAtBooking: creditTakenAtBooking(lesson),
      isMakeup: isMakeupLesson(lesson),
    };
  });
}

function lifecycleFlags(
  lesson: LessonForTabs,
  viewer: Viewer,
  staff: boolean,
  now: Date
): Pick<MeetingRow, "canSchedulePending" | "canReschedule" | "rescheduleBlock" | "canEmergencyReschedule" | "canCancel"> {
  const upcoming = lesson.status === "SCHEDULED" && lessonStart(lesson) > now;
  const block =
    staff && upcoming
      ? rescheduleBlock({ scheduledAt: lessonStart(lesson), rescheduledCount: lesson.rescheduledCount ?? 0 }, now)
      : null;
  return {
    canSchedulePending: staff && lesson.status === PENDING_SCHEDULE_STATUS,
    canReschedule: staff && upcoming && block === null,
    rescheduleBlock: block,
    canEmergencyReschedule: block !== null && isLessonManagementRole(viewer.role),
    canCancel: staff && upcoming,
  };
}

export type LessonConflict = { party: "STUDENT" | "TEACHER"; at: Date } | null;

/** 60-minute anti-collision check for one start time, ignoring `excludeLessonId` (the lesson being moved). */
export async function findLessonConflict(
  tx: Prisma.TransactionClient,
  params: { studentId: string; teacherId: string; at: Date; excludeLessonId?: string }
): Promise<LessonConflict> {
  const { windowStart, windowEnd } = lessonAntiCollisionWindow(params.at);
  const where = {
    ...(params.excludeLessonId ? { id: { not: params.excludeLessonId } } : {}),
    status: { in: ["SCHEDULED", "IN_PROGRESS"] },
    scheduledAt: { gt: windowStart, lt: windowEnd },
  };
  const [studentOverlap, teacherOverlap] = await Promise.all([
    tx.lesson.findFirst({ where: { studentId: params.studentId, ...where }, select: { scheduledAt: true } }),
    tx.lesson.findFirst({ where: { teacherId: params.teacherId, ...where }, select: { scheduledAt: true } }),
  ]);
  if (studentOverlap) return { party: "STUDENT", at: studentOverlap.scheduledAt };
  if (teacherOverlap) return { party: "TEACHER", at: teacherOverlap.scheduledAt };
  return null;
}

/** Frees the teacher's availability slot that started at `at`, if one backs the lesson. */
export async function releaseTeacherSlot(tx: Prisma.TransactionClient, teacherId: string, at: Date): Promise<void> {
  await tx.teacherAvailability.updateMany({ where: { teacherId, startTime: at, isBooked: true }, data: { isBooked: false } });
}

/** Marks the teacher's open availability slot at `at` as booked, if the teacher opened one. */
export async function bookTeacherSlot(tx: Prisma.TransactionClient, teacherId: string, at: Date): Promise<void> {
  await tx.teacherAvailability.updateMany({ where: { teacherId, startTime: at, isBooked: false }, data: { isBooked: true } });
}

/** The student bought at least one direct hours package (Sprint 14 track). */
export async function studentHasDirectPackage(studentId: string): Promise<boolean> {
  const plans = await loadEnrollmentPlans(studentId, null);
  return plans.packages.length > 0;
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

const PLAN_LOG_LIMIT = 50;

/** Subscriptions and packages recorded on the communication log by the decision / package APIs. */
export async function loadEnrollmentPlans(studentId: string, lessonCredits: number | null): Promise<EnrollmentPlans> {
  const rows = await prisma.studentCommunicationLog.findMany({
    where: { studentId, type: { in: ["POST_MAPPING_CALL", "GENERAL"] } },
    orderBy: { createdAt: "desc" },
    take: PLAN_LOG_LIMIT,
    select: { id: true, createdAt: true, structuredData: true },
  });
  const plans: EnrollmentPlans = { subscriptions: [], packages: [], lessonCredits };
  for (const row of rows) {
    const decision = readDecisionRecord(row.structuredData);
    if (decision) {
      plans.subscriptions.push({ ...decision, id: row.id, decidedAt: row.createdAt.toISOString() });
      continue;
    }
    const pkg = readDirectPackageRecord(row.structuredData);
    if (pkg) plans.packages.push({ ...pkg, id: row.id, assignedAt: row.createdAt.toISOString() });
  }
  return plans;
}

/** Adds the active "תלמיד" status and clears waiting statuses, inside the caller's transaction. */
export async function markStudentActive(
  tx: Prisma.TransactionClient,
  studentId: string,
  actorId: string,
  now: Date = new Date()
): Promise<StudentStatusCode[]> {
  const current = await tx.studentProfile.findUnique({ where: { userId: studentId }, select: { studentStatus: true } });
  const studentStatus = activateStudentStatuses(current?.studentStatus ?? []);
  const data = { studentStatus, statusUpdatedAt: now, statusUpdatedById: actorId };
  await tx.studentProfile.upsert({ where: { userId: studentId }, create: { userId: studentId, ...data }, update: data });
  return studentStatus;
}

/** Adds the "חיסור לא מוצדק" status to the student's CRM card after a no-show. */
export async function markUnexcusedAbsence(
  tx: Prisma.TransactionClient,
  studentId: string,
  actorId: string,
  now: Date = new Date()
): Promise<StudentStatusCode[]> {
  const current = await tx.studentProfile.findUnique({ where: { userId: studentId }, select: { studentStatus: true } });
  const studentStatus = flagUnexcusedAbsence(current?.studentStatus ?? []);
  const data = { studentStatus, statusUpdatedAt: now, statusUpdatedById: actorId };
  await tx.studentProfile.upsert({ where: { userId: studentId }, create: { userId: studentId, ...data }, update: data });
  return studentStatus;
}

/**
 * Removes the "חיסור לא מוצדק" flag inside the caller's transaction. Returns null when the student has no open
 * absence; the conditional update also makes a second, parallel follow-up of the same absence a no-op.
 */
export async function clearUnexcusedAbsenceFlag(
  tx: Prisma.TransactionClient,
  studentId: string,
  actorId: string,
  now: Date = new Date()
): Promise<StudentStatusCode[] | null> {
  const current = await tx.studentProfile.findUnique({ where: { userId: studentId }, select: { studentStatus: true } });
  if (!current?.studentStatus.includes("UNEXCUSED_ABSENCE")) return null;
  const studentStatus = clearUnexcusedAbsence(current.studentStatus);
  const cleared = await tx.studentProfile.updateMany({
    where: { userId: studentId, studentStatus: { has: "UNEXCUSED_ABSENCE" } },
    data: { studentStatus, statusUpdatedAt: now, statusUpdatedById: actorId },
  });
  return cleared.count === 1 ? studentStatus : null;
}

function structuredText(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function structuredNumber(fields: Record<string, unknown>, key: string): number | null {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRankedTopic(value: unknown): value is RankedTopic {
  if (!value || typeof value !== "object") return false;
  const topic = value as Record<string, unknown>;
  return typeof topic.rank === "number" && typeof topic.topic === "string";
}

/**
 * 360° view for the pedagogic decision: the representative's intake call (student + parent answers),
 * the student's diagnostic questionnaire, the mapping teacher's summary and the mapping lesson.
 */
export async function loadPedagogicOverview(studentId: string): Promise<PedagogicOverview | null> {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { name: true, role: true, whatsappGroupId: true },
  });
  if (!student || student.role !== "STUDENT") return null;

  const [intake, diagnostic, mappingLog, mappingLesson, teachers] = await Promise.all([
    prisma.intakeAssessment.findFirst({
      where: { studentId },
      orderBy: { createdAt: "desc" },
      include: { representative: { select: { name: true } } },
    }),
    prisma.diagnosticQuiz.findFirst({
      where: { studentId },
      orderBy: { createdAt: "desc" },
      select: {
        createdAt: true,
        subject: true,
        lastGrade: true,
        learningGoal: true,
        challenge: true,
        identifiedGaps: true,
      },
    }),
    prisma.studentCommunicationLog.findFirst({
      where: { studentId, type: "MAPPING_SUMMARY" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, authorName: true, structuredData: true },
    }),
    prisma.lesson.findFirst({
      where: { studentId, lessonType: "MAPPING" },
      orderBy: { scheduledAt: "desc" },
      select: { teacherId: true, title: true, scheduledAt: true, teacher: { select: { name: true } } },
    }),
    listTeacherOptions(),
  ]);

  const mappingFields =
    (mappingLog?.structuredData as CommunicationStructuredData | null)?.fields ?? ({} as Record<string, unknown>);
  const ranking = mappingFields.topicRanking;

  return {
    studentName: student.name,
    hasWhatsappGroup: Boolean(student.whatsappGroupId?.trim()),
    intake: intake
      ? {
          createdAt: intake.createdAt.toISOString(),
          representativeName: intake.representative?.name ?? null,
          grade: intake.grade,
          levelUnits: intake.levelUnits,
          representativeNotes: intake.representativeNotes,
          student: {
            lastExamScore: intake.lastExamScore,
            nextExamDate: toDateOnly(intake.nextExamDate),
            strongTopic: intake.strongTopic,
            weakTopic: intake.weakTopic,
            mainGoals: intake.mainGoals,
            firstMonthTarget: intake.firstMonthTarget,
            classListening: intake.classListening,
            focusRequest: intake.focusRequest,
            notes: intake.studentImportantNotes,
          },
          parent: {
            mainGoalYear: intake.parentMainGoalYear,
            targetScore: intake.parentTargetScore,
            averageScore: intake.parentAverageScore,
            motivationLevel: intake.motivationLevel,
            successDefinition: intake.successDefinition,
            homeStudyTime: intake.homeStudyTime,
            learningDisabilities: intake.learningDisabilities,
            emotionalDifficulties: intake.emotionalDifficulties,
            involvementLevel: intake.parentInvolvementLevel,
            notes: intake.parentImportantNotes,
          },
        }
      : null,
    diagnostic: diagnostic
      ? {
          createdAt: diagnostic.createdAt.toISOString(),
          subject: diagnostic.subject,
          lastGrade: diagnostic.lastGrade,
          learningGoal: diagnostic.learningGoal,
          challenge: diagnostic.challenge,
          identifiedGaps: diagnostic.identifiedGaps,
        }
      : null,
    mapping: mappingLog
      ? {
          createdAt: mappingLog.createdAt.toISOString(),
          teacherName: mappingLog.authorName,
          topicRanking: Array.isArray(ranking) ? ranking.filter(isRankedTopic) : [],
          classLearning: structuredText(mappingFields, "classLearning"),
          homeLearning: structuredText(mappingFields, "homeLearning"),
          motivation: structuredText(mappingFields, "motivation"),
          personalConnection: structuredText(mappingFields, "personalConnection"),
          formatFit: structuredText(mappingFields, "formatFit"),
          subscriptionRecommendation: structuredText(mappingFields, "subscriptionRecommendation"),
          mainGoal: structuredText(mappingFields, "mainGoal"),
          lastSchoolScore: structuredNumber(mappingFields, "lastSchoolScore"),
          additionalNotes: structuredText(mappingFields, "additionalNotes"),
        }
      : null,
    mappingLesson: mappingLesson
      ? {
          teacherId: mappingLesson.teacherId,
          teacherName: mappingLesson.teacher?.name ?? "",
          subject: mappingLesson.title?.trim() || "",
          scheduledAt: mappingLesson.scheduledAt.toISOString(),
        }
      : null,
    teachers,
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
      whatsappGroupId: true,
      studentProfile: true,
    },
  });
  if (!student || student.role !== "STUDENT") return null;

  const portalViewer = buildViewer(viewer);

  const [lessons, intakes, communication, plans] = await Promise.all([
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
    loadEnrollmentPlans(studentId, portalViewer.canViewBilling ? student.lessonCredits : null),
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
    plans,
    meetings: buildMeetingRows(lessons, viewer, now),
    communication,
    whatsappGroupLinked: Boolean(student.whatsappGroupId?.trim()),
    standingOrders,
  };
}
