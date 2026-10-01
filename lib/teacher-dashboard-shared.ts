import type { Role } from "@prisma/client";
import { israelDateKey, israelLocalToIso, type TeacherOption } from "./student-portal-shared";

/** Client-safe types and rules of the teacher cockpit (`/portal/dashboard`, `GET /api/portal/teacher/dashboard`). */

export const TEACHER_DASHBOARD_ROLES: Role[] = ["TEACHER", "ADMIN", "MANAGER"];
export const UPCOMING_WINDOW_DAYS = 7;
export const PENDING_SUMMARY_WINDOW_DAYS = 14;

/** Ledger rows written by `markPayoutPaid` repeat an already scheduled payout and must not be counted twice. */
const PAYOUT_SETTLEMENT_PREFIX = "payout-paid-";

export type SummaryType = "LESSON_SUMMARY" | "MAPPING_SUMMARY";

export type CockpitLesson = {
  id: string;
  studentId: string;
  studentName: string;
  subject: string;
  grade: string | null;
  scheduledAt: string;
  endsAt: string;
  durationMinutes: number;
  status: string;
  lessonType: "MAPPING" | "REGULAR";
  isMakeup: boolean;
  isToday: boolean;
  canEnterRoom: boolean;
  canComplete: boolean;
};

export type PendingSummary = {
  lessonId: string;
  studentId: string;
  studentName: string;
  subject: string;
  scheduledAt: string;
  summaryType: SummaryType;
  summaryHref: string;
};

export type MonthlyEarnings = {
  monthLabel: string;
  monthStart: string;
  monthEnd: string;
  completedLessons: number;
  attendedLessons: number;
  noShowLessons: number;
  minutesTaught: number;
  hoursTaught: number;
  /** PAYOUT ledger rows of the month (lesson pay and late-cancel shares), settlement copies excluded. */
  accruedPayoutIls: number;
};

export type TeacherDashboardData = {
  teacher: { id: string; name: string };
  generatedAt: string;
  todayCount: number;
  weekCount: number;
  upcoming: CockpitLesson[];
  pendingSummaries: PendingSummary[];
  earnings: MonthlyEarnings;
};

export type TeacherDashboardResponse =
  | {
      success: true;
      /** null until management picks a teacher. */
      data: TeacherDashboardData | null;
      /** Teacher picker for ADMIN / MANAGER; null for a teacher. */
      teachers: TeacherOption[] | null;
    }
  | { success: false; error: string };

export function teacherDashboardEndpoint(teacherId: string | null): string {
  return teacherId
    ? `/api/portal/teacher/dashboard?teacherId=${encodeURIComponent(teacherId)}`
    : "/api/portal/teacher/dashboard";
}

export function summaryHref(studentId: string, lessonId: string): string {
  return `/portal/students/${encodeURIComponent(studentId)}?tab=communication&autoPromptSummary=true&lessonId=${encodeURIComponent(lessonId)}`;
}

const monthLabelFormat = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", month: "long", year: "numeric" });

/** Calendar month of `now` in Israel: [start, end) as UTC instants. */
export function israelMonthRange(now: Date): { start: Date; end: Date; label: string } {
  const [year, month] = israelDateKey(now).split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const pad = (value: number) => String(value).padStart(2, "0");
  const start = new Date(israelLocalToIso(`${year}-${pad(month)}-01`, "00:00") as string);
  const end = new Date(israelLocalToIso(`${nextYear}-${pad(nextMonth)}-01`, "00:00") as string);
  return { start, end, label: monthLabelFormat.format(now) };
}

export function israelDayStart(now: Date): Date {
  return new Date(israelLocalToIso(israelDateKey(now), "00:00") as string);
}

export function isSameIsraelDay(a: Date, b: Date): boolean {
  return israelDateKey(a) === israelDateKey(b);
}

type AmountLike = number | string | { toString(): string };

/** Sum of PAYOUT ledger rows, skipping the copy `markPayoutPaid` writes on settlement. Rounded to agorot. */
export function sumAccruedPayouts(rows: readonly { amount: AmountLike; transactionId: string | null }[]): number {
  const total = rows
    .filter((row) => !row.transactionId?.startsWith(PAYOUT_SETTLEMENT_PREFIX))
    .reduce((sum, row) => sum + Number(row.amount.toString()), 0);
  return Math.round(total * 100) / 100;
}

export function minutesToHours(minutes: number): number {
  return Math.round((minutes / 60) * 10) / 10;
}

export type CompletedLessonForSummary = {
  id: string;
  studentId: string;
  startsAt: Date;
  attendanceStatus: string | null;
  lessonType: string;
};

export function expectedSummaryType(lessonType: string): SummaryType {
  return lessonType === "MAPPING" ? "MAPPING_SUMMARY" : "LESSON_SUMMARY";
}

/**
 * Completed lessons still waiting for a summary. Summaries carry no lesson id, so each lesson owns the window
 * from its start until the student's next completed lesson; a summary of the expected type inside that window
 * counts. A no-show needs no summary.
 */
export function findLessonsMissingSummary<T extends CompletedLessonForSummary>(
  lessons: readonly T[],
  summaries: readonly { studentId: string; type: string; createdAt: Date }[]
): T[] {
  const byStudent = new Map<string, T[]>();
  for (const lesson of lessons) byStudent.set(lesson.studentId, [...(byStudent.get(lesson.studentId) ?? []), lesson]);

  const missing: T[] = [];
  for (const [studentId, group] of byStudent) {
    const sorted = [...group].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    const studentSummaries = summaries.filter((s) => s.studentId === studentId);
    sorted.forEach((lesson, index) => {
      if (lesson.attendanceStatus === "ABSENT") return;
      const from = lesson.startsAt.getTime();
      const until = sorted[index + 1]?.startsAt.getTime() ?? Number.POSITIVE_INFINITY;
      const type = expectedSummaryType(lesson.lessonType);
      const covered = studentSummaries.some(
        (s) => s.type === type && s.createdAt.getTime() >= from && s.createdAt.getTime() < until
      );
      if (!covered) missing.push(lesson);
    });
  }
  return missing.sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
}
