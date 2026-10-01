import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCount: vi.fn(),
  userFindMany: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
  lessonFindUnique: vi.fn(),
  lessonFindFirst: vi.fn(),
  lessonFindMany: vi.fn(),
  lessonCreate: vi.fn(),
  lessonUpdate: vi.fn(),
  lessonUpdateMany: vi.fn(),
  referralFindFirst: vi.fn(),
  logCreate: vi.fn(),
  logFindMany: vi.fn(),
  profileFindUnique: vi.fn(),
  profileUpdateMany: vi.fn(),
  profileUpsert: vi.fn(),
  payoutFindUnique: vi.fn(),
  payoutCreate: vi.fn(),
  ledgerCreate: vi.fn(),
  ledgerFindUnique: vi.fn(),
  quizFindMany: vi.fn(),
  quizUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
}));
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
const daily = vi.hoisted(() => ({
  deleteDailyRoom: vi.fn(),
  roomNameFromDailyUrl: vi.fn((url: string) => url.split("/").pop() ?? null),
  dailyRoomNameForLesson: vi.fn((id: string) => `lesson-${id}`),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: db.userFindUnique,
      count: db.userCount,
      findMany: db.userFindMany,
      update: db.userUpdate,
      updateMany: db.userUpdateMany,
    },
    lesson: {
      findUnique: db.lessonFindUnique,
      findFirst: db.lessonFindFirst,
      findMany: db.lessonFindMany,
      updateMany: db.lessonUpdateMany,
    },
    teacherReferral: { findFirst: db.referralFindFirst },
    studentCommunicationLog: { create: db.logCreate, findMany: db.logFindMany },
    $transaction: db.transaction,
  },
}));
vi.mock("../lib/session", () => session);
vi.mock("../lib/audit", () => audit);
vi.mock("../lib/daily", () => daily);
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { POST as saveSummary } from "../app/api/lessons/[id]/summary/route";
import { POST as resolveAbsence } from "../app/api/portal/students/[id]/resolve-absence/route";
import { POST as completeLesson } from "../app/api/portal/students/[id]/meetings/[meetingId]/complete/route";
import MeetingsTab from "../components/portal/student/MeetingsTab";
import StudentDirectory from "../components/portal/StudentDirectory";
import { buildMeetingRows } from "../lib/student-portal";
import { attendanceMetrics, clearUnexcusedAbsence, hasOpenAbsence } from "../lib/student-portal-shared";
import { listStudentDirectory } from "../lib/student-directory";
import { parseStudentDirectoryQuery, type StudentDirectoryQuery } from "../lib/student-directory-shared";
import {
  makeupLessonTitle,
  parseResolveAbsenceInput,
  submitAbsenceResolution,
} from "../lib/absence-resolution";
import { buildPrivateLessonScheduledMessage } from "../lib/whatsapp";

/** Wednesday 30.09.2026, 15:00 Israel time. */
const NOW = new Date("2026-09-30T12:00:00.000Z");
const MISSED_AT = new Date("2026-09-29T17:00:00.000Z");
const ROOT = join(__dirname, "..");

const STUDENT = { id: "stu-1", name: "מתן קולמן", role: "STUDENT", whatsappGroupId: "120363025555555555@g.us" };
const TEACHER = { id: "teacher-1", name: "רונית לוי", role: "TEACHER", lessonCredits: 0, isApproved: true };
const OTHER_TEACHER = { id: "teacher-2", name: "אבי כהן", role: "TEACHER", lessonCredits: 0, isApproved: true };

function staff(role: string, id = `user-${role.toLowerCase()}`) {
  return { id, name: "שירה מהצוות", role, lessonCredits: 0, isApproved: true };
}

const LESSON = { id: "lesson-1", teacherId: TEACHER.id, studentId: STUDENT.id };

const ABSENT_LESSON = {
  id: "lesson-absent",
  title: "מתמטיקה 5 יח״ל",
  scheduledAt: MISSED_AT,
  startTime: null,
  teacherId: TEACHER.id,
  durationMinutes: 50,
  whatsappGroupId: STUDENT.whatsappGroupId,
};

