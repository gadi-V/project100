import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  userUpdate: vi.fn(),
  lessonFindFirst: vi.fn(),
  lessonCreateMany: vi.fn(),
  logCreate: vi.fn(),
  logFindMany: vi.fn(),
  logFindFirst: vi.fn(),
  profileFindUnique: vi.fn(),
  profileUpsert: vi.fn(),
  intakeFindFirst: vi.fn(),
  diagnosticFindFirst: vi.fn(),
  transaction: vi.fn(),
}));
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: db.userFindUnique, findMany: db.userFindMany, update: db.userUpdate },
    lesson: { findFirst: db.lessonFindFirst, createMany: db.lessonCreateMany },
    studentCommunicationLog: { create: db.logCreate, findMany: db.logFindMany, findFirst: db.logFindFirst },
    studentProfile: { findUnique: db.profileFindUnique, upsert: db.profileUpsert },
    intakeAssessment: { findFirst: db.intakeFindFirst },
    diagnosticQuiz: { findFirst: db.diagnosticFindFirst },
    $transaction: db.transaction,
  },
}));
vi.mock("../lib/session", () => session);
vi.mock("../lib/audit", () => audit);
vi.mock("../lib/whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/whatsapp")>();
  return { ...actual, sendQuadGroupPedagogicDecision: vi.fn(actual.sendQuadGroupPedagogicDecision) };
});

import {
  GET as getOverview,
  POST as postDecision,
} from "../app/api/portal/students/[id]/pedagogic-decision/route";
import { POST as postPackage } from "../app/api/portal/students/[id]/direct-package/route";
import * as whatsapp from "../lib/whatsapp";
import { parseTemplateContent } from "../lib/communication-templates";
import { loadEnrollmentPlans } from "../lib/student-portal";
import { activateStudentStatuses } from "../lib/student-portal-shared";
import {
  buildRecurringOccurrences,
  parsePedagogicDecisionInput,
  readDecisionRecord,
} from "../lib/pedagogic-decision";

type FetchMock = ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>;

const GATEWAY = "https://wa-gateway.example.test";
const GROUP_ID = "120363025555555555@g.us";
/** Tuesday 29.09.2026, 22:00 Israel time. */
const NOW = new Date("2026-09-29T19:00:00.000Z");

const STUDENT = {
  id: "stu-1",
  name: "מתן קולמן",
  role: "STUDENT",
  whatsappGroupId: GROUP_ID as string | null,
  lessonCredits: 0,
};
const TEACHER = { id: "teacher-1", name: "רונית לוי", role: "TEACHER", isApproved: true };
const PENDING_TEACHER = { id: "teacher-2", name: "מורה בהמתנה", role: "TEACHER", isApproved: false };

const tx = {
  lesson: { findFirst: db.lessonFindFirst, createMany: db.lessonCreateMany },
  studentCommunicationLog: { create: db.logCreate },
  studentProfile: { findUnique: db.profileFindUnique, upsert: db.profileUpsert },
  user: { update: db.userUpdate },
};

function staff(role: string) {
  return { id: `user-${role.toLowerCase()}`, name: "נועה המנהלת", role, lessonCredits: 0, isApproved: true };
}

function context(id = STUDENT.id) {
  return { params: Promise.resolve({ id }) };
}

