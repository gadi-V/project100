import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
  lessonFindUnique: vi.fn(),
  lessonFindFirst: vi.fn(),
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
  deleteDailyRoom: vi.fn(),
  roomNameFromDailyUrl: vi.fn((url: string) => url.split("/").pop() ?? null),
  dailyRoomNameForLesson: vi.fn((id: string) => `lesson-${id}`),
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: db.userFindUnique, update: db.userUpdate, updateMany: db.userUpdateMany },
    lesson: { findUnique: db.lessonFindUnique, findFirst: db.lessonFindFirst, updateMany: db.lessonUpdateMany },
    teacherReferral: { findFirst: db.referralFindFirst },
    teacherAvailability: { updateMany: db.slotUpdateMany },
    studentCommunicationLog: { create: db.logCreate, findMany: db.logFindMany },
    $transaction: db.transaction,
  },
}));
vi.mock("../lib/session", () => session);
vi.mock("../lib/audit", () => audit);
vi.mock("../lib/daily", () => daily);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../components/ClassroomWhiteboard", () => ({ default: () => null }));
vi.mock("../components/ClassroomChat", () => ({ default: () => null }));
vi.mock("../components/VideoRoom", () => ({ default: () => createElement("div", null, "daily-video-room") }));
vi.mock("../components/RatingModal", () => ({ default: () => null }));
vi.mock("../components/packages/PreLessonAssetsSection", () => ({ default: () => null }));
vi.mock("../components/packages/DiagnosticSummaryCard", () => ({ default: () => null }));

import { POST as completeLesson } from "../app/api/portal/students/[id]/meetings/[meetingId]/complete/route";
import { DELETE } from "../app/api/portal/students/[id]/meetings/[meetingId]/route";
import LessonRoomUI from "../app/lessons/[id]/LessonRoomUI";
import CompleteLessonModal from "../components/portal/student/CompleteLessonModal";
import { buildMeetingRows } from "../lib/student-portal";
import { flagUnexcusedAbsence } from "../lib/student-portal-shared";
import { cancelCreditOutcome, CANCEL_CREDIT_NOTES } from "../lib/lesson-lifecycle";
import {
  canCompleteFromRoom,
  completeLessonEndpoint,
  portalAfterCompletionHref,
  submitLessonCompletion,
} from "../lib/lesson-completion";
import { buildStudentNoShowMessage } from "../lib/whatsapp";

/** Tuesday 29.09.2026, 22:00 Israel time. */
const NOW = new Date("2026-09-29T19:00:00.000Z");
const STARTED_AT = new Date("2026-09-29T17:00:00.000Z");
/** Monday 05.10.2026, 17:00 Israel time. */
const LATER_AT = new Date("2026-10-05T14:00:00.000Z");
const GATEWAY = "https://wa-gateway.example.test";
const GROUP_ID = "120363025555555555@g.us";
const STUDENT_GROUP_ID = "120363026666666666@g.us";
const ROOM_URL = "https://p100.daily.co/lesson-1";
const NO_SHOW_TEXT =
  "⚠️ *עדכון שיעור - Project 100*\n" +
  "שלום לכולם, במועד השיעור שנקבע להיום התלמיד/ה לא נכח/ה בחדר הלמידה.\n" +
  "המנהל הפדגוגי יעודכן לבדיקת המקרה ותיאום מועד חלופי. המשך יום נעים.";

const STUDENT = { id: "stu-1", name: "מתן קולמן", role: "STUDENT", whatsappGroupId: GROUP_ID as string | null, lessonCredits: 4 };
const TEACHER = { id: "teacher-1", name: "רונית לוי", role: "TEACHER", lessonCredits: 0, isApproved: true };
const OTHER_TEACHER = { id: "teacher-2", name: "אבי כהן", role: "TEACHER", lessonCredits: 0, isApproved: true };

type LessonFixture = {
  id: string;
  studentId: string;
  teacherId: string;
  status: string;
  title: string | null;
  scheduledAt: Date;
  startTime: Date | null;
  durationMinutes: number | null;
  rescheduledCount: number;
  dailyRoomUrl: string | null;
  whatsappGroupId: string | null;
};

