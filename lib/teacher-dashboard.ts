import { prisma } from "./prisma";
import { canCompleteLesson } from "./lesson-completion";
import { isMakeupLesson } from "./absence-resolution";
import { canEnterLessonRoom } from "./student-portal-shared";
import {
  expectedSummaryType,
  findLessonsMissingSummary,
  isSameIsraelDay,
  israelDayStart,
  israelMonthRange,
  minutesToHours,
  PENDING_SUMMARY_WINDOW_DAYS,
  sumAccruedPayouts,
  summaryHref,
  UPCOMING_WINDOW_DAYS,
  type CockpitLesson,
  type MonthlyEarnings,
  type PendingSummary,
  type TeacherDashboardData,
} from "./teacher-dashboard-shared";

/** Server-only loader behind `GET /api/portal/teacher/dashboard`. */

type Viewer = { id: string; role: string };

const DAY_MS = 24 * 60 * 60 * 1000;

type LessonRow = {
  id: string;
  title: string | null;
  scheduledAt: Date;
  startTime: Date | null;
  endTime: Date | null;
  durationMinutes: number | null;
  status: string;
  lessonType: string;
  attendanceStatus: string | null;
  teacherId: string;
  studentId: string;
  student: { name: string; studentProfile: { firstName: string | null; lastName: string | null; grade: string | null } | null };
};

const LESSON_SELECT = {
  id: true,
  title: true,
  scheduledAt: true,
  startTime: true,
  endTime: true,
  durationMinutes: true,
  status: true,
  lessonType: true,
  attendanceStatus: true,
  teacherId: true,
  studentId: true,
  student: { select: { name: true, studentProfile: { select: { firstName: true, lastName: true, grade: true } } } },
} as const;

function lessonStart(lesson: LessonRow): Date {
  return lesson.startTime ?? lesson.scheduledAt;
}

function lessonEnd(lesson: LessonRow): Date {
  return lesson.endTime ?? new Date(lessonStart(lesson).getTime() + (lesson.durationMinutes ?? 60) * 60_000);
}

function studentName(lesson: LessonRow): string {
  const profile = lesson.student.studentProfile;
  const fromProfile = [profile?.firstName, profile?.lastName].filter(Boolean).join(" ").trim();
  return fromProfile || lesson.student.name;
}

function subject(lesson: LessonRow): string {
  return lesson.title?.trim() || "שיעור פרטי";
}

function toCockpitLesson(lesson: LessonRow, viewer: Viewer, now: Date): CockpitLesson {
  const startsAt = lessonStart(lesson);
  return {
    id: lesson.id,
    studentId: lesson.studentId,
    studentName: studentName(lesson),
    subject: subject(lesson),
    grade: lesson.student.studentProfile?.grade ?? null,
    scheduledAt: startsAt.toISOString(),
    endsAt: lessonEnd(lesson).toISOString(),
    durationMinutes: lesson.durationMinutes ?? 60,
    status: lesson.status,
    lessonType: lesson.lessonType === "MAPPING" ? "MAPPING" : "REGULAR",
    isMakeup: isMakeupLesson(lesson),
    isToday: isSameIsraelDay(startsAt, now),
    canEnterRoom: canEnterLessonRoom(viewer, lesson),
    canComplete: canCompleteLesson(viewer, { status: lesson.status, teacherId: lesson.teacherId, startsAt }, now),
  };
}