const tx = {
  lesson: { create: db.lessonCreate, update: db.lessonUpdate, updateMany: db.lessonUpdateMany, findFirst: db.lessonFindFirst },
  user: { findUnique: db.userFindUnique, update: db.userUpdate, updateMany: db.userUpdateMany },
  studentProfile: { findUnique: db.profileFindUnique, updateMany: db.profileUpdateMany, upsert: db.profileUpsert },
  studentCommunicationLog: { create: db.logCreate },
  teacherPayout: { findUnique: db.payoutFindUnique, create: db.payoutCreate },
  billingLedger: { create: db.ledgerCreate, findUnique: db.ledgerFindUnique },
  diagnosticQuiz: { findMany: db.quizFindMany, update: db.quizUpdate },
  auditLog: { create: db.auditCreate },
};

function jsonRequest(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const summaryRequest = (body: unknown) => saveSummary(jsonRequest("https://p100.example/api/lessons/lesson-1/summary", body) as never, {
  params: Promise.resolve({ id: LESSON.id }),
});

const resolveRequest = (body: unknown, id = STUDENT.id) =>
  resolveAbsence(jsonRequest(`https://p100.example/api/portal/students/${id}/resolve-absence`, body), {
    params: Promise.resolve({ id }),
  });

const VALID_RESOLUTION = { reason: "התלמיד היה חולה, ההורה עדכן באיחור", resolutionType: "EXCUSED_NO_MAKEUP", notes: null };

function profileWrite() {
  return db.profileUpdateMany.mock.calls[0]?.[0] as {
    where: { userId: string; studentStatus: { has: string } };
    data: { studentStatus: string[]; statusUpdatedById: string };
  };
}

function auditEntry() {
  return db.auditCreate.mock.calls[0]?.[0] as {
    data: { action: string; entityType: string; entityId: string; metadata: Record<string, unknown> };
  };
}

function logEntry() {
  return db.logCreate.mock.calls[0]?.[0] as {
    data: { type: string; courseContext: string; content: string; authorRole: string; structuredData: Record<string, unknown> };
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});

  session.getCurrentUser.mockResolvedValue(staff("MANAGER"));
  db.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    [STUDENT, TEACHER, OTHER_TEACHER].find((u) => u.id === where.id) ?? null
  );
  db.lessonFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === LESSON.id ? LESSON : null
  );
  db.lessonFindFirst.mockImplementation(async ({ where }: { where: { attendanceStatus?: string; id?: string } }) => {
    if (where.attendanceStatus === "ABSENT") return !where.id || where.id === ABSENT_LESSON.id ? ABSENT_LESSON : null;
    return null;
  });
  db.referralFindFirst.mockResolvedValue(null);
  db.transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  db.profileFindUnique.mockResolvedValue({ studentStatus: ["STUDENT", "BOILING_160", "UNEXCUSED_ABSENCE"] });
  db.profileUpdateMany.mockResolvedValue({ count: 1 });
  db.profileUpsert.mockResolvedValue({});
  db.lessonCreate.mockResolvedValue({ id: "lesson-makeup" });
  db.lessonUpdate.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    status: "COMPLETED",
    packageId: null,
  }));
  db.lessonUpdateMany.mockResolvedValue({ count: 1 });
  db.logCreate.mockResolvedValue({ id: "log-1" });
  db.logFindMany.mockResolvedValue([]);
  db.auditCreate.mockResolvedValue({ id: "audit-1" });
  db.userUpdateMany.mockResolvedValue({ count: 1 });
  db.payoutFindUnique.mockResolvedValue(null);
  db.payoutCreate.mockImplementation(async ({ data }: { data: { teacherId: string; amount: number; currency: string } }) => ({
    id: "payout-1",
    teacherId: data.teacherId,
    amount: { toString: () => String(data.amount) },
    currency: data.currency,
    status: "SCHEDULED",
  }));
  db.ledgerCreate.mockResolvedValue({ id: "ledger-1" });
  db.ledgerFindUnique.mockResolvedValue(null);
  db.quizFindMany.mockResolvedValue([]);
  audit.writeAuditLog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("POST /api/lessons/[id]/summary — hardened against IDOR", () => {
  const body = { teacherId: TEACHER.id, summaryText: "כלל השרשרת הובן", resolvedGaps: ["כלל השרשרת"] };

  it("answers 401 without a session and never touches the lesson", async () => {
    session.getCurrentUser.mockResolvedValue(null);
    const res = await summaryRequest(body);
    expect(res.status).toBe(401);
    expect(db.lessonFindUnique).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("answers 403 to a teacher who is not assigned to the lesson, even when the body names the right teacher", async () => {
    session.getCurrentUser.mockResolvedValue(OTHER_TEACHER);
    const res = await summaryRequest(body);
    expect(res.status).toBe(403);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.lessonUpdate).not.toHaveBeenCalled();
  });

  it.each(["STUDENT", "REPRESENTATIVE"])("answers 403 to %s before any lookup", async (role) => {
    session.getCurrentUser.mockResolvedValue(staff(role, role === "STUDENT" ? STUDENT.id : "rep-1"));
    const res = await summaryRequest(body);
    expect(res.status).toBe(403);
    expect(db.lessonFindUnique).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("lets the assigned teacher save, taking the teacher from the lesson and not from the body", async () => {
    session.getCurrentUser.mockResolvedValue(TEACHER);
    const res = await summaryRequest({ ...body, teacherId: OTHER_TEACHER.id });
    expect(res.status).toBe(200);
    expect(db.lessonUpdate).toHaveBeenCalledWith({
      where: { id: LESSON.id },
      data: { status: "COMPLETED", pedagogicalBrief: "כלל השרשרת הובן" },
    });
  });

  it.each(["ADMIN", "MANAGER"])("lets %s save any lesson", async (role) => {
    session.getCurrentUser.mockResolvedValue(staff(role));
    expect((await summaryRequest(body)).status).toBe(200);
  });

  it("answers 404 for an unknown lesson and 400 without summary text", async () => {
    db.lessonFindUnique.mockResolvedValue(null);
    expect((await summaryRequest(body)).status).toBe(404);

    db.lessonFindUnique.mockResolvedValue(LESSON);
    expect((await summaryRequest({ summaryText: "   " })).status).toBe(400);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("the orphaned PostLessonSummaryModal is gone and nothing imports it", () => {
    expect(existsSync(join(ROOT, "components/lessons/PostLessonSummaryModal.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, "components/portal/student/PostLessonSummaryModal.tsx"))).toBe(false);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(path, "utf8").includes("PostLessonSummaryModal")) offenders.push(path);
      }
    };
    ["app", "components", "lib"].forEach((dir) => walk(join(ROOT, dir)));
    expect(offenders).toEqual([]);
  });
});

describe("POST /api/portal/students/[id]/resolve-absence — access and validation", () => {
  it("answers 401 without a session", async () => {
    session.getCurrentUser.mockResolvedValue(null);
    expect((await resolveRequest(VALID_RESOLUTION)).status).toBe(401);
  });

  it.each([
    ["TEACHER", TEACHER],
    ["STUDENT", { ...STUDENT, lessonCredits: 0, isApproved: true }],
  ])("answers 403 to a %s", async (_role, user) => {
    session.getCurrentUser.mockResolvedValue(user);
    const res = await resolveRequest(VALID_RESOLUTION);
    expect(res.status).toBe(403);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects a missing reason or an unknown resolution type", async () => {
    const res = await resolveRequest({ reason: " ", resolutionType: "FORGIVEN" });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("יש לפרט את סיבת החיסור");
    expect(body.error).toContain("יש לבחור את אופן הטיפול בחיסור");
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("parses the payload strictly", () => {
    expect(parseResolveAbsenceInput({ ...VALID_RESOLUTION, notes: "  " })).toEqual({
      ok: true,
      data: { reason: VALID_RESOLUTION.reason, resolutionType: "EXCUSED_NO_MAKEUP", notes: null, lessonId: null },
    });
    expect(parseResolveAbsenceInput({ ...VALID_RESOLUTION, reason: "א".repeat(501) }).ok).toBe(false);
    expect(parseResolveAbsenceInput({ ...VALID_RESOLUTION, lessonId: 7 }).ok).toBe(false);
    expect(parseResolveAbsenceInput(null).ok).toBe(false);
  });
});

describe("POST …/resolve-absence — closing the follow-up", () => {
  it("removes the \"חיסור לא מוצדק\" tag, documents the call and audits ABSENCE_RESOLVED", async () => {
    const res = await resolveRequest({ ...VALID_RESOLUTION, notes: "ההורה ביקש תזכורת יום לפני" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      absenceResolved: true,
      makeupLessonCreated: false,
      makeupLessonId: null,
      studentStatus: ["STUDENT", "BOILING_160"],
    });

    const profile = profileWrite();
    expect(profile.where).toEqual({ userId: STUDENT.id, studentStatus: { has: "UNEXCUSED_ABSENCE" } });
    expect(profile.data.studentStatus).toEqual(["STUDENT", "BOILING_160"]);
    expect(profile.data.statusUpdatedById).toBe("user-manager");

    const log = logEntry().data;
    expect(log).toMatchObject({ type: "GENERAL", courseContext: "שיחת בירור חיסור", authorRole: "PEDAGOGIC_MANAGER" });
    expect(log.content).toContain("סיבת החיסור: התלמיד היה חולה, ההורה עדכן באיחור");
    expect(log.content).toContain("הכרעה: חיסור מוצדק, ללא שיעור השלמה");
    expect(log.content).toContain("הערות פנימיות: ההורה ביקש תזכורת יום לפני");
    expect(log.structuredData).toMatchObject({ source: "ABSENCE_RESOLUTION", absentLessonId: ABSENT_LESSON.id });

    expect(auditEntry().data).toMatchObject({
      action: "ABSENCE_RESOLVED",
      entityType: "Student",
      entityId: STUDENT.id,
      metadata: { resolutionType: "EXCUSED_NO_MAKEUP", makeupLessonId: null, studentStatus: ["STUDENT", "BOILING_160"] },
    });
    expect(db.lessonCreate).not.toHaveBeenCalled();
  });

  it("EXCUSED_MAKEUP opens a PENDING_SCHEDULE make-up lesson with the missed lesson's teacher", async () => {
    const res = await resolveRequest({ ...VALID_RESOLUTION, resolutionType: "EXCUSED_MAKEUP" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, absenceResolved: true, makeupLessonCreated: true, makeupLessonId: "lesson-makeup" });
    expect(db.lessonCreate).toHaveBeenCalledTimes(1);
    expect(db.lessonCreate.mock.calls[0][0].data).toEqual({
      studentId: STUDENT.id,
      teacherId: TEACHER.id,
      title: "מתמטיקה 5 יח״ל · שיעור השלמה",
      scheduledAt: NOW,
      durationMinutes: 50,
      status: "PENDING_SCHEDULE",
      lessonType: "MAKEUP",
      whatsappGroupId: STUDENT.whatsappGroupId,
    });
    expect(logEntry().data.content).toContain("נפתח שיעור השלמה שממתין לשיבוץ מועד");
    expect(auditEntry().data.metadata).toMatchObject({ makeupLessonId: "lesson-makeup" });
  });

  it("UNEXCUSED_CLOSED keeps the absence unexcused but still closes the follow-up", async () => {
    const body = await (await resolveRequest({ ...VALID_RESOLUTION, resolutionType: "UNEXCUSED_CLOSED" })).json();
    expect(body).toMatchObject({ makeupLessonCreated: false, studentStatus: ["STUDENT", "BOILING_160"] });
    expect(logEntry().data.content).toContain("הכרעה: חיסור לא מוצדק, הטיפול נסגר");
    expect(db.lessonCreate).not.toHaveBeenCalled();
  });

  it.each(["REPRESENTATIVE", "ADMIN"])("%s may close a follow-up", async (role) => {
    session.getCurrentUser.mockResolvedValue(staff(role));
    expect((await resolveRequest(VALID_RESOLUTION)).status).toBe(200);
  });

  it("answers 409 when the student has no open absence", async () => {
    db.profileFindUnique.mockResolvedValue({ studentStatus: ["STUDENT"] });
    const res = await resolveRequest({ ...VALID_RESOLUTION, resolutionType: "EXCUSED_MAKEUP" });
    expect(res.status).toBe(409);
    expect(db.lessonCreate).not.toHaveBeenCalled();
    expect(db.logCreate).not.toHaveBeenCalled();
    expect(db.auditCreate).not.toHaveBeenCalled();
  });

  it("answers 409 when a parallel request already closed the same absence", async () => {
    db.profileUpdateMany.mockResolvedValue({ count: 0 });
    const res = await resolveRequest({ ...VALID_RESOLUTION, resolutionType: "EXCUSED_MAKEUP" });
    expect(res.status).toBe(409);
    expect(db.lessonCreate).not.toHaveBeenCalled();
  });

  it("answers 422 for a make-up when no lesson was marked absent, and 404 for a foreign lesson id", async () => {
    db.lessonFindFirst.mockResolvedValue(null);
    expect((await resolveRequest({ ...VALID_RESOLUTION, resolutionType: "EXCUSED_MAKEUP" })).status).toBe(422);
    expect((await resolveRequest({ ...VALID_RESOLUTION, lessonId: "someone-elses-lesson" })).status).toBe(404);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("the modal's submit reaches the real route", async () => {
    const routeFetch = vi.fn(async (url: string, init: RequestInit) =>
      resolveAbsence(new Request(`https://p100.example${url}`, init), { params: Promise.resolve({ id: STUDENT.id }) })
    );
    const result = await submitAbsenceResolution(
      { studentId: STUDENT.id, reason: "שכחה", resolutionType: "EXCUSED_MAKEUP", notes: null, lessonId: ABSENT_LESSON.id },
      routeFetch as unknown as typeof fetch
    );
    expect(routeFetch.mock.calls[0][0]).toBe(`/api/portal/students/${STUDENT.id}/resolve-absence`);
    expect(result).toMatchObject({ makeupLessonCreated: true });

    db.profileFindUnique.mockResolvedValue({ studentStatus: [] });
    await expect(
      submitAbsenceResolution(
        { studentId: STUDENT.id, reason: "שכחה", resolutionType: "UNEXCUSED_CLOSED", notes: null },
        routeFetch as unknown as typeof fetch
      )
    ).rejects.toThrow("לתלמיד אין חיסור פתוח לבירור");
  });

  it("status helpers only touch the absence flag", () => {
    expect(clearUnexcusedAbsence(["UNEXCUSED_ABSENCE", "STUDENT", "LEGACY"])).toEqual(["STUDENT"]);
    expect(hasOpenAbsence(["STUDENT", "UNEXCUSED_ABSENCE"])).toBe(true);
    expect(hasOpenAbsence(["STUDENT"])).toBe(false);
    expect(makeupLessonTitle("פיזיקה · שיעור השלמה")).toBe("פיזיקה · שיעור השלמה");
    expect(makeupLessonTitle(null)).toBe("שיעור פרטי · שיעור השלמה");
  });
});

describe("make-up lesson follow-through", () => {
  it("completing a make-up lesson does not take a second credit from the package", async () => {
    db.lessonFindUnique.mockResolvedValue({
      id: "lesson-makeup",
      studentId: STUDENT.id,
      teacherId: TEACHER.id,
      status: "SCHEDULED",
      title: "מתמטיקה 5 יח״ל · שיעור השלמה",
      scheduledAt: new Date("2026-09-30T10:00:00.000Z"),
      startTime: null,
      durationMinutes: 50,
      dailyRoomUrl: null,
      whatsappGroupId: null,
      lessonType: "MAKEUP",
    });
    db.logFindMany.mockResolvedValue([
      {
        id: "log-pkg",
        createdAt: new Date("2026-09-20T10:00:00Z"),
        structuredData: { source: "DIRECT_PACKAGE", package: { packageCode: "PACK_10", credits: 10, subject: "מתמטיקה" } },
      },
    ]);

    const res = await completeLesson(
      jsonRequest("https://p100.example/x", { attendanceStatus: "ATTENDED" }),
      { params: Promise.resolve({ id: STUDENT.id, meetingId: "lesson-makeup" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, teacherCompensated: true, creditCharged: false });
    expect(db.userUpdateMany).not.toHaveBeenCalled();
    expect(logEntry().data.content).toContain("שיעור השלמה: לא ירד מיתרת החבילה");
  });

  it("the quad group hears about a make-up, not a private lesson, when it is scheduled", () => {
    const message = buildPrivateLessonScheduledMessage({
      subject: "מתמטיקה 5 יח״ל · שיעור השלמה",
      scheduledAt: new Date("2026-10-04T14:00:00.000Z"),
      durationMinutes: 50,
      teacherName: TEACHER.name,
      makeup: true,
    });
    expect(message).toContain("📌 *שיבוץ שיעור השלמה - Project 100*");
    expect(message).toContain("נקבע שיעור השלמה בנושא");
    expect(message).not.toContain("(ש.פ)");
  });
});

type LessonFixture = Parameters<typeof buildMeetingRows>[0][number];

function lesson(id: string, overrides: Partial<LessonFixture>): LessonFixture {
  return {
    id,
    title: "מתמטיקה",
    scheduledAt: MISSED_AT,
    startTime: null,
    endTime: null,
    durationMinutes: 50,
    status: "COMPLETED",
    teacherId: TEACHER.id,
    studentId: STUDENT.id,
    packageId: null,
    attendanceStatus: "PRESENT",
    lessonType: "REGULAR",
    whatsappGroupId: null,
    rescheduledCount: 0,
    teacher: { name: TEACHER.name },
    package: null,
    ...overrides,
  };
}

describe("attendance metrics on the meetings tab", () => {
  it("counts attended, no-show and cancelled lessons and the attendance rate", () => {
    const lessons = [
      ...Array.from({ length: 11 }, () => ({ status: "COMPLETED", attendanceStatus: "PRESENT" as const })),
      { status: "COMPLETED", attendanceStatus: "ABSENT" as const },
      { status: "CANCELLED", attendanceStatus: null },
      { status: "CANCELLED_LATE", attendanceStatus: "ABSENT" as const },
      { status: "SCHEDULED", attendanceStatus: null },
      { status: "PENDING_SCHEDULE", attendanceStatus: null },
    ];
    expect(attendanceMetrics(lessons)).toEqual({ attended: 11, noShow: 1, cancelled: 2, attendanceRate: 92 });
  });

  it("counts a legacy completed lesson without a mark as attended and has no rate before any lesson", () => {
    expect(attendanceMetrics([{ status: "COMPLETED", attendanceStatus: null }])).toMatchObject({ attended: 1, attendanceRate: 100 });
    expect(attendanceMetrics([{ status: "SCHEDULED", attendanceStatus: null }])).toEqual({
      attended: 0,
      noShow: 0,
      cancelled: 0,
      attendanceRate: null,
    });
  });

  const meetings = () =>
    buildMeetingRows(
      [
        lesson("l-1", {}),
        lesson("l-2", {}),
        lesson("l-3", { attendanceStatus: "ABSENT" }),
        lesson("l-4", { status: "CANCELLED", attendanceStatus: null }),
        lesson("l-5", { status: "PENDING_SCHEDULE", attendanceStatus: null, lessonType: "MAKEUP", title: "מתמטיקה · שיעור השלמה" }),
      ],
      { id: "user-manager", role: "MANAGER" },
      NOW
    );

  const renderTab = (props: Partial<Parameters<typeof MeetingsTab>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(MeetingsTab, { studentId: STUDENT.id, meetings: meetings(), canSchedule: true, ...props })
    );

  it("renders the summary bar with the computed values", () => {
    const html = renderTab();
    expect(html).toContain("מדדי נוכחות");
    expect(html).toContain("שיעורים שהתקיימו");
    expect(html).toContain("חיסורים (אי-הופעה)");
    expect(html).toContain("שיעורים שבוטלו");
    expect(html).toContain("67%");
    expect(html).not.toContain("לתלמיד זה רשום חיסור לא מוצדק");
  });

  it("flags a make-up row and shows the absence banner with the follow-up button to staff", () => {
    const rows = meetings();
    expect(rows.find((m) => m.id === "l-5")?.isMakeup).toBe(true);
    expect(rows.find((m) => m.id === "l-1")?.isMakeup).toBe(false);

    const html = renderTab({ studentStatus: ["STUDENT", "UNEXCUSED_ABSENCE"], canResolveAbsence: true });
    expect(html).toContain("לתלמיד זה רשום חיסור לא מוצדק הממתין לבירור");
    expect(html).toContain("טפל בחיסור");
    expect(html).toContain("שיעור השלמה");

    const teacherView = renderTab({ studentStatus: ["UNEXCUSED_ABSENCE"], canResolveAbsence: false, canSchedule: false });
    expect(teacherView).toContain("לתלמיד זה רשום חיסור לא מוצדק הממתין לבירור");
    expect(teacherView).not.toContain("טפל בחיסור");
  });
});

describe("student directory — unexcused absence quick filter", () => {
  const query = (overrides: Partial<StudentDirectoryQuery> = {}): StudentDirectoryQuery => ({
    search: "",
    searchTokens: [],
    statuses: [],
    grade: null,
    page: 1,
    limit: 25,
    ...overrides,
  });

  const flaggedWhere = (where: unknown) => JSON.stringify(where).includes('"hasSome":["UNEXCUSED_ABSENCE"]');

  beforeEach(() => {
    db.userCount.mockImplementation(async ({ where }: { where: unknown }) => (flaggedWhere(where) ? 3 : 10));
    db.userFindMany.mockResolvedValue([]);
    db.lessonFindMany.mockResolvedValue([]);
  });

  it("accepts the chip's status as a code or a label", () => {
    const byCode = parseStudentDirectoryQuery(new URLSearchParams("status=UNEXCUSED_ABSENCE"));
    const byLabel = parseStudentDirectoryQuery(new URLSearchParams(`status=${encodeURIComponent("חיסור לא מוצדק")}`));
    expect(byCode).toMatchObject({ ok: true, data: { statuses: ["UNEXCUSED_ABSENCE"] } });
    expect(byLabel).toMatchObject({ ok: true, data: { statuses: ["UNEXCUSED_ABSENCE"] } });
  });

  it("returns the number of flagged students, independent of the current search", async () => {
    const page = await listStudentDirectory(
      { id: "rep-1", role: "REPRESENTATIVE" },
      query({ search: "נועה", searchTokens: ["נועה"] }),
      NOW
    );
    expect(page.unexcusedAbsenceCount).toBe(3);
    const absenceCall = db.userCount.mock.calls.map(([args]) => args.where).find(flaggedWhere);
    expect(JSON.stringify(absenceCall)).not.toContain("נועה");
  });

  it("keeps the count inside a teacher's own students", async () => {
    await listStudentDirectory({ id: TEACHER.id, role: "TEACHER" }, query(), NOW);
    const absenceCall = db.userCount.mock.calls.map(([args]) => args.where).find(flaggedWhere);
    expect(JSON.stringify(absenceCall)).toContain(`"takenLessons":{"some":{"teacherId":"${TEACHER.id}"}}`);
  });

  it("renders the amber chip, pressed when the filter is active", () => {
    const html = renderToStaticMarkup(
      createElement(StudentDirectory, {
        initialSearch: "",
        initialStatus: "UNEXCUSED_ABSENCE",
        initialGrade: null,
        initialPage: 1,
        isTeacher: false,
      })
    );
    expect(html).toMatch(/aria-pressed="true"[^>]*title="תלמידים עם חיסור שממתין לשיחת בירור"/);
    expect(html).toContain("חיסור לא מוצדק");
    expect(html).toContain("bg-amber-600");
  });
});