const LESSON: LessonFixture = {
  id: "lesson-1",
  studentId: STUDENT.id,
  teacherId: TEACHER.id,
  status: "SCHEDULED",
  title: "מתמטיקה 5 יח״ל",
  scheduledAt: STARTED_AT,
  startTime: null,
  durationMinutes: 50,
  rescheduledCount: 0,
  dailyRoomUrl: ROOM_URL,
  whatsappGroupId: GROUP_ID,
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

type FetchMock = ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>;

function staff(role: string, id = `user-${role.toLowerCase()}`) {
  return { id, name: "שירה מהצוות", role, lessonCredits: 0, isApproved: true };
}

function withLesson(overrides: Partial<LessonFixture> = {}) {
  const lesson = { ...LESSON, ...overrides };
  db.lessonFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === lesson.id ? lesson : null
  );
  return lesson;
}

function withStudent(overrides: Partial<typeof STUDENT> = {}) {
  const student = { ...STUDENT, ...overrides };
  db.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    [student, TEACHER, OTHER_TEACHER].find((u) => u.id === where.id) ?? null
  );
}

function withDirectPackage() {
  db.logFindMany.mockResolvedValue([
    {
      id: "log-pkg",
      createdAt: new Date("2026-09-20T10:00:00Z"),
      structuredData: { source: "DIRECT_PACKAGE", package: { packageCode: "PACK_10", credits: 10, subject: "מתמטיקה" } },
    },
  ]);
}

function context(meetingId = LESSON.id, id = STUDENT.id) {
  return { params: Promise.resolve({ id, meetingId }) };
}