/** Open lessons from the start of today (Israel) through the next 7 days, plus anything still in progress. */
async function loadUpcoming(teacherId: string, viewer: Viewer, now: Date): Promise<CockpitLesson[]> {
  const lessons: LessonRow[] = await prisma.lesson.findMany({
    where: {
      teacherId,
      OR: [
        { status: "IN_PROGRESS" },
        {
          status: "SCHEDULED",
          scheduledAt: { gte: israelDayStart(now), lte: new Date(now.getTime() + UPCOMING_WINDOW_DAYS * DAY_MS) },
        },
      ],
    },
    orderBy: { scheduledAt: "asc" },
    select: LESSON_SELECT,
  });
  return lessons
    .map((lesson) => toCockpitLesson(lesson, viewer, now))
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

async function loadPendingSummaries(teacherId: string, now: Date): Promise<PendingSummary[]> {
  const since = new Date(now.getTime() - PENDING_SUMMARY_WINDOW_DAYS * DAY_MS);
  const completed: LessonRow[] = await prisma.lesson.findMany({
    where: { teacherId, status: "COMPLETED", scheduledAt: { gte: since, lte: now } },
    orderBy: { scheduledAt: "asc" },
    select: LESSON_SELECT,
  });
  if (completed.length === 0) return [];

  const summaries = await prisma.studentCommunicationLog.findMany({
    where: {
      studentId: { in: [...new Set(completed.map((lesson) => lesson.studentId))] },
      type: { in: ["LESSON_SUMMARY", "MAPPING_SUMMARY"] },
      createdAt: { gte: since },
    },
    select: { studentId: true, type: true, createdAt: true },
  });

  const missing = findLessonsMissingSummary(
    completed.map((lesson) => ({ ...lesson, startsAt: lessonStart(lesson) })),
    summaries
  );
  return missing.map((lesson) => ({
    lessonId: lesson.id,
    studentId: lesson.studentId,
    studentName: studentName(lesson),
    subject: subject(lesson),
    scheduledAt: lesson.startsAt.toISOString(),
    summaryType: expectedSummaryType(lesson.lessonType),
    summaryHref: summaryHref(lesson.studentId, lesson.id),
  }));
}

async function loadMonthlyEarnings(teacherId: string, now: Date): Promise<MonthlyEarnings> {
  const month = israelMonthRange(now);
  const range = { gte: month.start, lt: month.end };
  const [completed, payouts] = await Promise.all([
    prisma.lesson.findMany({
      where: { teacherId, status: "COMPLETED", scheduledAt: range },
      select: { durationMinutes: true, attendanceStatus: true },
    }),
    prisma.billingLedger.findMany({
      where: { userId: teacherId, entryType: "PAYOUT", createdAt: range },
      select: { amount: true, transactionId: true },
    }),
  ]);
  const noShowLessons = completed.filter((lesson) => lesson.attendanceStatus === "ABSENT").length;
  const minutesTaught = completed.reduce((sum, lesson) => sum + (lesson.durationMinutes ?? 60), 0);
  return {
    monthLabel: month.label,
    monthStart: month.start.toISOString(),
    monthEnd: month.end.toISOString(),
    completedLessons: completed.length,
    attendedLessons: completed.length - noShowLessons,
    noShowLessons,
    minutesTaught,
    hoursTaught: minutesToHours(minutesTaught),
    accruedPayoutIls: sumAccruedPayouts(payouts),
  };
}

export async function loadTeacherDashboard(
  teacher: { id: string; name: string },
  viewer: Viewer,
  now: Date = new Date()
): Promise<TeacherDashboardData> {
  const [upcoming, pendingSummaries, earnings] = await Promise.all([
    loadUpcoming(teacher.id, viewer, now),
    loadPendingSummaries(teacher.id, now),
    loadMonthlyEarnings(teacher.id, now),
  ]);
  return {
    teacher,
    generatedAt: now.toISOString(),
    todayCount: upcoming.filter((lesson) => lesson.isToday).length,
    weekCount: upcoming.length,
    upcoming,
    pendingSummaries,
    earnings,
  };
}

/** An approved teacher picked by management; null when the id is unknown or not a teacher. */
export async function findDashboardTeacher(teacherId: string): Promise<{ id: string; name: string } | null> {
  return prisma.user.findFirst({
    where: { id: teacherId, role: "TEACHER" },
    select: { id: true, name: true },
  });
}