function jsonRequest(path: string, body: unknown) {
  return new Request(`https://project100.example/api/portal/students/${STUDENT.id}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const decisionBody = (overrides: Record<string, unknown> = {}) => ({
  background: "תלמיד כיתה י׳, עבר מיפוי מוצלח",
  personalNotes: "צריך חיזוקים חיוביים",
  learningNotes: "פערים בטריגונומטריה",
  mainGoal: "להגיע ל-90 בבגרות 5 יח״ל",
  parentType: "מעורב",
  subscriptionType: "WEEKLY",
  extraPrivateLessons: 0,
  professionalManagerInvolved: false,
  teacherId: TEACHER.id,
  subject: "מתמטיקה 5 יח״ל",
  slots: [{ weekday: 1, time: "17:00" }],
  startDate: "2026-10-04",
  ...overrides,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubGateway(sendResponse: () => Promise<Response> = async () => json({ idMessage: "msg-1" })): FetchMock {
  const fetchMock: FetchMock = vi.fn(async (url: string) => {
    if (url === `${GATEWAY}/sendMessage`) return sendResponse();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentMessages(fetchMock: FetchMock) {
  return fetchMock.mock.calls
    .filter(([url]) => url === `${GATEWAY}/sendMessage`)
    .map(([, init]) => JSON.parse(String(init.body)) as { chatId: string; message: string });
}

type LessonRow = { status: string; scheduledAt: Date; studentId: string; teacherId: string; whatsappGroupId: string | null };

function createdLessons(): LessonRow[] {
  return (db.lessonCreateMany.mock.calls[0]?.[0] as { data: LessonRow[] } | undefined)?.data ?? [];
}

function auditCall(action: string) {
  return audit.writeAuditLog.mock.calls
    .map(([entry]) => entry as { action: string; entityType: string; entityId: string; metadata: Record<string, unknown> })
    .find((entry) => entry.action === action);
}

function withStudent(overrides: Partial<typeof STUDENT> = {}) {
  const student = { ...STUDENT, ...overrides };
  db.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === student.id) return student;
    if (where.id === TEACHER.id) return TEACHER;
    if (where.id === PENDING_TEACHER.id) return PENDING_TEACHER;
    return null;
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("WHATSAPP_API_URL", GATEWAY);
  vi.stubEnv("WHATSAPP_API_KEY", "wa-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  session.getCurrentUser.mockResolvedValue(staff("MANAGER"));
  withStudent();
  db.transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  db.lessonFindFirst.mockResolvedValue(null);
  db.lessonCreateMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  db.logCreate.mockResolvedValue({ id: "log-1" });
  db.profileFindUnique.mockResolvedValue({ studentStatus: ["MAPPING_FAILED", "CALL_BACK_PARENT", "BOILING_160"] });
  db.profileUpsert.mockResolvedValue({});
  db.userUpdate.mockResolvedValue({ lessonCredits: 10 });
  audit.writeAuditLog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("pedagogic decision — summary, monthly lesson batch and WhatsApp", () => {
  it("records the post-mapping summary, creates 4 weekly lessons and posts the plan to the quad group", async () => {
    const fetchMock = stubGateway();

    const res = await postDecision(jsonRequest("pedagogic-decision", decisionBody()), context());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      success: true,
      whatsappDispatched: true,
      data: {
        logId: "log-1",
        subscriptionType: "WEEKLY",
        teacherName: TEACHER.name,
        lessonsCreated: 4,
        pendingPrivateLessons: 0,
        firstLessonAt: "2026-10-05T14:00:00.000Z",
        studentStatus: ["STUDENT", "BOILING_160"],
      },
    });

    const log = db.logCreate.mock.calls[0][0].data;
    expect(log).toMatchObject({
      studentId: STUDENT.id,
      authorId: "user-manager",
      authorRole: "PEDAGOGIC_MANAGER",
      type: "POST_MAPPING_CALL",
      courseContext: "מתמטיקה 5 יח״ל",
    });
    expect(log.structuredData).toMatchObject({
      template: "POST_MAPPING_CALL",
      source: "PEDAGOGIC_DECISION",
      fields: {
        background: "תלמיד כיתה י׳, עבר מיפוי מוצלח",
        personalNotes: "צריך חיזוקים חיוביים",
        learningNotes: "פערים בטריגונומטריה",
        mainGoal: "להגיע ל-90 בבגרות 5 יח״ל",
        parentType: "מעורב",
        subscriptionType: "חד שבועי",
        professionalManagerInvolvement: "לא",
        schedule: "יום שני 17:00",
        extraPrivateLessons: "אין",
      },
      decision: { teacherId: TEACHER.id, teacherName: TEACHER.name, startDate: "2026-10-04", lessonsCreated: 4 },
    });

    const lessons = createdLessons();
    expect(lessons).toHaveLength(4);
    expect(lessons.map((l) => l.scheduledAt.toISOString())).toEqual([
      "2026-10-05T14:00:00.000Z",
      "2026-10-12T14:00:00.000Z",
      "2026-10-19T14:00:00.000Z",
      // Israel is back on winter time (UTC+2) after 25.10.2026.
      "2026-10-26T15:00:00.000Z",
    ]);
    for (const lesson of lessons) {
      expect(lesson).toMatchObject({
        studentId: STUDENT.id,
        teacherId: TEACHER.id,
        status: "SCHEDULED",
        lessonType: "REGULAR",
        durationMinutes: 50,
        whatsappGroupId: GROUP_ID,
      });
    }

    const messages = sentMessages(fetchMock);
    expect(messages).toHaveLength(1);
    expect(messages[0].chatId).toBe(GROUP_ID);
    expect(messages[0].message).toBe(
      "שלום לכולם, כאן המנהל הפדגוגי של Project 100 🎓\n" +
        "לאחר מעבר על שיעור המיפוי והשאלונים, נקבעה תוכנית הלמידה האישית:\n" +
        "📌 *מסלול:* חד שבועי\n" +
        "👨‍🏫 *מורה קבוע:* רונית לוי\n" +
        "⏰ *מועדים קבועים:* יום שני 17:00\n\n" +
        "לוח השיעורים שובץ במערכת ופתוח לצפייה בפורטל. שיהיה המון בהצלחה! 🚀"
    );

    expect(auditCall("PEDAGOGIC_DECISION_RECORDED")).toMatchObject({
      entityType: "StudentCommunicationLog",
      entityId: "log-1",
      metadata: { studentId: STUDENT.id, lessonsCreated: 4, whatsappDispatched: true },
    });
  });

  it("creates 8 lessons for a twice-weekly subscription plus PENDING_SCHEDULE private lessons", async () => {
    const fetchMock = stubGateway();

    const res = await postDecision(
      jsonRequest(
        "pedagogic-decision",
        decisionBody({
          subscriptionType: "TWICE_WEEKLY",
          extraPrivateLessons: 2,
          slots: [
            { weekday: 4, time: "18:30" },
            { weekday: 1, time: "17:00" },
          ],
        })
      ),
      context()
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ data: { lessonsCreated: 8, pendingPrivateLessons: 2 } });

    const lessons = createdLessons();
    const scheduled = lessons.filter((l) => l.status === "SCHEDULED");
    const pending = lessons.filter((l) => l.status === "PENDING_SCHEDULE");
    expect(scheduled).toHaveLength(8);
    expect(pending).toHaveLength(2);
    expect(scheduled.map((l) => l.scheduledAt.toISOString()).slice(0, 2)).toEqual([
      "2026-10-05T14:00:00.000Z",
      "2026-10-08T15:30:00.000Z",
    ]);
    expect(pending.every((l) => l.teacherId === TEACHER.id && l.whatsappGroupId === GROUP_ID)).toBe(true);

    expect(sentMessages(fetchMock)[0].message).toContain("📌 *מסלול:* דו שבועי");
    expect(sentMessages(fetchMock)[0].message).toContain("⏰ *מועדים קבועים:* יום שני 17:00, יום חמישי 18:30");
  });

  it("marks the student active: adds 'תלמיד' and removes 'מיפוי נכשל' / 'לחזור להורה'", async () => {
    stubGateway();

    await postDecision(jsonRequest("pedagogic-decision", decisionBody()), context());

    expect(db.profileUpsert).toHaveBeenCalledWith({
      where: { userId: STUDENT.id },
      create: expect.objectContaining({ userId: STUDENT.id, studentStatus: ["STUDENT", "BOILING_160"] }),
      update: expect.objectContaining({ studentStatus: ["STUDENT", "BOILING_160"], statusUpdatedById: "user-manager" }),
    });
  });

  it("stores content that reads back as a valid 'סיכום שיחה לאחר מיפוי' template", async () => {
    stubGateway();

    await postDecision(jsonRequest("pedagogic-decision", decisionBody({ professionalManagerInvolved: true })), context());

    const { content, structuredData } = db.logCreate.mock.calls[0][0].data;
    const parsed = parseTemplateContent("POST_MAPPING_CALL", content);
    expect(parsed).toMatchObject({
      ok: true,
      structuredData: {
        fields: {
          mainGoal: "להגיע ל-90 בבגרות 5 יח״ל",
          parentType: "מעורב",
          subscriptionType: "חד שבועי",
          professionalManagerInvolvement: "כן",
          extraPrivateLessons: "אין",
        },
      },
    });
    expect(content).toContain("מורה קבוע: רונית לוי");
    expect(readDecisionRecord(structuredData)).toMatchObject({ subscriptionType: "WEEKLY", lessonsCreated: 4 });
  });

  it("saves the decision without a WhatsApp post when the student has no quad group", async () => {
    withStudent({ whatsappGroupId: null });
    const fetchMock = stubGateway();

    const res = await postDecision(jsonRequest("pedagogic-decision", decisionBody()), context());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ success: true, whatsappDispatched: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createdLessons().every((l) => l.whatsappGroupId === null)).toBe(true);
  });

  it("refuses the batch with 409 when a generated slot collides, and creates nothing", async () => {
    db.lessonFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ scheduledAt: new Date("2026-10-12T14:30:00.000Z") });
    const fetchMock = stubGateway();

    const res = await postDecision(jsonRequest("pedagogic-decision", decisionBody()), context());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("המורה כבר משובץ");
    expect(db.lessonCreateMany).not.toHaveBeenCalled();
    expect(db.logCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const teacherCheck = db.lessonFindFirst.mock.calls[1][0].where;
    expect(teacherCheck).toMatchObject({ teacherId: TEACHER.id, status: { in: ["SCHEDULED", "IN_PROGRESS"] } });
    expect(teacherCheck.OR).toHaveLength(4);
  });

  it.each([
    ["two slots on a weekly subscription", { slots: [{ weekday: 1, time: "17:00" }, { weekday: 3, time: "17:00" }] }],
    ["one slot on a twice-weekly subscription", { subscriptionType: "TWICE_WEEKLY" }],
    [
      "two slots on the same weekday",
      { subscriptionType: "TWICE_WEEKLY", slots: [{ weekday: 1, time: "17:00" }, { weekday: 1, time: "19:00" }] },
    ],
    ["a start date in the past", { startDate: "2026-09-01" }],
    ["a missing main goal", { mainGoal: "  " }],
    ["an unknown parent type", { parentType: "שקט" }],
    ["three extra private lessons", { extraPrivateLessons: 3 }],
    ["an invalid time", { slots: [{ weekday: 1, time: "25:00" }] }],
  ])("returns 400 for %s", async (_label, overrides) => {
    const res = await postDecision(jsonRequest("pedagogic-decision", decisionBody(overrides)), context());
    expect(res.status).toBe(400);
    expect(db.lessonCreateMany).not.toHaveBeenCalled();
  });

  it("returns 404 for a teacher who is not approved", async () => {
    const res = await postDecision(
      jsonRequest("pedagogic-decision", decisionBody({ teacherId: PENDING_TEACHER.id })),
      context()
    );
    expect(res.status).toBe(404);
    expect(db.lessonCreateMany).not.toHaveBeenCalled();
  });
});

describe("pedagogic decision — 360° overview", () => {
  it("combines the intake call, questionnaires and the mapping teacher's summary", async () => {
    db.intakeFindFirst.mockResolvedValue({
      createdAt: new Date("2026-09-10T09:00:00Z"),
      representative: { name: "שירה הנציגה" },
      grade: "י׳",
      levelUnits: "5 יח״ל",
      representativeNotes: "הורה מאוד מעורב",
      lastExamScore: 72,
      nextExamDate: new Date("2026-12-01T00:00:00Z"),
      strongTopic: "אלגברה",
      weakTopic: "טריגונומטריה",
      mainGoals: "להתקבל לעתודה",
      firstMonthTarget: "לסגור פערים",
      classListening: "בינונית",
      focusRequest: null,
      studentImportantNotes: null,
      parentMainGoalYear: "90 בבגרות",
      parentTargetScore: 90,
      parentAverageScore: 75,
      motivationLevel: "גבוהה",
      successDefinition: "ביטחון עצמי",
      homeStudyTime: "שעה ביום",
      learningDisabilities: null,
      emotionalDifficulties: "לחץ מבחנים",
      parentInvolvementLevel: 4,
      parentImportantNotes: null,
    });
    db.diagnosticFindFirst.mockResolvedValue(null);
    db.logFindFirst.mockResolvedValue({
      createdAt: new Date("2026-09-20T15:00:00Z"),
      authorName: "רונית לוי",
      structuredData: {
        template: "MAPPING_SUMMARY",
        fields: {
          topicRanking: [
            { rank: 1, topic: "טריגונומטריה", score: 40 },
            { rank: 2, topic: "הסתברות", score: 60 },
            { rank: 3, topic: "אלגברה", score: 85 },
            { rank: 4, topic: "גאומטריה", score: 70 },
          ],
          classLearning: "בינונית",
          homeLearning: "רק לפני מבחן",
          motivation: "גבוהה",
          personalConnection: "גבוה",
          formatFit: "ש.פ במקביל",
          subscriptionRecommendation: "דו שבועי",
          mainGoal: "90 בבגרות",
          lastSchoolScore: 72,
        },
      },
    });
    db.lessonFindFirst.mockResolvedValue({
      teacherId: TEACHER.id,
      title: "מתמטיקה 5 יח״ל",
      scheduledAt: new Date("2026-09-20T14:00:00Z"),
      teacher: { name: TEACHER.name },
    });
    db.userFindMany.mockResolvedValue([{ id: TEACHER.id, name: TEACHER.name }]);

    const res = await getOverview(new Request("https://project100.example/x"), context());

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.intake).toMatchObject({
      representativeName: "שירה הנציגה",
      student: { lastExamScore: 72, mainGoals: "להתקבל לעתודה", weakTopic: "טריגונומטריה" },
      parent: { mainGoalYear: "90 בבגרות", emotionalDifficulties: "לחץ מבחנים" },
    });
    expect(data.mapping.topicRanking).toHaveLength(4);
    expect(data.mapping).toMatchObject({
      teacherName: TEACHER.name,
      classLearning: "בינונית",
      homeLearning: "רק לפני מבחן",
      motivation: "גבוהה",
      personalConnection: "גבוה",
      formatFit: "ש.פ במקביל",
      subscriptionRecommendation: "דו שבועי",
    });
    expect(data.mappingLesson).toMatchObject({ teacherId: TEACHER.id, subject: "מתמטיקה 5 יח״ל" });
    expect(data.teachers).toEqual([{ id: TEACHER.id, name: TEACHER.name }]);
    expect(data.hasWhatsappGroup).toBe(true);
  });
});

describe("direct package track", () => {
  it("adds the package lessons and the 'תלמיד' status with no mapping lesson required", async () => {
    session.getCurrentUser.mockResolvedValue(staff("REPRESENTATIVE"));
    const fetchMock = stubGateway();

    const res = await postPackage(
      jsonRequest("direct-package", { packageCode: "PACK_10", subject: "אינפי 1", preferredTeacherId: TEACHER.id }),
      context()
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      success: true,
      data: {
        logId: "log-1",
        packageName: "חבילת 10 שיעורים",
        creditsAdded: 10,
        lessonCredits: 10,
        studentStatus: ["STUDENT", "BOILING_160"],
      },
    });
    expect(db.userUpdate).toHaveBeenCalledWith({
      where: { id: STUDENT.id },
      data: { lessonCredits: { increment: 10 } },
      select: { lessonCredits: true },
    });
    expect(db.logCreate.mock.calls[0][0].data).toMatchObject({
      type: "GENERAL",
      authorRole: "REPRESENTATIVE",
      courseContext: "אינפי 1",
      structuredData: {
        source: "DIRECT_PACKAGE",
        package: { packageCode: "PACK_10", credits: 10, subject: "אינפי 1", preferredTeacherName: TEACHER.name },
      },
    });
    expect(auditCall("DIRECT_PACKAGE_ASSIGNED")).toMatchObject({
      entityType: "User",
      entityId: STUDENT.id,
      metadata: { packageCode: "PACK_10", creditsAdded: 10, lessonCredits: 10, preferredTeacherId: TEACHER.id },
    });

    expect(db.lessonFindFirst).not.toHaveBeenCalled();
    expect(db.lessonCreateMany).not.toHaveBeenCalled();
    expect(db.intakeFindFirst).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("works without a preferred teacher", async () => {
    const res = await postPackage(jsonRequest("direct-package", { packageCode: "EXAM_MARATHON", subject: "פיזיקה" }), context());
    expect(res.status).toBe(201);
    expect(db.userUpdate.mock.calls[0][0].data).toEqual({ lessonCredits: { increment: 8 } });
  });

  it("returns 400 for an unknown package and 404 for an inactive preferred teacher", async () => {
    const unknown = await postPackage(jsonRequest("direct-package", { packageCode: "PACK_99", subject: "פיזיקה" }), context());
    expect(unknown.status).toBe(400);

    const inactive = await postPackage(
      jsonRequest("direct-package", { packageCode: "PACK_5", subject: "פיזיקה", preferredTeacherId: PENDING_TEACHER.id }),
      context()
    );
    expect(inactive.status).toBe(404);
    expect(db.userUpdate).not.toHaveBeenCalled();
  });

  it("lists subscriptions and packages separately on the courses tab", async () => {
    db.logFindMany.mockResolvedValue([
      {
        id: "log-pkg",
        createdAt: new Date("2026-09-25T10:00:00Z"),
        structuredData: {
          source: "DIRECT_PACKAGE",
          package: { packageCode: "PACK_5", credits: 5, subject: "פיזיקה", preferredTeacherName: null },
        },
      },
      {
        id: "log-decision",
        createdAt: new Date("2026-09-24T10:00:00Z"),
        structuredData: {
          template: "POST_MAPPING_CALL",
          source: "PEDAGOGIC_DECISION",
          fields: {},
          decision: {
            subscriptionType: "TWICE_WEEKLY",
            teacherId: TEACHER.id,
            teacherName: TEACHER.name,
            subject: "מתמטיקה",
            slots: [
              { weekday: 1, time: "17:00" },
              { weekday: 4, time: "18:00" },
            ],
            startDate: "2026-10-04",
            extraPrivateLessons: 1,
            lessonsCreated: 8,
          },
        },
      },
      { id: "log-typed", createdAt: new Date("2026-09-23T10:00:00Z"), structuredData: { template: "POST_MAPPING_CALL", fields: {} } },
    ]);

    const plans = await loadEnrollmentPlans(STUDENT.id, 13);

    expect(plans.lessonCredits).toBe(13);
    expect(plans.subscriptions).toEqual([
      expect.objectContaining({ id: "log-decision", subscriptionType: "TWICE_WEEKLY", lessonsCreated: 8, extraPrivateLessons: 1 }),
    ]);
    expect(plans.packages).toEqual([
      expect.objectContaining({ id: "log-pkg", packageName: "חבילת 5 שיעורים", credits: 5, subject: "פיזיקה" }),
    ]);
  });
});

describe("security — only the pedagogic manager, admin and representative", () => {
  it.each(["TEACHER", "STUDENT"])("blocks a %s with 403 on the decision, the overview and the package", async (role) => {
    session.getCurrentUser.mockResolvedValue(staff(role));
    const fetchMock = stubGateway();

    const decision = await postDecision(jsonRequest("pedagogic-decision", decisionBody()), context());
    const overview = await getOverview(new Request("https://project100.example/x"), context());
    const pkg = await postPackage(jsonRequest("direct-package", { packageCode: "PACK_5", subject: "פיזיקה" }), context());

    expect([decision.status, overview.status, pkg.status]).toEqual([403, 403, 403]);
    expect(db.userFindUnique).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.lessonCreateMany).not.toHaveBeenCalled();
    expect(db.userUpdate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous caller with 401", async () => {
    session.getCurrentUser.mockResolvedValue(null);
    const decision = await postDecision(jsonRequest("pedagogic-decision", decisionBody()), context());
    const pkg = await postPackage(jsonRequest("direct-package", { packageCode: "PACK_5", subject: "פיזיקה" }), context());
    expect([decision.status, pkg.status]).toEqual([401, 401]);
  });

  it.each(["MANAGER", "ADMIN", "REPRESENTATIVE"])("lets a %s decide and assign packages", async (role) => {
    session.getCurrentUser.mockResolvedValue(staff(role));
    stubGateway();

    const decision = await postDecision(jsonRequest("pedagogic-decision", decisionBody()), context());
    const pkg = await postPackage(jsonRequest("direct-package", { packageCode: "PACK_5", subject: "פיזיקה" }), context());

    expect([decision.status, pkg.status]).toEqual([201, 201]);
  });

  it("answers 404 for an id that is not a student", async () => {
    const res = await postDecision(jsonRequest("pedagogic-decision", decisionBody()), context("nobody"));
    expect(res.status).toBe(404);
  });
});

describe("resilience — a WhatsApp failure never loses the decision", () => {
  it("keeps the lessons and the summary on a 503 gateway error", async () => {
    stubGateway(async () => new Response("service unavailable", { status: 503 }));

    const res = await postDecision(jsonRequest("pedagogic-decision", decisionBody()), context());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ success: true, whatsappDispatched: false, data: { lessonsCreated: 4 } });
    expect(db.logCreate).toHaveBeenCalledTimes(1);
    expect(createdLessons()).toHaveLength(4);
    expect(db.profileUpsert).toHaveBeenCalledTimes(1);
    expect(auditCall("PEDAGOGIC_DECISION_RECORDED")?.metadata).toMatchObject({ whatsappDispatched: false });
  });

  it("keeps the decision when the gateway is unreachable", async () => {
    stubGateway(async () => {
      throw new TypeError("fetch failed");
    });

    const res = await postDecision(jsonRequest("pedagogic-decision", decisionBody()), context());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ whatsappDispatched: false });
    expect(createdLessons()).toHaveLength(4);
  });

  it("keeps the decision if the WhatsApp step throws unexpectedly", async () => {
    stubGateway();
    vi.mocked(whatsapp.sendQuadGroupPedagogicDecision).mockRejectedValueOnce(new Error("boom"));

    const res = await postDecision(jsonRequest("pedagogic-decision", decisionBody()), context());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ success: true, whatsappDispatched: false });
    expect(db.logCreate).toHaveBeenCalledTimes(1);
  });

  it("reports whatsappDispatched: false when WhatsApp is not configured", async () => {
    vi.stubEnv("WHATSAPP_API_URL", "");
    const fetchMock = stubGateway();

    const res = await postDecision(jsonRequest("pedagogic-decision", decisionBody()), context());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ whatsappDispatched: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("activates a student and drops waiting and unknown statuses", () => {
    expect(activateStudentStatuses(["CALL_BACK_PARENT", "MAPPING_FAILED", "FLOWING_160", "LEGACY"])).toEqual([
      "STUDENT",
      "FLOWING_160",
    ]);
    expect(activateStudentStatuses([])).toEqual(["STUDENT"]);
  });

  it("starts each weekly slot on its first weekday on or after the start date", () => {
    const occurrences = buildRecurringOccurrences([{ weekday: 0, time: "10:00" }], "2026-10-04", 2);
    expect(occurrences.map((d) => d.toISOString())).toEqual(["2026-10-04T07:00:00.000Z", "2026-10-11T07:00:00.000Z"]);
  });

  it("rejects a start date whose first lesson is already over", () => {
    const parsed = parsePedagogicDecisionInput(
      decisionBody({ startDate: "2026-09-29", slots: [{ weekday: 2, time: "17:00" }] }),
      NOW
    );
    expect(parsed.ok).toBe(false);
  });
});
