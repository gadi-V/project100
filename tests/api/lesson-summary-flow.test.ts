import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
  lessonFindUnique: vi.fn(),
  lessonFindFirst: vi.fn(),
  lessonFindMany: vi.fn(),
  lessonUpdateMany: vi.fn(),
  referralFindFirst: vi.fn(),
  slotUpdateMany: vi.fn(),
  logCreate: vi.fn(),
  logFindMany: vi.fn(),
  payoutFindUnique: vi.fn(),
  payoutCreate: vi.fn(),
  ledgerCreate: vi.fn(),
  ledgerFindUnique: vi.fn(),
  auditCreate: vi.fn(),
  profileFindUnique: vi.fn(),
  profileUpsert: vi.fn(),
  transaction: vi.fn(),
}));
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
const daily = vi.hoisted(() => ({
  createDailyRoom: vi.fn(),
  deleteDailyRoom: vi.fn(),
  ensureDailyRoom: vi.fn(),
  generateDailyToken: vi.fn(),
  roomNameFromDailyUrl: vi.fn((url: string) => url.split("/").pop() ?? null),
  dailyRoomNameForLesson: vi.fn((id: string) => `lesson-${id}`),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findUnique: db.userFindUnique, update: db.userUpdate, updateMany: db.userUpdateMany },
    lesson: {
      findUnique: db.lessonFindUnique,
      findFirst: db.lessonFindFirst,
      findMany: db.lessonFindMany,
      updateMany: db.lessonUpdateMany,
    },
    teacherReferral: { findFirst: db.referralFindFirst },
    teacherAvailability: { updateMany: db.slotUpdateMany },
    studentCommunicationLog: { create: db.logCreate, findMany: db.logFindMany },
    $transaction: db.transaction,
  },
}));
vi.mock("../../lib/session", () => session);
vi.mock("../../lib/audit", () => audit);
vi.mock("../../lib/daily", () => daily);

import { GET as listCommunication } from "../../app/api/portal/students/[id]/communication/route";
import { POST as completeLesson } from "../../app/api/portal/students/[id]/meetings/[meetingId]/complete/route";
import { GET as listLessons } from "../../app/api/lessons/route";
import {
  lessonVisibleToStudent,
  parseCompleteLessonInput,
  parseLessonSummaryPayload,
} from "../../lib/lesson-completion";
import { buildQuadCommunicationSummaryMessage } from "../../lib/whatsapp";

const NOW = new Date("2026-09-29T19:00:00.000Z");
const STARTED_AT = new Date("2026-09-29T17:00:00.000Z");
const GATEWAY = "https://wa-gateway.example.test";
const GROUP_ID = "120363025555555555@g.us";
const BOARD_URL = "https://files.example/board.pdf";

const STUDENT = { id: "stu-1", name: "מתן קולמן", role: "STUDENT", whatsappGroupId: GROUP_ID, lessonCredits: 5 };
const TEACHER = { id: "teacher-1", name: "רונית לוי", role: "TEACHER", lessonCredits: 0, isApproved: true };

const LESSON = {
  id: "lesson-1",
  studentId: STUDENT.id,
  teacherId: TEACHER.id,
  status: "SCHEDULED",
  title: "מתמטיקה 5 יח״ל",
  scheduledAt: STARTED_AT,
  startTime: null,
  durationMinutes: 50,
  dailyRoomUrl: null,
  whatsappGroupId: GROUP_ID,
  lessonType: "REGULAR" as "REGULAR" | "MAPPING",
};

const tx = {
  lesson: { findFirst: db.lessonFindFirst, updateMany: db.lessonUpdateMany },
  user: { findUnique: db.userFindUnique, update: db.userUpdate, updateMany: db.userUpdateMany },
  teacherAvailability: { updateMany: db.slotUpdateMany },
  studentCommunicationLog: { create: db.logCreate },
  teacherPayout: { findUnique: db.payoutFindUnique, create: db.payoutCreate },
  billingLedger: { create: db.ledgerCreate, findUnique: db.ledgerFindUnique },
  auditLog: { create: db.auditCreate },
  studentProfile: { findUnique: db.profileFindUnique, upsert: db.profileUpsert },
};