function request(method: string, body: unknown, url = `https://project100.example/api/portal/students/${STUDENT.id}/meetings/x`) {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

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

function staffAudit(action: string) {
  return audit.writeAuditLog.mock.calls
    .map(([entry]) => entry as { action: string; entityId: string; metadata: Record<string, unknown> })
    .find((entry) => entry.action === action);
}

function communicationEntry() {
  return db.logCreate.mock.calls[0]?.[0] as { data: { content: string; structuredData: Record<string, unknown> } };
}

function profileWrite() {
  return db.profileUpsert.mock.calls[0]?.[0] as {
    where: { userId: string };
    create: Record<string, unknown>;
    update: { studentStatus: string[]; statusUpdatedById: string };
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("WHATSAPP_API_URL", GATEWAY);
  vi.stubEnv("WHATSAPP_API_KEY", "wa-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  session.getCurrentUser.mockResolvedValue(TEACHER);
  withStudent();
  withLesson();
  db.lessonFindFirst.mockImplementation(async ({ where }: { where: { teacherId?: string; status?: unknown } }) => {
    if (where.status) return null;
    return where.teacherId === TEACHER.id || where.teacherId === OTHER_TEACHER.id ? { id: "any-lesson" } : null;
  });
  db.referralFindFirst.mockResolvedValue(null);
  db.transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  db.lessonUpdateMany.mockResolvedValue({ count: 1 });
  db.userUpdateMany.mockResolvedValue({ count: 1 });
  db.userUpdate.mockResolvedValue({ lessonCredits: 5 });
  db.slotUpdateMany.mockResolvedValue({ count: 0 });
  db.logCreate.mockResolvedValue({ id: "log-1" });
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
  db.profileFindUnique.mockResolvedValue({ studentStatus: ["STUDENT", "BOILING_160"] });
  db.profileUpsert.mockResolvedValue({});
  daily.deleteDailyRoom.mockResolvedValue(undefined);
  audit.writeAuditLog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DELETE …/meetings/[meetingId] — credit symmetry on cancellation", () => {
  const cancel = (body: Record<string, unknown>) => DELETE(request("DELETE", body), context());

  beforeEach(() => {
    session.getCurrentUser.mockResolvedValue(staff("REPRESENTATIVE"));
    stubGateway();
  });

  it("does not add a free credit when a portal lesson (charged only on completion) is cancelled", async () => {
    withLesson({ scheduledAt: LATER_AT });
    withDirectPackage();

    const res = await cancel({ cancellationReason: "חופשה משפחתית", restoreCredit: true });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      lessonId: LESSON.id,
      status: "CANCELLED",
      creditRestored: false,
      creditOutcome: "NOT_DEDUCTED",
      lessonCredits: null,
    });
    expect(db.userUpdate).not.toHaveBeenCalled();
    expect(db.userUpdateMany).not.toHaveBeenCalled();
    expect(communicationEntry().data.content).toContain("שיעור בוטל. זיכוי קרדיט: לא נדרש (טרם נגרע)");
    expect(communicationEntry().data.structuredData).toMatchObject({ creditRestored: false, creditOutcome: "NOT_DEDUCTED" });
    expect(staffAudit("LESSON_CANCELLED_BY_STAFF")?.metadata).toMatchObject({
      restoreCreditRequested: true,
      creditRestored: false,
      creditOutcome: "NOT_DEDUCTED",
      creditNote: "שיעור בוטל. זיכוי קרדיט: לא נדרש (טרם נגרע)",
    });
  });

  it("returns exactly one credit for a lesson whose credit was taken at booking", async () => {
    withLesson({ scheduledAt: LATER_AT, title: null });

    const res = await cancel({ cancellationReason: "המורה חולה", restoreCredit: true });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ creditRestored: true, creditOutcome: "RESTORED", lessonCredits: 5 });
    expect(db.userUpdate).toHaveBeenCalledTimes(1);
    expect(db.userUpdate).toHaveBeenCalledWith({
      where: { id: STUDENT.id },
      data: { lessonCredits: { increment: 1 } },
      select: { lessonCredits: true },
    });
    expect(communicationEntry().data.content).toContain("שיעור בוטל. זוכה קרדיט 1 (הוחזר ליתרה)");
    expect(staffAudit("LESSON_CANCELLED_BY_STAFF")?.metadata).toMatchObject({
      creditOutcome: "RESTORED",
      creditNote: "שיעור בוטל. זוכה קרדיט 1 (הוחזר ליתרה)",
      lessonCredits: 5,
    });
  });

  it("keeps a booking credit when staff choose not to return it", async () => {
    withLesson({ scheduledAt: LATER_AT, title: null });

    const body = await (await cancel({ cancellationReason: "ביטול מאוחר של התלמיד", restoreCredit: false })).json();

    expect(body.data).toMatchObject({ creditRestored: false, creditOutcome: "NOT_REQUESTED" });
    expect(db.userUpdate).not.toHaveBeenCalled();
    expect(communicationEntry().data.content).toContain(CANCEL_CREDIT_NOTES.NOT_REQUESTED);
  });

  it("decides the outcome from how the lesson was charged, not from the package track", () => {
    expect(cancelCreditOutcome(false, true)).toBe("NOT_DEDUCTED");
    expect(cancelCreditOutcome(false, false)).toBe("NOT_DEDUCTED");
    expect(cancelCreditOutcome(true, true)).toBe("RESTORED");
    expect(cancelCreditOutcome(true, false)).toBe("NOT_REQUESTED");
  });

  it("offers the restore checkbox only on rows whose credit was taken at booking", () => {
    const base = {
      id: "row-1",
      scheduledAt: LATER_AT,
      startTime: null,
      endTime: null,
      durationMinutes: 50,
      status: "SCHEDULED",
      teacherId: TEACHER.id,
      studentId: STUDENT.id,
      packageId: null,
      attendanceStatus: null,
      lessonType: "REGULAR",
      whatsappGroupId: null,
      rescheduledCount: 0,
      teacher: { name: TEACHER.name },
      package: null,
    };
    const [portal, selfBooked] = buildMeetingRows(
      [
        { ...base, title: "מתמטיקה" },
        { ...base, id: "row-2", title: null },
      ],
      { id: "r", role: "REPRESENTATIVE" },
      NOW
    );
    expect(portal.creditTakenAtBooking).toBe(false);
    expect(selfBooked.creditTakenAtBooking).toBe(true);
  });
});

