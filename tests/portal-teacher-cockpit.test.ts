import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  usePathname: vi.fn(() => "/portal/dashboard"),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
}));
const store = vi.hoisted(() => ({
  users: [] as Row[],
  lessons: [] as Row[],
  logs: [] as Row[],
  ledger: [] as Row[],
}));
const calls = vi.hoisted(() => ({ prisma: [] as string[] }));

vi.mock("next/navigation", () => navigation);
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown; [key: string]: unknown }) =>
      h("a", { href, ...rest }, children as never),
  };
});
vi.mock("../lib/session", () => session);
vi.mock("../lib/audit", () => ({ writeAuditLog: vi.fn() }));

/** Minimal Prisma `where` evaluator; unknown operators fail loudly so the fake never silently passes. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function compare(value: unknown, arg: unknown): number {
  const left = value instanceof Date ? value.getTime() : Number(value);
  const right = arg instanceof Date ? arg.getTime() : Number(arg);
  return left - right;
}

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object" || cond instanceof Date) return sameValue(value ?? null, cond);
  return Object.entries(cond as Row).every(([op, arg]) => {
    switch (op) {
      case "in":
        return (arg as unknown[]).some((item) => sameValue(value, item));
      case "notIn":
        return !(arg as unknown[]).some((item) => sameValue(value, item));
      case "gte":
        return value != null && compare(value, arg) >= 0;
      case "gt":
        return value != null && compare(value, arg) > 0;
      case "lte":
        return value != null && compare(value, arg) <= 0;
      case "lt":
        return value != null && compare(value, arg) < 0;
      case "not":
        return value != null && !matchField(value, arg);
      case "some":
        return Array.isArray(value) && value.some((item) => matches(item as Row, arg as Row));
      case "is":
        return arg === null ? value == null : value != null && matches(value as Row, arg as Row);
      case "hasSome":
        return Array.isArray(value) && (arg as unknown[]).some((item) => value.includes(item));
      default:
        throw new Error(`fake prisma: unsupported operator ${op}`);
    }
  });
}

function matches(record: Row, where: Row | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, cond]) => {
    if (key === "AND") return (cond as Row[]).every((part) => matches(record, part));
    if (key === "OR") return (cond as Row[]).some((part) => matches(record, part));
    if (key === "NOT") return !(Array.isArray(cond) ? cond.some((part) => matches(record, part)) : matches(record, cond as Row));
    return matchField(record[key], cond);
  });
}

function userRecord(user: Row): Row {
  return { ...user, takenLessons: store.lessons.filter((lesson) => lesson.studentId === user.id) };
}

function lessonRecord(lesson: Row): Row {
  const student = store.users.find((user) => user.id === lesson.studentId) as Row;
  const teacher = store.users.find((user) => user.id === lesson.teacherId) as Row;
  return {
    ...lesson,
    student: { name: student.name, studentProfile: student.studentProfile ?? null },
    teacher: { name: teacher.name },
  };
}

type FindArgs = { where?: Row; select?: Row; skip?: number; take?: number; orderBy?: Row | Row[]; distinct?: string[] };

function pick(record: Row, select: Row | undefined): Row {
  if (!select) return record;
  return Object.fromEntries(Object.keys(select).map((key) => [key, record[key]]));
}

function sortByScheduledAt(rows: Row[], orderBy: FindArgs["orderBy"]): Row[] {
  const first = Array.isArray(orderBy) ? orderBy[0] : orderBy;
  const direction = first?.scheduledAt === "desc" ? -1 : 1;
  if (!first?.scheduledAt) return rows;
  return [...rows].sort((a, b) => direction * compare(a.scheduledAt, b.scheduledAt));
}

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      count: vi.fn(async ({ where }: FindArgs) => {
        calls.prisma.push("user.count");
        return store.users.map(userRecord).filter((user) => matches(user, where)).length;
      }),
      findMany: vi.fn(async ({ where, select, skip = 0, take }: FindArgs) => {
        calls.prisma.push("user.findMany");
        const rows = store.users.map(userRecord).filter((user) => matches(user, where));
        return rows.slice(skip, take === undefined ? undefined : skip + take).map((row) => pick(row, select));
      }),
      findFirst: vi.fn(async ({ where, select }: FindArgs) => {
        calls.prisma.push("user.findFirst");
        const found = store.users.find((user) => matches(user, where));
        return found ? pick(found, select) : null;
      }),
    },
    lesson: {
      findMany: vi.fn(async ({ where, orderBy, distinct }: FindArgs) => {
        calls.prisma.push("lesson.findMany");
        let rows = sortByScheduledAt(store.lessons.filter((lesson) => matches(lesson, where)), orderBy);
        if (distinct?.includes("studentId")) {
          const seen = new Set<unknown>();
          rows = rows.filter((row) => !seen.has(row.studentId) && seen.add(row.studentId));
        }
        return rows.map(lessonRecord);
      }),
    },
    studentCommunicationLog: {
      findMany: vi.fn(async ({ where }: FindArgs) => {
        calls.prisma.push("studentCommunicationLog.findMany");
        return store.logs.filter((log) => matches(log, where));
      }),
    },
    billingLedger: {
      findMany: vi.fn(async ({ where }: FindArgs) => {
        calls.prisma.push("billingLedger.findMany");
        return store.ledger.filter((row) => matches(row, where));
      }),
    },
  },
}));

import { GET as getStudents } from "../app/api/portal/students/route";
import { GET as getCockpit } from "../app/api/portal/teacher/dashboard/route";
import TeacherDashboard from "../components/portal/teacher/TeacherDashboard";
import StudentDirectory from "../components/portal/StudentDirectory";
import {
  findLessonsMissingSummary,
  israelMonthRange,
  sumAccruedPayouts,
  type TeacherDashboardData,
  type TeacherDashboardResponse,
} from "../lib/teacher-dashboard-shared";
import type { StudentDirectoryPage } from "../lib/student-directory-shared";

/** Wednesday 14 Oct 2026, 12:00 in Israel (IDT, UTC+3). */
const NOW = new Date("2026-10-14T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const DANA = { id: "t-dana", name: "דנה המורה", role: "TEACHER", isApproved: true, lessonCredits: 0 };
const OMER = { id: "t-omer", name: "עומר המורה", role: "TEACHER", isApproved: true, lessonCredits: 0 };
const sessionUser = (role: string, id = `user-${role.toLowerCase()}`) => ({
  id,
  name: `משתמש ${role}`,
  role,
  lessonCredits: 0,
  isApproved: true,
});

function student(id: string, name: string, extra: Row = {}): Row {
  return {
    id,
    name,
    role: "STUDENT",
    phone: "0501234567",
    email: null,
    classTrack: null,
    createdAt: new Date("2026-09-01T08:00:00Z"),
    studentProfile: { firstName: null, lastName: null, grade: "יא", studyGroup: null, city: null, studentStatus: [] },
    intakeAssessments: [],
    referralsAsStudent: [],
    ...extra,
  };
}

function lesson(id: string, studentId: string, scheduledAt: Date, extra: Row = {}): Row {
  return {
    id,
    studentId,
    teacherId: DANA.id,
    title: "מתמטיקה 5 יח״ל",
    scheduledAt,
    startTime: null,
    endTime: null,
    durationMinutes: 60,
    status: "SCHEDULED",
    lessonType: "REGULAR",
    attendanceStatus: null,
    ...extra,
  };
}

function seed() {
  store.users = [
    { ...DANA, phone: "0520000001", studentProfile: null, referralsAsStudent: [] },
    { ...OMER, phone: "0520000002", studentProfile: null, referralsAsStudent: [] },
    student("stu-matan", "מתן לוי"),
    student("stu-noa", "נועה כהן"),
    student("stu-maya", "מאיה פרץ"),
    student("stu-referral", "יואב שובץ", { referralsAsStudent: [{ teacherId: DANA.id }] }),
    student("stu-omer", "רון של עומר"),
    student("stu-omer-referral", "שירה של עומר", { referralsAsStudent: [{ teacherId: OMER.id }] }),
    student("stu-lead", "ליד שלא שובץ"),
  ];
  store.lessons = [
    lesson("L-started", "stu-matan", at(-3 * HOUR)),
    lesson("L-in-progress", "stu-noa", at(-20 * 60 * 1000), { status: "IN_PROGRESS" }),
    lesson("L-today", "stu-matan", at(2 * HOUR)),
    lesson("L-week", "stu-noa", at(3 * DAY), { lessonType: "MAKEUP" }),
    lesson("L-far", "stu-matan", at(8 * DAY)),
    lesson("L-cancelled", "stu-matan", at(DAY), { status: "CANCELLED" }),
    lesson("L-yesterday-open", "stu-matan", at(-DAY)),
    lesson("L-omer-next", "stu-omer", at(DAY), { teacherId: OMER.id }),

    lesson("C1", "stu-matan", at(-5 * DAY), { status: "COMPLETED", attendanceStatus: "PRESENT" }),
    lesson("C2", "stu-matan", at(-2 * DAY), { status: "COMPLETED", attendanceStatus: "PRESENT", durationMinutes: 90 }),
    lesson("C3", "stu-noa", at(-3 * DAY), { status: "COMPLETED", attendanceStatus: "PRESENT", lessonType: "MAPPING", title: "שיעור מיפוי" }),
    lesson("C4", "stu-noa", at(-DAY), { status: "COMPLETED", attendanceStatus: "ABSENT" }),
    lesson("C5", "stu-noa", at(-20 * DAY), { status: "COMPLETED", attendanceStatus: "PRESENT" }),
    // 1 Oct 00:30 Israel: first minutes of the month.
    lesson("C-month-start", "stu-maya", new Date("2026-09-30T21:30:00Z"), { status: "COMPLETED", attendanceStatus: "PRESENT", durationMinutes: 45 }),
    // 30 Sep 23:30 Israel: previous month.
    lesson("C-prev-month", "stu-maya", new Date("2026-09-30T20:30:00Z"), { status: "COMPLETED", attendanceStatus: "PRESENT" }),
    lesson("C-omer", "stu-omer", at(-DAY), { status: "COMPLETED", attendanceStatus: "PRESENT", teacherId: OMER.id }),
  ];
  store.logs = [
    { studentId: "stu-matan", type: "LESSON_SUMMARY", createdAt: at(-5 * DAY + 2 * HOUR) },
    { studentId: "stu-noa", type: "LESSON_SUMMARY", createdAt: at(-3 * DAY + HOUR) },
    { studentId: "stu-maya", type: "LESSON_SUMMARY", createdAt: new Date("2026-09-30T21:00:00Z") },
    { studentId: "stu-maya", type: "LESSON_SUMMARY", createdAt: new Date("2026-09-30T22:30:00Z") },
    { studentId: "stu-matan", type: "GENERAL", createdAt: at(-2 * DAY + HOUR) },
  ];
  store.ledger = [
    { userId: DANA.id, entryType: "PAYOUT", amount: 140, transactionId: "lesson-payout-C1", createdAt: at(-5 * DAY) },
    { userId: DANA.id, entryType: "PAYOUT", amount: 140, transactionId: "payout-paid-p1-tx-77", createdAt: at(-4 * DAY) },
    { userId: DANA.id, entryType: "PAYOUT", amount: "70.0000", transactionId: null, createdAt: at(-9 * DAY) },
    { userId: DANA.id, entryType: "PAYOUT", amount: { toString: () => "280.0000" }, transactionId: "lesson-payout-C2", createdAt: at(-2 * DAY) },
    { userId: DANA.id, entryType: "PENALTY", amount: -50, transactionId: null, createdAt: at(-DAY) },
    // 30 Sep 23:00 Israel and 1 Nov 00:30 Israel: outside October.
    { userId: DANA.id, entryType: "PAYOUT", amount: 140, transactionId: "lesson-payout-old", createdAt: new Date("2026-09-30T20:00:00Z") },
    { userId: DANA.id, entryType: "PAYOUT", amount: 140, transactionId: "lesson-payout-next", createdAt: new Date("2026-10-31T22:30:00Z") },
    { userId: OMER.id, entryType: "PAYOUT", amount: 999, transactionId: "lesson-payout-C-omer", createdAt: at(-DAY) },
  ];
}

const readSource = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

async function cockpit(query = ""): Promise<{ status: number; body: TeacherDashboardResponse }> {
  const res = await getCockpit(new Request(`https://project100.test/api/portal/teacher/dashboard${query}`));
  return { status: res.status, body: (await res.json()) as TeacherDashboardResponse };
}

async function directoryIds(): Promise<string[]> {
  const res = await getStudents(new Request("https://project100.test/api/portal/students"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: StudentDirectoryPage };
  return body.data.students.map((row) => row.id).sort();
}

function cockpitData(body: TeacherDashboardResponse): TeacherDashboardData {
  if (!body.success || !body.data) throw new Error(`expected cockpit data, got ${JSON.stringify(body)}`);
  return body.data;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  seed();
  calls.prisma = [];
  session.getCurrentUser.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("student directory role isolation", () => {
  it("a teacher sees only students with a lesson or a referral to them", async () => {
    session.getCurrentUser.mockResolvedValue(DANA);
    expect(await directoryIds()).toEqual(["stu-matan", "stu-maya", "stu-noa", "stu-referral"]);
  });

  it("another teacher's students and unassigned students stay hidden", async () => {
    session.getCurrentUser.mockResolvedValue(OMER);
    const ids = await directoryIds();
    expect(ids).toEqual(["stu-omer", "stu-omer-referral"]);
    expect(ids).not.toContain("stu-lead");
  });

  it.each(["ADMIN", "MANAGER", "REPRESENTATIVE"])("%s sees every student", async (role) => {
    session.getCurrentUser.mockResolvedValue(sessionUser(role));
    expect(await directoryIds()).toEqual([
      "stu-lead",
      "stu-matan",
      "stu-maya",
      "stu-noa",
      "stu-omer",
      "stu-omer-referral",
      "stu-referral",
    ]);
  });

  it("a STUDENT cannot list students", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("STUDENT", "stu-matan"));
    const res = await getStudents(new Request("https://project100.test/api/portal/students"));
    expect(res.status).toBe(403);
    expect(calls.prisma).toEqual([]);
  });

  it("uses teacher wording in the directory", () => {
    const render = (isTeacher: boolean) =>
      renderToStaticMarkup(
        createElement(StudentDirectory, { initialSearch: "", initialStatus: null, initialGrade: null, initialPage: 1, isTeacher })
      );
    const teacherHtml = render(true);
    expect(teacherHtml).toContain("התלמידים שלי");
    expect(teacherHtml).toContain("סטטוס תלמיד");
    expect(teacherHtml).toContain("השיעור הקרוב / האחרון איתך");
    expect(teacherHtml).toContain('href="/portal/dashboard"');
    expect(teacherHtml).not.toContain("מורה אחראי");
    const staffHtml = render(false);
    expect(staffHtml).toContain("לקוחות");
    expect(staffHtml).toContain("מורה אחראי");
    expect(staffHtml).not.toContain("חזרה למרחב המורה");
  });
});

describe("GET /api/portal/teacher/dashboard", () => {
  it("answers 401 without a session", async () => {
    const { status } = await cockpit();
    expect(status).toBe(401);
    expect(calls.prisma).toEqual([]);
  });

  it.each(["STUDENT", "REPRESENTATIVE"])("answers 403 to %s before touching the database", async (role) => {
    session.getCurrentUser.mockResolvedValue(sessionUser(role));
    const { status } = await cockpit(`?teacherId=${DANA.id}`);
    expect(status).toBe(403);
    expect(calls.prisma).toEqual([]);
  });

  it("returns the exact upcoming lessons of the next 7 days, sorted, with today / week counts", async () => {
    session.getCurrentUser.mockResolvedValue(DANA);
    const { status, body } = await cockpit();
    expect(status).toBe(200);
    const data = cockpitData(body);
    expect(data.teacher).toEqual({ id: DANA.id, name: DANA.name });
    expect(data.upcoming.map((row) => row.id)).toEqual(["L-started", "L-in-progress", "L-today", "L-week"]);
    expect(data.todayCount).toBe(3);
    expect(data.weekCount).toBe(4);

    const byId = Object.fromEntries(data.upcoming.map((row) => [row.id, row]));
    expect(byId["L-today"]).toMatchObject({
      studentId: "stu-matan",
      studentName: "מתן לוי",
      subject: "מתמטיקה 5 יח״ל",
      grade: "יא",
      scheduledAt: at(2 * HOUR).toISOString(),
      endsAt: at(3 * HOUR).toISOString(),
      isToday: true,
      canEnterRoom: true,
      canComplete: false,
    });
    expect(byId["L-started"].canComplete).toBe(true);
    expect(byId["L-in-progress"].canComplete).toBe(true);
    expect(byId["L-week"]).toMatchObject({ isToday: false, isMakeup: true, canComplete: false });
  });

  it("returns completed lessons of the last 14 days still missing a summary", async () => {
    session.getCurrentUser.mockResolvedValue(DANA);
    const data = cockpitData((await cockpit()).body);
    expect(data.pendingSummaries).toEqual([
      {
        lessonId: "C2",
        studentId: "stu-matan",
        studentName: "מתן לוי",
        subject: "מתמטיקה 5 יח״ל",
        scheduledAt: at(-2 * DAY).toISOString(),
        summaryType: "LESSON_SUMMARY",
        summaryHref: "/portal/students/stu-matan?tab=communication&autoPromptSummary=true&lessonId=C2",
      },
      {
        lessonId: "C3",
        studentId: "stu-noa",
        studentName: "נועה כהן",
        subject: "שיעור מיפוי",
        scheduledAt: at(-3 * DAY).toISOString(),
        summaryType: "MAPPING_SUMMARY",
        summaryHref: "/portal/students/stu-noa?tab=communication&autoPromptSummary=true&lessonId=C3",
      },
    ]);
  });

  it("totals the Israel calendar month: lessons, hours and accrued PAYOUT ledger rows without double counting", async () => {
    session.getCurrentUser.mockResolvedValue(DANA);
    const { earnings } = cockpitData((await cockpit()).body);
    expect(earnings).toEqual({
      monthLabel: israelMonthRange(NOW).label,
      monthStart: "2026-09-30T21:00:00.000Z",
      monthEnd: "2026-10-31T22:00:00.000Z",
      completedLessons: 5,
      attendedLessons: 4,
      noShowLessons: 1,
      minutesTaught: 315,
      hoursTaught: 5.3,
      accruedPayoutIls: 490,
    });
  });

  it("ignores ?teacherId= for a teacher and never returns the teacher list", async () => {
    session.getCurrentUser.mockResolvedValue(DANA);
    const { body } = await cockpit(`?teacherId=${OMER.id}`);
    expect(body.success && body.teachers).toBeNull();
    const data = cockpitData(body);
    expect(data.teacher.id).toBe(DANA.id);
    expect(data.upcoming.some((row) => row.id === "L-omer-next")).toBe(false);
    expect(data.earnings.accruedPayoutIls).toBe(490);
  });

  it("lets ADMIN pick a teacher: no id returns only the teacher list", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    const { status, body } = await cockpit();
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, data: null, teachers: [DANA, OMER].map(({ id, name }) => ({ id, name })) });
  });

  it("serves MANAGER the chosen teacher's cockpit", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("MANAGER"));
    const data = cockpitData((await cockpit(`?teacherId=${OMER.id}`)).body);
    expect(data.teacher).toEqual({ id: OMER.id, name: OMER.name });
    expect(data.upcoming.map((row) => row.id)).toEqual(["L-omer-next"]);
    expect(data.upcoming[0].canEnterRoom).toBe(true);
    expect(data.earnings.accruedPayoutIls).toBe(999);
    expect(data.pendingSummaries.map((row) => row.lessonId)).toEqual(["C-omer"]);
  });

  it("answers 404 for an id that is not a teacher", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    expect((await cockpit("?teacherId=stu-matan")).status).toBe(404);
  });
});