const REGULAR_FIELDS = {
  workedOn: "משוואות ריבועיות",
  homework: "תרגילים 1-4",
  nextLesson: "פרבולות",
};

const MAPPING_FIELDS = {
  gradeAndGroup: "י׳ · 5 יח״ל",
  lastSchoolScore: 41,
  classLearning: "בינונית",
  homeLearning: "רק לפני מבחן",
  motivation: "גבוהה",
  personalConnection: "גבוה",
  topicRanking: [{ topic: "אלגברה", score: 85 }],
  mainGoal: "לעלות ל-90",
  startingLevel: "בינונית",
  formatFit: "לא מתאים",
  subscriptionRecommendation: "דו שבועי",
  additionalNotes: "הורה ביקש לא לשתף",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubGateway(send: () => Promise<Response> = async () => json({ idMessage: "msg-1" })) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === `${GATEWAY}/sendMessage`) return send();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentMessage(fetchMock: ReturnType<typeof stubGateway>): string {
  const init = fetchMock.mock.calls[0]?.[1];
  const body = JSON.parse(String(init?.body)) as { message?: string };
  return body.message ?? "";
}

function complete(body: unknown) {
  return completeLesson(
    new Request("https://project100.example/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: STUDENT.id, meetingId: LESSON.id }) }
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("WHATSAPP_API_URL", GATEWAY);
  vi.stubEnv("WHATSAPP_API_KEY", "wa-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  session.getCurrentUser.mockResolvedValue(TEACHER);
  db.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    return [STUDENT, TEACHER].find((user) => user.id === where.id) ?? null;
  });
  db.lessonFindUnique.mockResolvedValue(LESSON);
  db.lessonFindFirst.mockImplementation(async ({ where }: { where?: { teacherId?: string; status?: unknown } }) => {
    if (where?.status) return null;
    return where?.teacherId === TEACHER.id ? { id: "any-lesson" } : null;
  });
  db.lessonFindMany.mockResolvedValue([]);
  db.referralFindFirst.mockResolvedValue(null);
  db.transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  db.lessonUpdateMany.mockResolvedValue({ count: 1 });
  db.userUpdateMany.mockResolvedValue({ count: 1 });
  db.userUpdate.mockResolvedValue({ lessonCredits: 5 });
  db.slotUpdateMany.mockResolvedValue({ count: 0 });
  db.logCreate.mockResolvedValue({ id: "log-1", createdAt: NOW, courseContext: null, content: "" });
  db.logFindMany.mockResolvedValue([]);
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
  db.auditCreate.mockResolvedValue({ id: "audit-1" });
  db.profileFindUnique.mockResolvedValue(null);
  db.profileUpsert.mockResolvedValue({});
  daily.deleteDailyRoom.mockResolvedValue(undefined);
  audit.writeAuditLog.mockResolvedValue(undefined);
  stubGateway();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("structured summary validation", () => {
  it("requires workedOn on a regular lesson and the mapping required fields", () => {
    const regular = parseLessonSummaryPayload({
      template: "LESSON_SUMMARY",
      fields: { workedOn: "   ", homework: "", nextLesson: null },
    });
    expect(regular.ok).toBe(false);
    if (!regular.ok) expect(regular.errors).toContain("חסר: עבדנו על");

    const mapping = parseCompleteLessonInput({
      attendanceStatus: "ATTENDED",
      summaryData: {
        template: "MAPPING_SUMMARY",
        fields: { gradeAndGroup: "י׳", mainGoal: "", formatFit: "", subscriptionRecommendation: null },
      },
    });
    expect(mapping.ok).toBe(false);
    if (!mapping.ok) {
      expect(mapping.errors).toEqual(
        expect.arrayContaining(["חסר: מטרה מרכזית", "חסר: התאמה לפורמט", "חסר: המלצה למנוי"])
      );
    }

    const score = parseLessonSummaryPayload({
      template: "MAPPING_SUMMARY",
      fields: { ...MAPPING_FIELDS, lastSchoolScore: 140 },
    });
    expect(score.ok).toBe(false);
    if (!score.ok) expect(score.errors.some((error) => error.includes("0 ל-100"))).toBe(true);
  });

  it("accepts a complete regular summary and ignores one attached to a no-show", () => {
    const attended = parseCompleteLessonInput({
      attendanceStatus: "ATTENDED",
      internalNotes: "פנימי",
      summaryData: { template: "LESSON_SUMMARY", fields: REGULAR_FIELDS },
    });
    expect(attended.ok).toBe(true);
    if (attended.ok) {
      expect(attended.data.summaryData).toMatchObject({
        template: "LESSON_SUMMARY",
        fields: { workedOn: "משוואות ריבועיות", homework: "תרגילים 1-4", nextLesson: "פרבולות" },
      });
    }

    const noShow = parseCompleteLessonInput({
      attendanceStatus: "STUDENT_NO_SHOW",
      summaryData: { template: "LESSON_SUMMARY", fields: { workedOn: "" } },
    });
    expect(noShow.ok).toBe(true);
    if (noShow.ok) expect(noShow.data.summaryData).toBeUndefined();
  });
});

describe("POST complete — pedagogical log and WhatsApp", () => {
  it("stores the structured summary and sends the board link to the quad group", async () => {
    const fetchMock = stubGateway();
    const res = await complete({
      attendanceStatus: "ATTENDED",
      internalNotes: "הערה לצוות",
      boardPdfUrl: BOARD_URL,
      summaryData: { template: "LESSON_SUMMARY", fields: REGULAR_FIELDS },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, status: "COMPLETED", promptSummary: false, whatsappDispatched: true });
    expect(db.payoutCreate).toHaveBeenCalledTimes(1);
    expect(db.logCreate).toHaveBeenCalledTimes(2);

    const summary = db.logCreate.mock.calls[1]?.[0] as {
      data: { type: string; content: string; structuredData: { template: string; fields: Record<string, unknown> } };
    };
    expect(summary.data.type).toBe("LESSON_SUMMARY");
    expect(summary.data.content).toContain("עבדנו על: משוואות ריבועיות");
    expect(summary.data.structuredData).toMatchObject({
      template: "LESSON_SUMMARY",
      fields: { workedOn: "משוואות ריבועיות", homework: "תרגילים 1-4", nextLesson: "פרבולות" },
    });
    expect(summary.data.content).not.toContain("הערה לצוות");

    const message = sentMessage(fetchMock);
    expect(message).toContain("*עבדנו על:* משוואות ריבועיות");
    expect(message).toContain("*שיעורי בית:* תרגילים 1-4");
    expect(message).toContain("*בשיעור הבא:* פרבולות");
    expect(message).toContain(`📄 קישור ללוח השיעור: ${BOARD_URL}`);
    expect(message).not.toContain("הערה לצוות");
  });

  it("sends a warm mapping note with the board link and without internal scores", async () => {
    db.lessonFindUnique.mockResolvedValue({ ...LESSON, lessonType: "MAPPING" });
    const fetchMock = stubGateway();
    const res = await complete({
      attendanceStatus: "ATTENDED",
      boardPdfUrl: BOARD_URL,
      summaryData: { template: "MAPPING_SUMMARY", fields: MAPPING_FIELDS },
    });

    expect(res.status).toBe(200);
    const summary = db.logCreate.mock.calls[1]?.[0] as {
      data: { type: string; structuredData: { fields: { lastSchoolScore: number; additionalNotes: string } } };
    };
    expect(summary.data.type).toBe("MAPPING_SUMMARY");
    expect(summary.data.structuredData.fields.lastSchoolScore).toBe(41);
    expect(summary.data.structuredData.fields.additionalNotes).toBe("הורה ביקש לא לשתף");

    const message = sentMessage(fetchMock);
    expect(message).toContain("שיעור המיפוי של מתן קולמן");
    expect(message).toContain(`📄 קישור ללוח השיעור: ${BOARD_URL}`);
    expect(message).not.toContain("41");
    expect(message).not.toContain("85");
    expect(message).not.toContain("הורה ביקש לא לשתף");
    expect(message).not.toContain("לא מתאים");
  });

  it("keeps the lesson closed and the teacher paid when WhatsApp fails", async () => {
    stubGateway(async () => {
      throw new TypeError("fetch failed");
    });
    const res = await complete({
      attendanceStatus: "ATTENDED",
      boardPdfUrl: BOARD_URL,
      summaryData: { template: "LESSON_SUMMARY", fields: REGULAR_FIELDS },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, teacherCompensated: true, whatsappDispatched: false });
    expect(db.payoutCreate).toHaveBeenCalledTimes(1);
    expect(db.logCreate).toHaveBeenCalledTimes(2);
    expect(audit.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "LESSON_SUMMARY_WHATSAPP_FAILED", entityId: LESSON.id })
    );
  });
});