describe("POST …/complete — no-show retention safeguard", () => {
  const reportNoShow = () => completeLesson(request("POST", { attendanceStatus: "STUDENT_NO_SHOW" }), context());

  it("flags the CRM card, alerts the quad group and records STUDENT_NO_SHOW_RECORDED", async () => {
    const fetchMock = stubGateway();

    const res = await reportNoShow();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      status: "COMPLETED",
      attendanceStatus: "STUDENT_NO_SHOW",
      teacherCompensated: true,
      absenceFlagged: true,
      whatsappDispatched: true,
      promptSummary: false,
    });

    const profile = profileWrite();
    expect(profile.where).toEqual({ userId: STUDENT.id });
    expect(profile.update.studentStatus).toEqual(["STUDENT", "BOILING_160", "UNEXCUSED_ABSENCE"]);
    expect(profile.update.statusUpdatedById).toBe(TEACHER.id);
    expect(profile.create).toMatchObject({ userId: STUDENT.id, studentStatus: ["STUDENT", "BOILING_160", "UNEXCUSED_ABSENCE"] });

    const messages = sentMessages(fetchMock);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ chatId: GROUP_ID, message: NO_SHOW_TEXT });

    const record = staffAudit("STUDENT_NO_SHOW_RECORDED");
    expect(record?.entityId).toBe(LESSON.id);
    expect(record?.metadata).toMatchObject({
      studentId: STUDENT.id,
      teacherId: TEACHER.id,
      whatsappDispatched: true,
      studentStatus: ["STUDENT", "BOILING_160", "UNEXCUSED_ABSENCE"],
    });
    expect(communicationEntry().data.content).toContain("סומן בתיק: חיסור לא מוצדק");
  });

  it("falls back to the student's quad group when the lesson has none", async () => {
    const fetchMock = stubGateway();
    withLesson({ whatsappGroupId: null });
    withStudent({ whatsappGroupId: STUDENT_GROUP_ID });

    await reportNoShow();

    expect(sentMessages(fetchMock).map((m) => m.chatId)).toEqual([STUDENT_GROUP_ID]);
  });

  it("keeps the attendance and the flag when the WhatsApp gateway is down", async () => {
    stubGateway(async () => {
      throw new TypeError("fetch failed");
    });

    const res = await reportNoShow();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, absenceFlagged: true, whatsappDispatched: false });
    expect(db.profileUpsert).toHaveBeenCalledTimes(1);
    expect(db.payoutCreate).toHaveBeenCalledTimes(1);
    expect(staffAudit("STUDENT_NO_SHOW_RECORDED")?.metadata).toMatchObject({ whatsappDispatched: false });
  });

  it("reports whatsappDispatched: false without any quad group", async () => {
    const fetchMock = stubGateway();
    withLesson({ whatsappGroupId: null });
    withStudent({ whatsappGroupId: null });

    const body = await (await reportNoShow()).json();

    expect(body.whatsappDispatched).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(staffAudit("STUDENT_NO_SHOW_RECORDED")?.metadata).toMatchObject({ whatsappGroupLinked: false });
  });

  it("does not flag or alert for an attended lesson", async () => {
    const fetchMock = stubGateway();

    const body = await (await completeLesson(request("POST", { attendanceStatus: "ATTENDED" }), context())).json();

    expect(body).not.toHaveProperty("absenceFlagged");
    expect(db.profileUpsert).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(staffAudit("STUDENT_NO_SHOW_RECORDED")).toBeUndefined();
  });

  it("closes the Daily room once the lesson is closed", async () => {
    stubGateway();

    await completeLesson(request("POST", { attendanceStatus: "ATTENDED" }), context());

    const update = db.lessonUpdateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(update.data).toMatchObject({ dailyRoomUrl: null });
    expect(daily.deleteDailyRoom).toHaveBeenCalledWith("lesson-1");
  });

  it("keeps the flag list clean and idempotent", () => {
    expect(flagUnexcusedAbsence(["UNEXCUSED_ABSENCE", "STUDENT", "LEGACY"])).toEqual(["STUDENT", "UNEXCUSED_ABSENCE"]);
    expect(flagUnexcusedAbsence([])).toEqual(["UNEXCUSED_ABSENCE"]);
    expect(buildStudentNoShowMessage()).toBe(NO_SHOW_TEXT);
  });
});