describe("cockpit rules", () => {
  it("sums PAYOUT rows once, skipping markPayoutPaid settlement copies", () => {
    expect(
      sumAccruedPayouts([
        { amount: 140, transactionId: "lesson-payout-a" },
        { amount: 140, transactionId: "payout-paid-x-1" },
        { amount: "70.5", transactionId: null },
      ])
    ).toBe(210.5);
  });

  it("matches a summary to the lesson whose window it falls in", () => {
    const lessons = [
      { id: "a", studentId: "s", startsAt: at(-3 * DAY), attendanceStatus: "PRESENT", lessonType: "REGULAR" },
      { id: "b", studentId: "s", startsAt: at(-DAY), attendanceStatus: "PRESENT", lessonType: "REGULAR" },
    ];
    // One summary written after lesson b does not cover lesson a.
    const missing = findLessonsMissingSummary(lessons, [{ studentId: "s", type: "LESSON_SUMMARY", createdAt: at(-HOUR) }]);
    expect(missing.map((row) => row.id)).toEqual(["a"]);
  });

  it("computes the Israel month across the DST switch", () => {
    const range = israelMonthRange(NOW);
    expect(range.start.toISOString()).toBe("2026-09-30T21:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-10-31T22:00:00.000Z");
  });
});

describe("TeacherDashboard UI", () => {
  async function loadData(): Promise<TeacherDashboardData> {
    session.getCurrentUser.mockResolvedValue(DANA);
    return cockpitData((await cockpit()).body);
  }

  it("renders the four KPI cards with the pending card in warning style", async () => {
    const data = await loadData();
    const html = renderToStaticMarkup(
      createElement(TeacherDashboard, { viewerRole: "TEACHER", viewerName: DANA.name, initialData: data })
    );
    for (const label of ["שיעורים להיום / השבוע", "סיכומים ממתינים להזנה", "שעות שבוצעו החודש", "צפי שכר חודשי צבור (₪)"]) {
      expect(html).toContain(`data-kpi="${label}"`);
    }
    expect(html).toContain("3 / 4");
    expect(html).toMatch(/data-kpi="סיכומים ממתינים להזנה" data-warning="true"/);
    expect(html).toContain("₪490");
    expect(html).toContain("5.3");
  });

  it("lists upcoming lessons with room links and completion only after the lesson started", async () => {
    const html = renderToStaticMarkup(
      createElement(TeacherDashboard, { viewerRole: "TEACHER", viewerName: DANA.name, initialData: await loadData() })
    );
    expect(html).toContain('href="/lessons/L-today"');
    expect(html.match(/היכנס לשיעור/g)).toHaveLength(4);
    expect(html.match(/סיום שיעור ונוכחות/g)).toHaveLength(2);
    expect(html).toContain("כיתה יא · מתמטיקה 5 יח״ל");
    expect(html).toContain("שיעור השלמה");
    expect(html).toContain('href="/dashboard"');
  });

  it("links every pending summary straight to the summary form", async () => {
    const html = renderToStaticMarkup(
      createElement(TeacherDashboard, { viewerRole: "TEACHER", viewerName: DANA.name, initialData: await loadData() })
    );
    expect(html).toContain("משימות לטיפול מהיר");
    expect(html).toContain('href="/portal/students/stu-matan?tab=communication&amp;autoPromptSummary=true&amp;lessonId=C2"');
    expect(html).toContain("הזן סיכום מיפוי");
  });

  it("drops the warning style when nothing is pending", async () => {
    const data = { ...(await loadData()), pendingSummaries: [] };
    const html = renderToStaticMarkup(
      createElement(TeacherDashboard, { viewerRole: "TEACHER", viewerName: DANA.name, initialData: data })
    );
    expect(html).toMatch(/data-kpi="סיכומים ממתינים להזנה" data-warning="false"/);
    expect(html).toContain("אין סיכומי שיעור שממתינים להזנה");
  });

  it("gives management a teacher picker", () => {
    const html = renderToStaticMarkup(
      createElement(TeacherDashboard, {
        viewerRole: "ADMIN",
        viewerName: "מנהלת",
        initialData: null,
        initialTeachers: [{ id: DANA.id, name: DANA.name }],
      })
    );
    expect(html).toContain('aria-label="בחירת מורה"');
    expect(html).toContain(DANA.name);
    expect(html).toContain("חזרה ללוח הנציגים");
  });
});