describe("WhatsApp summary copy", () => {
  it("includes the board PDF on a regular summary and leaves a non-http link out", () => {
    const message = buildQuadCommunicationSummaryMessage({
      type: "LESSON_SUMMARY",
      workedOn: "שברים",
      homework: "עמוד 12",
      nextLesson: "אחוזים",
      boardPdfUrl: BOARD_URL,
    });
    expect(message).toContain(`📄 קישור ללוח השיעור: ${BOARD_URL}`);
    expect(message).toContain("*עבדנו על:* שברים");

    const unsafe = buildQuadCommunicationSummaryMessage({
      type: "LESSON_SUMMARY",
      workedOn: "שברים",
      boardPdfUrl: "javascript:alert(1)",
    });
    expect(unsafe).not.toContain("javascript:");
    expect(unsafe).not.toContain("קישור ללוח השיעור");
  });
});

describe("student privacy", () => {
  it("blocks a student from reading pedagogical communication records", async () => {
    session.getCurrentUser.mockResolvedValue({ ...STUDENT, isApproved: true });
    const res = await listCommunication(new Request("https://project100.example/communication"), {
      params: Promise.resolve({ id: STUDENT.id }),
    });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain("structuredData");
    expect(body).not.toContain("עבדנו על");
    expect(db.logFindMany).not.toHaveBeenCalled();
    expect(db.logCreate).not.toHaveBeenCalled();
  });

  it("gives the student the board PDF and strips teacher notes from the lesson list", async () => {
    const secret = {
      id: "lesson-1",
      title: "מתמטיקה",
      status: "COMPLETED",
      excalidrawPdfUrl: BOARD_URL,
      pedagogicalBrief: "הערה פנימית של המורה",
      content: "עבדנו על סוד",
      structuredData: { template: "LESSON_SUMMARY", fields: { workedOn: "סוד" } },
      internalNotes: "לא לתלמיד",
      dailyRoomUrl: null,
      teacher: { id: TEACHER.id, name: TEACHER.name },
      student: { id: STUDENT.id, name: STUDENT.name },
      chatChannel: null,
      package: null,
    };
    const stripped = lessonVisibleToStudent(secret);
    expect(stripped.excalidrawPdfUrl).toBe(BOARD_URL);
    expect(stripped).not.toHaveProperty("pedagogicalBrief");
    expect(stripped).not.toHaveProperty("content");
    expect(stripped).not.toHaveProperty("structuredData");
    expect(stripped).not.toHaveProperty("internalNotes");

    db.lessonFindMany.mockResolvedValue([secret]);
    session.getCurrentUser.mockResolvedValue({ ...STUDENT, isApproved: true });
    const studentList = await listLessons(new Request("https://project100.example/api/lessons"));
    expect(studentList.status).toBe(200);
    const studentBody = await studentList.json();
    expect(studentBody[0].excalidrawPdfUrl).toBe(BOARD_URL);
    expect(JSON.stringify(studentBody)).not.toContain("הערה פנימית של המורה");
    expect(JSON.stringify(studentBody)).not.toContain("structuredData");
    expect(JSON.stringify(studentBody)).not.toContain("לא לתלמיד");

    session.getCurrentUser.mockResolvedValue(TEACHER);
    const teacherList = await listLessons(new Request("https://project100.example/api/lessons"));
    const teacherBody = await teacherList.json();
    expect(teacherBody[0].pedagogicalBrief).toBe("הערה פנימית של המורה");
  });
});