describe("LessonRoomUI — closing the lesson from the Daily room", () => {
  const roomLesson = (overrides: Record<string, unknown> = {}) => ({
    id: LESSON.id,
    title: LESSON.title,
    status: "IN_PROGRESS",
    studentId: STUDENT.id,
    teacherId: TEACHER.id,
    roomUrl: ROOM_URL,
    dailyToken: "daily-token",
    streamToken: null,
    streamApiKey: null,
    scheduledAt: STARTED_AT.toISOString(),
    createdAt: STARTED_AT.toISOString(),
    durationMinutes: 50,
    packageId: null,
    chatChannel: null,
    ...overrides,
  });
  const renderRoom = (user: { id: string; name: string; role: string }, lesson = roomLesson()) =>
    renderToStaticMarkup(
      createElement(LessonRoomUI, {
        lesson,
        user: user as { id: string; name: string; role: "STUDENT" | "TEACHER" | "ADMIN" | "MANAGER" },
        pedagogicalBrief: null,
      })
    );

  it("shows the assigned teacher the completion button in the room header", () => {
    const html = renderRoom(TEACHER);
    expect(html).toContain("סיום שיעור ודיווח נוכחות");
    expect(html).toContain("daily-video-room");
  });

  it("shows it to management, but not to the student or to another teacher", () => {
    expect(renderRoom(staff("MANAGER"))).toContain("סיום שיעור ודיווח נוכחות");
    expect(renderRoom(staff("ADMIN"))).toContain("סיום שיעור ודיווח נוכחות");

    const studentView = renderRoom({ id: STUDENT.id, name: STUDENT.name, role: "STUDENT" });
    expect(studentView).not.toContain("סיום שיעור ודיווח נוכחות");
    expect(studentView).toContain("עזוב ודרג");

    expect(renderRoom(OTHER_TEACHER)).not.toContain("סיום שיעור ודיווח נוכחות");
  });

  it("hides it once the lesson is already closed", () => {
    expect(renderRoom(TEACHER, roomLesson({ status: "COMPLETED" }))).not.toContain("סיום שיעור ודיווח נוכחות");
    expect(canCompleteFromRoom(TEACHER, { status: "CANCELLED", teacherId: TEACHER.id })).toBe(false);
  });

  it("renders the room variant of the attendance modal", () => {
    const html = renderToStaticMarkup(
      createElement(CompleteLessonModal, {
        studentId: STUDENT.id,
        meeting: { id: LESSON.id, title: "מתמטיקה 5 יח״ל", scheduledAt: STARTED_AT.toISOString(), teacherName: TEACHER.name },
        context: "room",
        onClose: () => {},
        onDone: () => {},
      })
    );
    expect(html).toContain("השיעור התקיים בהצלחה");
    expect(html).toContain("התלמיד לא הופיע לשיעור");
    expect(html).toContain("ביטול ביוזמת המורה");
    expect(html).toContain("השיחה תסתיים ותעברו לטופס סיכום השיעור לוואטסאפ");
  });

  it("sends a valid attendance report from the room to the completion API", async () => {
    stubGateway();
    const roomFetch = vi.fn(async (url: string, init: RequestInit) =>
      completeLesson(new Request(`https://project100.example${url}`, init), context())
    );

    const result = await submitLessonCompletion(
      { studentId: STUDENT.id, lessonId: LESSON.id, attendanceStatus: "ATTENDED", internalNotes: "נגזרות" },
      roomFetch as unknown as typeof fetch
    );

    expect(roomFetch.mock.calls[0][0]).toBe(`/api/portal/students/${STUDENT.id}/meetings/${LESSON.id}/complete`);
    expect(JSON.parse(String(roomFetch.mock.calls[0][1].body))).toEqual({ attendanceStatus: "ATTENDED", internalNotes: "נגזרות" });
    expect(result).toMatchObject({ success: true, status: "COMPLETED", teacherCompensated: true, promptSummary: true });
    expect(db.payoutCreate).toHaveBeenCalledTimes(1);
    expect(daily.deleteDailyRoom).toHaveBeenCalledTimes(1);
  });

  it("surfaces the API error when the student tries to close the lesson", async () => {
    session.getCurrentUser.mockResolvedValue({ ...STUDENT, isApproved: true });
    const roomFetch = async (url: string, init?: RequestInit) =>
      completeLesson(new Request(`https://project100.example${url}`, init), context());

    await expect(
      submitLessonCompletion(
        { studentId: STUDENT.id, lessonId: LESSON.id, attendanceStatus: "ATTENDED", internalNotes: null },
        roomFetch as unknown as typeof fetch
      )
    ).rejects.toThrow("אין לך הרשאה לפעולה זו");
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("sends the teacher to the summary form after an attended lesson, otherwise to the meetings tab", () => {
    expect(completeLessonEndpoint("stu 1", "l/1")).toBe("/api/portal/students/stu%201/meetings/l%2F1/complete");
    expect(portalAfterCompletionHref(STUDENT.id, LESSON.id, { success: true, promptSummary: true })).toBe(
      `/portal/students/${STUDENT.id}?tab=communication&autoPromptSummary=true&lessonId=${LESSON.id}`
    );
    expect(portalAfterCompletionHref(STUDENT.id, LESSON.id, { success: true, promptSummary: false })).toBe(
      `/portal/students/${STUDENT.id}?tab=meetings`
    );
  });
});