describe("/portal/dashboard routing", () => {
  const loadPage = async () => (await import("../app/portal/dashboard/page")).default;
  type ElementLike = { type: unknown; props: { children?: unknown; [key: string]: unknown } };

  it("renders the cockpit for an approved teacher", async () => {
    session.getCurrentUser.mockResolvedValue(DANA);
    const Page = await loadPage();
    const tree = (await Page()) as unknown as ElementLike;
    const [, main] = tree.props.children as ElementLike[];
    const cockpitElement = main.props.children as ElementLike;
    expect(cockpitElement.type).toBe(TeacherDashboard);
    expect(cockpitElement.props.viewerRole).toBe("TEACHER");
  });

  it("switches ADMIN to the teacher view with ?view=teacher", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    const Page = await loadPage();
    const tree = (await Page({ searchParams: Promise.resolve({ view: "teacher", teacherId: DANA.id }) })) as unknown as ElementLike;
    const [, main] = tree.props.children as ElementLike[];
    const cockpitElement = main.props.children as ElementLike;
    expect(cockpitElement.type).toBe(TeacherDashboard);
    expect(cockpitElement.props.initialTeacherId).toBe(DANA.id);
  });

  it("offers the teacher view link on the admin dashboard and routes the teacher tab to the cockpit", async () => {
    expect(readSource("app/portal/dashboard/page.tsx")).toContain('href="/portal/dashboard?view=teacher"');
    const { portalNavTabs } = await import("../lib/portal-nav");
    expect(portalNavTabs("TEACHER")[0]).toEqual({ key: "today", label: "היום", href: "/portal/dashboard" });
  });

  it("uses relative imports only in the sprint files", () => {
    for (const file of [
      "app/api/portal/teacher/dashboard/route.ts",
      "app/portal/dashboard/page.tsx",
      "components/portal/teacher/TeacherDashboard.tsx",
      "components/portal/StudentDirectory.tsx",
      "lib/teacher-dashboard.ts",
      "lib/teacher-dashboard-shared.ts",
      "lib/student-directory.ts",
    ]) {
      expect(readSource(file), file).not.toMatch(/from ["']@\//);
    }
    expect(readSource("app/api/portal/teacher/dashboard/route.ts")).toContain('from "../../../../../lib/teacher-dashboard"');
  });
});
