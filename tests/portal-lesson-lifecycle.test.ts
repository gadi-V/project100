import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  lessonFindUnique: vi.fn(),
  lessonFindFirst: vi.fn(),
  lessonUpdateMany: vi.fn(),
  slotUpdateMany: vi.fn(),
  logCreate: vi.fn(),
  logFindMany: vi.fn(),
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
    user: { findUnique: db.userFindUnique, update: db.userUpdate },
    lesson: { findUnique: db.lessonFindUnique, findFirst: db.lessonFindFirst, updateMany: db.lessonUpdateMany },
    teacherAvailability: { updateMany: db.slotUpdateMany },
    studentCommunicationLog: { create: db.logCreate, findMany: db.logFindMany },
    $transaction: db.transaction,
  },
}));
vi.mock("../lib/session", () => session);
vi.mock("../lib/audit", () => audit);
vi.mock("../lib/daily", () => daily);
vi.mock("../lib/whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/whatsapp")>();
  return {
    ...actual,
    sendQuadGroupLessonRescheduled: vi.fn(actual.sendQuadGroupLessonRescheduled),
    sendQuadGroupLessonCancelled: vi.fn(actual.sendQuadGroupLessonCancelled),
    sendQuadGroupPrivateLessonScheduled: vi.fn(actual.sendQuadGroupPrivateLessonScheduled),
  };
});

import { PATCH, DELETE } from "../app/api/portal/students/[id]/meetings/[meetingId]/route";
import { POST as schedulePending } from "../app/api/portal/students/[id]/meetings/pending-schedule/route";
import * as whatsapp from "../lib/whatsapp";
import { buildMeetingRows } from "../lib/student-portal";
import { parseCancelInput, parseRescheduleInput } from "../lib/lesson-lifecycle";

type FetchMock = ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>;

const GATEWAY = "https://wa-gateway.example.test";
const GROUP_ID = "120363025555555555@g.us";
/** Tuesday 29.09.2026, 22:00 Israel time. */
const NOW = new Date("2026-09-29T19:00:00.000Z");
/** Monday 05.10.2026, 17:00 Israel time. */
const LESSON_AT = new Date("2026-10-05T14:00:00.000Z");
/** Wednesday 07.10.2026, 18:30 Israel time. */
const NEW_AT = "2026-10-07T15:30:00.000Z";
const ROOM_URL = "https://p100.daily.co/lesson-sched-1";

const STUDENT = { id: "stu-1", name: "מתן קולמן", role: "STUDENT", whatsappGroupId: GROUP_ID as string | null };
const TEACHER = { id: "teacher-1", name: "רונית לוי", role: "TEACHER", isApproved: true };
const OTHER_TEACHER = { id: "teacher-2", name: "אבי כהן", role: "TEACHER", isApproved: true };
const INACTIVE_TEACHER = { id: "teacher-3", name: "מורה בהמתנה", role: "TEACHER", isApproved: false };

const SCHEDULED_LESSON = {
  id: "sched-1",
  studentId: STUDENT.id,
  teacherId: TEACHER.id,
  status: "SCHEDULED",
  title: "מתמטיקה 5 יח״ל",
  scheduledAt: LESSON_AT,
  startTime: null as Date | null,
  durationMinutes: 50,
  rescheduledCount: 0,
  dailyRoomUrl: ROOM_URL as string | null,
  whatsappGroupId: GROUP_ID as string | null,
};
const PENDING_LESSON = {
  id: "pending-1",
  studentId: STUDENT.id,
  status: "PENDING_SCHEDULE",
  title: "מתמטיקה · שיעור פרטי",
  durationMinutes: 50,
};

const tx = {
  lesson: { findFirst: db.lessonFindFirst, updateMany: db.lessonUpdateMany },
  teacherAvailability: { updateMany: db.slotUpdateMany },
  user: { update: db.userUpdate },
  studentCommunicationLog: { create: db.logCreate },
};

function staff(role: string, id = `user-${role.toLowerCase()}`) {
  return { id, name: "שירה מהצוות", role, lessonCredits: 0, isApproved: true };
}

function meetingContext(meetingId = SCHEDULED_LESSON.id, id = STUDENT.id) {
  return { params: Promise.resolve({ id, meetingId }) };
}

function studentContext(id = STUDENT.id) {
  return { params: Promise.resolve({ id }) };
}

function request(method: string, body: unknown) {
  return new Request(`https://project100.example/api/portal/students/${STUDENT.id}/meetings/x`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

function auditCall(action: string) {
  return audit.writeAuditLog.mock.calls
    .map(([entry]) => entry as { action: string; entityId: string; metadata: Record<string, unknown> })
    .find((entry) => entry.action === action);
}

function lessonUpdate() {
  return db.lessonUpdateMany.mock.calls[0]?.[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
}

function withData(overrides: { student?: Partial<typeof STUDENT>; lesson?: Partial<typeof SCHEDULED_LESSON> } = {}) {
  const student = { ...STUDENT, ...overrides.student };
  const lesson = { ...SCHEDULED_LESSON, ...overrides.lesson };
  db.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    return [student, TEACHER, OTHER_TEACHER, INACTIVE_TEACHER].find((u) => u.id === where.id) ?? null;
  });
  db.lessonFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === lesson.id) return lesson;
    if (where.id === PENDING_LESSON.id) return PENDING_LESSON;
    if (where.id === "foreign-1") return { ...SCHEDULED_LESSON, id: "foreign-1", studentId: "stu-other" };
    return null;
  });
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("WHATSAPP_API_URL", GATEWAY);
  vi.stubEnv("WHATSAPP_API_KEY", "wa-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  session.getCurrentUser.mockResolvedValue(staff("REPRESENTATIVE"));
  withData();
  db.transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  db.lessonFindFirst.mockResolvedValue(null);
  db.lessonUpdateMany.mockResolvedValue({ count: 1 });
  db.slotUpdateMany.mockResolvedValue({ count: 0 });
  db.logCreate.mockResolvedValue({ id: "log-1" });
  db.logFindMany.mockResolvedValue([]);
  db.userUpdate.mockResolvedValue({ lessonCredits: 6 });
  daily.deleteDailyRoom.mockResolvedValue(undefined);
  audit.writeAuditLog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("POST …/meetings/pending-schedule — extra private lessons", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    lessonId: PENDING_LESSON.id,
    teacherId: OTHER_TEACHER.id,
    scheduledAt: NEW_AT,
    ...overrides,
  });

  it("locks the time and teacher, moves the lesson to SCHEDULED and posts to the quad group", async () => {
    const fetchMock = stubGateway();

    const res = await schedulePending(request("POST", body()), studentContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      whatsappDispatched: true,
      data: { lessonId: PENDING_LESSON.id, scheduledAt: NEW_AT, teacherName: OTHER_TEACHER.name },
    });
    expect(lessonUpdate()).toEqual({
      where: { id: PENDING_LESSON.id, status: "PENDING_SCHEDULE" },
      data: {
        status: "SCHEDULED",
        scheduledAt: new Date(NEW_AT),
        startTime: null,
        endTime: null,
        teacherId: OTHER_TEACHER.id,
        whatsappGroupId: GROUP_ID,
        reminderSent: false,
      },
    });
    expect(db.slotUpdateMany).toHaveBeenCalledWith({
      where: { teacherId: OTHER_TEACHER.id, startTime: new Date(NEW_AT), isBooked: false },
      data: { isBooked: true },
    });

    const [message] = sentMessages(fetchMock);
    expect(message.chatId).toBe(GROUP_ID);
    expect(message.message).toContain("שיבוץ שיעור פרטי - Project 100");
    expect(message.message).toContain("מורה: אבי כהן");
    expect(message.message).toContain("תאריך ושעה: יום רביעי 07.10.2026 בשעה 18:30-19:20");
    expect(auditCall("PENDING_LESSON_SCHEDULED")).toMatchObject({ entityId: PENDING_LESSON.id });
  });

  it("refuses a colliding slot with 409 and leaves the lesson pending", async () => {
    db.lessonFindFirst.mockResolvedValueOnce({ scheduledAt: new Date("2026-10-07T15:00:00.000Z") });
    const fetchMock = stubGateway();

    const res = await schedulePending(request("POST", body()), studentContext());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("לתלמיד כבר יש מפגש");
    expect(db.lessonUpdateMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const [studentCheck] = db.lessonFindFirst.mock.calls.map(([arg]) => arg.where);
    expect(studentCheck).toMatchObject({
      studentId: STUDENT.id,
      id: { not: PENDING_LESSON.id },
      status: { in: ["SCHEDULED", "IN_PROGRESS"] },
    });
    expect(studentCheck.scheduledAt.gt).toEqual(new Date("2026-10-07T14:30:00.000Z"));
    expect(studentCheck.scheduledAt.lt).toEqual(new Date("2026-10-07T16:30:00.000Z"));
  });

  it("answers 409 when a parallel request scheduled it first", async () => {
    db.lessonUpdateMany.mockResolvedValue({ count: 0 });
    const res = await schedulePending(request("POST", body()), studentContext());
    expect(res.status).toBe(409);
  });

  it.each([
    ["a lesson that is not pending", { lessonId: SCHEDULED_LESSON.id }, 409],
    ["a lesson of another student", { lessonId: "foreign-1" }, 404],
    ["an inactive teacher", { teacherId: INACTIVE_TEACHER.id }, 404],
    ["a past date", { scheduledAt: "2026-09-01T10:00:00.000Z" }, 400],
    ["no teacher", { teacherId: "" }, 400],
  ])("rejects %s", async (_label, overrides, status) => {
    const res = await schedulePending(request("POST", body(overrides)), studentContext());
    expect(res.status).toBe(status);
    expect(db.lessonUpdateMany).not.toHaveBeenCalled();
  });
});

describe("PATCH …/meetings/[meetingId] — reschedule", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    newScheduledAt: NEW_AT,
    reason: "מבחן בבית הספר",
    ...overrides,
  });

  it("moves the lesson, keeps the reason, frees the old slot and posts the exact update", async () => {
    const fetchMock = stubGateway();

    const res = await PATCH(request("PATCH", body()), meetingContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      whatsappDispatched: true,
      data: {
        lessonId: SCHEDULED_LESSON.id,
        scheduledAt: NEW_AT,
        previousScheduledAt: LESSON_AT.toISOString(),
        emergencyOverride: false,
      },
    });
    expect(lessonUpdate()).toEqual({
      where: { id: SCHEDULED_LESSON.id, status: "SCHEDULED", rescheduledCount: 0 },
      data: {
        scheduledAt: new Date(NEW_AT),
        startTime: null,
        endTime: null,
        reminderSent: false,
        dailyRoomUrl: null,
        rescheduledCount: { increment: 1 },
      },
    });
    expect(db.slotUpdateMany).toHaveBeenCalledWith({
      where: { teacherId: TEACHER.id, startTime: LESSON_AT, isBooked: true },
      data: { isBooked: false },
    });
    expect(db.logCreate.mock.calls[0][0].data).toMatchObject({
      type: "GENERAL",
      authorRole: "REPRESENTATIVE",
      structuredData: {
        source: "LESSON_RESCHEDULED",
        lessonId: SCHEDULED_LESSON.id,
        from: LESSON_AT.toISOString(),
        to: NEW_AT,
        reason: "מבחן בבית הספר",
      },
    });
    expect(db.logCreate.mock.calls[0][0].data.content).toContain("סיבה: מבחן בבית הספר");
    expect(daily.deleteDailyRoom).toHaveBeenCalledWith("lesson-sched-1");

    const [message] = sentMessages(fetchMock);
    expect(message.chatId).toBe(GROUP_ID);
    expect(message.message).toBe(
      "🗓️ *עדכון מועד שיעור - Project 100*\n" +
        "שלום לכולם, שיעור בנושא מתמטיקה 5 יח״ל עודכן למועד חדש:\n" +
        "תאריך ושעה חדשים: יום רביעי 07.10.2026 בשעה 18:30-19:20\n" +
        "היומן עודכן בהתאם. המשך שבוע מצוין!"
    );
    expect(auditCall("LESSON_RESCHEDULED_BY_STAFF")?.metadata).toMatchObject({
      from: LESSON_AT.toISOString(),
      to: NEW_AT,
      reason: "מבחן בבית הספר",
      whatsappDispatched: true,
    });
  });

  it("prevents an overlapping time with 409, excluding the lesson itself from the check", async () => {
    db.lessonFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ scheduledAt: new Date("2026-10-07T16:00:00.000Z") });
    const fetchMock = stubGateway();

    const res = await PATCH(request("PATCH", body()), meetingContext());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("המורה כבר משובץ");
    expect(db.lessonUpdateMany).not.toHaveBeenCalled();
    expect(db.logCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const teacherCheck = db.lessonFindFirst.mock.calls[1][0].where;
    expect(teacherCheck).toMatchObject({ teacherId: TEACHER.id, id: { not: SCHEDULED_LESSON.id } });
  });

  it.each([
    ["less than 24 hours before the lesson", { scheduledAt: new Date("2026-09-30T12:00:00.000Z") }, 422],
    ["a lesson that was already rescheduled once", { rescheduledCount: 1 }, 422],
    ["a cancelled lesson", { status: "CANCELLED" }, 409],
  ])("refuses %s", async (_label, lessonOverrides, status) => {
    withData({ lesson: lessonOverrides });
    const res = await PATCH(request("PATCH", body()), meetingContext());
    expect(res.status).toBe(status);
    expect(db.lessonUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a past date", { newScheduledAt: "2026-09-01T10:00:00.000Z" }],
    ["an invalid date", { newScheduledAt: "tomorrow" }],
    ["the same time", { newScheduledAt: LESSON_AT.toISOString() }],
  ])("returns 400 for %s", async (_label, overrides) => {
    const res = await PATCH(request("PATCH", body(overrides)), meetingContext());
    expect(res.status).toBe(400);
  });

  it("returns 404 for a lesson of another student", async () => {
    const res = await PATCH(request("PATCH", body()), meetingContext("foreign-1"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE …/meetings/[meetingId] — cancel", () => {
  it("cancels the lesson, stores the reason and notifies the quad group without the reason", async () => {
    const fetchMock = stubGateway();

    const res = await DELETE(
      request("DELETE", { cancellationReason: "המורה חולה", restoreCredit: false }),
      meetingContext()
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      whatsappDispatched: true,
      data: { lessonId: SCHEDULED_LESSON.id, status: "CANCELLED", creditRestored: false, lessonCredits: null },
    });
    expect(lessonUpdate()).toEqual({
      where: { id: SCHEDULED_LESSON.id, status: "SCHEDULED" },
      data: {
        status: "CANCELLED",
        canceledAt: NOW,
        canceledById: "user-representative",
        appealStatus: "NONE",
        dailyRoomUrl: null,
      },
    });
    expect(db.slotUpdateMany).toHaveBeenCalledWith({
      where: { teacherId: TEACHER.id, startTime: LESSON_AT, isBooked: true },
      data: { isBooked: false },
    });
    expect(db.logCreate.mock.calls[0][0].data).toMatchObject({
      type: "GENERAL",
      structuredData: { source: "LESSON_CANCELLED", lessonId: SCHEDULED_LESSON.id, reason: "המורה חולה", creditRestored: false },
    });
    expect(db.userUpdate).not.toHaveBeenCalled();
    expect(daily.deleteDailyRoom).toHaveBeenCalledTimes(1);

    const [message] = sentMessages(fetchMock);
    expect(message.chatId).toBe(GROUP_ID);
    expect(message.message).toContain("ביטול שיעור - Project 100");
    expect(message.message).toContain("השיעור בנושא מתמטיקה 5 יח״ל שתוכנן ליום שני 05.10.2026 בשעה 17:00-17:50 בוטל");
    expect(message.message).not.toContain("המורה חולה");
    expect(auditCall("LESSON_CANCELLED_BY_STAFF")?.metadata).toMatchObject({
      cancellationReason: "המורה חולה",
      creditRestored: false,
    });
  });

  it("returns one credit to a direct-package student when restoreCredit is true", async () => {
    withDirectPackage();
    stubGateway();

    const res = await DELETE(request("DELETE", { cancellationReason: "חג", restoreCredit: true }), meetingContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { creditRestored: true, lessonCredits: 6 } });
    expect(db.userUpdate).toHaveBeenCalledWith({
      where: { id: STUDENT.id },
      data: { lessonCredits: { increment: 1 } },
      select: { lessonCredits: true },
    });
    expect(db.logCreate.mock.calls[0][0].data.content).toContain("הוחזר שיעור אחד ליתרה");
  });

  it("does not return a credit to a student outside the direct package track", async () => {
    stubGateway();

    const res = await DELETE(request("DELETE", { cancellationReason: "חג", restoreCredit: true }), meetingContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { status: "CANCELLED", creditRestored: false, lessonCredits: null } });
    expect(db.userUpdate).not.toHaveBeenCalled();
    expect(auditCall("LESSON_CANCELLED_BY_STAFF")?.metadata).toMatchObject({
      restoreCreditRequested: true,
      creditRestored: false,
    });
  });

  it("does not return a credit when restoreCredit is false, even on a package", async () => {
    withDirectPackage();
    stubGateway();
    await DELETE(request("DELETE", { cancellationReason: "חג" }), meetingContext());
    expect(db.userUpdate).not.toHaveBeenCalled();
    expect(db.logFindMany).not.toHaveBeenCalled();
  });

  it.each([
    ["no reason", { restoreCredit: false }],
    ["a blank reason", { cancellationReason: "   " }],
    ["a non-boolean restoreCredit", { cancellationReason: "חג", restoreCredit: "yes" }],
  ])("returns 400 for %s", async (_label, payload) => {
    const res = await DELETE(request("DELETE", payload), meetingContext());
    expect(res.status).toBe(400);
    expect(db.lessonUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses to cancel twice (409)", async () => {
    withData({ lesson: { status: "CANCELLED" } });
    const res = await DELETE(request("DELETE", { cancellationReason: "חג" }), meetingContext());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("השיעור כבר בוטל");
  });
});

describe("security — only representatives, pedagogic managers and admins", () => {
  it.each([
    ["TEACHER (the lesson's own teacher)", staff("TEACHER", TEACHER.id)],
    ["STUDENT (the lesson's own student)", staff("STUDENT", STUDENT.id)],
  ])("blocks a %s with 403 on reschedule, cancel and pending scheduling", async (_label, user) => {
    session.getCurrentUser.mockResolvedValue(user);
    const fetchMock = stubGateway();

    const patch = await PATCH(request("PATCH", { newScheduledAt: NEW_AT }), meetingContext());
    const del = await DELETE(request("DELETE", { cancellationReason: "חג", restoreCredit: true }), meetingContext());
    const pending = await schedulePending(
      request("POST", { lessonId: PENDING_LESSON.id, teacherId: TEACHER.id, scheduledAt: NEW_AT }),
      studentContext()
    );

    expect([patch.status, del.status, pending.status]).toEqual([403, 403, 403]);
    expect(db.lessonFindUnique).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.userUpdate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous caller with 401", async () => {
    session.getCurrentUser.mockResolvedValue(null);
    const patch = await PATCH(request("PATCH", { newScheduledAt: NEW_AT }), meetingContext());
    const del = await DELETE(request("DELETE", { cancellationReason: "חג" }), meetingContext());
    expect([patch.status, del.status]).toEqual([401, 401]);
  });

  it.each(["REPRESENTATIVE", "MANAGER", "ADMIN"])("lets a %s reschedule and cancel", async (role) => {
    session.getCurrentUser.mockResolvedValue(staff(role));
    stubGateway();

    const patch = await PATCH(request("PATCH", { newScheduledAt: NEW_AT }), meetingContext());
    const del = await DELETE(request("DELETE", { cancellationReason: "חג" }), meetingContext());

    expect([patch.status, del.status]).toEqual([200, 200]);
  });
});

describe("resilience — a WhatsApp failure never undoes the DB change", () => {
  const networkDown = async (): Promise<Response> => {
    throw new TypeError("fetch failed");
  };

  it("keeps the new time when the gateway is unreachable", async () => {
    stubGateway(networkDown);

    const res = await PATCH(request("PATCH", { newScheduledAt: NEW_AT }), meetingContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, whatsappDispatched: false, data: { scheduledAt: NEW_AT } });
    expect(db.lessonUpdateMany).toHaveBeenCalledTimes(1);
    expect(db.logCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps the cancellation (and the restored credit) on a 503 gateway error", async () => {
    withDirectPackage();
    stubGateway(async () => new Response("service unavailable", { status: 503 }));

    const res = await DELETE(request("DELETE", { cancellationReason: "חג", restoreCredit: true }), meetingContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ whatsappDispatched: false, data: { status: "CANCELLED", creditRestored: true } });
    expect(lessonUpdate().data).toMatchObject({ status: "CANCELLED" });
    expect(db.userUpdate).toHaveBeenCalledTimes(1);
  });

  it("keeps a scheduled private lesson when the gateway is unreachable", async () => {
    stubGateway(networkDown);

    const res = await schedulePending(
      request("POST", { lessonId: PENDING_LESSON.id, teacherId: TEACHER.id, scheduledAt: NEW_AT }),
      studentContext()
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ whatsappDispatched: false });
    expect(lessonUpdate().data).toMatchObject({ status: "SCHEDULED" });
  });

  it("keeps the change if the WhatsApp step throws, and when the Daily teardown fails", async () => {
    stubGateway();
    vi.mocked(whatsapp.sendQuadGroupLessonCancelled).mockRejectedValueOnce(new Error("boom"));
    daily.deleteDailyRoom.mockRejectedValueOnce(new Error("daily down"));

    const res = await DELETE(request("DELETE", { cancellationReason: "חג" }), meetingContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, whatsappDispatched: false });
    expect(auditCall("LESSON_CANCELLED_BY_STAFF")?.metadata).toMatchObject({ whatsappDispatched: false });
  });

  it("reports whatsappDispatched: false without a quad group", async () => {
    withData({ student: { whatsappGroupId: null }, lesson: { whatsappGroupId: null } });
    const fetchMock = stubGateway();

    const res = await PATCH(request("PATCH", { newScheduledAt: NEW_AT }), meetingContext());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ whatsappDispatched: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("meetings table — lifecycle controls", () => {
  const base = {
    title: "מתמטיקה",
    startTime: null,
    endTime: null,
    durationMinutes: 50,
    teacherId: TEACHER.id,
    studentId: STUDENT.id,
    packageId: null,
    attendanceStatus: null,
    lessonType: "REGULAR",
    whatsappGroupId: GROUP_ID,
    teacher: { name: TEACHER.name },
    package: null,
  };
  const lessons = [
    { ...base, id: "pending", status: "PENDING_SCHEDULE", scheduledAt: LESSON_AT, rescheduledCount: 0 },
    { ...base, id: "open", status: "SCHEDULED", scheduledAt: LESSON_AT, rescheduledCount: 0 },
    { ...base, id: "soon", status: "SCHEDULED", scheduledAt: new Date("2026-09-30T10:00:00.000Z"), rescheduledCount: 0 },
    { ...base, id: "moved", status: "SCHEDULED", scheduledAt: LESSON_AT, rescheduledCount: 1 },
    { ...base, id: "done", status: "COMPLETED", scheduledAt: new Date("2026-09-20T10:00:00.000Z"), rescheduledCount: 0 },
  ];

  it("offers schedule / reschedule / cancel to staff according to status and policy", () => {
    const rows = buildMeetingRows(lessons, { id: "rep", role: "REPRESENTATIVE" }, NOW);
    expect(rows.map((r) => [r.id, r.canSchedulePending, r.canReschedule, r.rescheduleBlock, r.canCancel])).toEqual([
      ["pending", true, false, null, false],
      ["open", false, true, null, true],
      ["soon", false, false, "WITHIN_24H", true],
      ["moved", false, false, "ALREADY_RESCHEDULED", true],
      ["done", false, false, null, false],
    ]);
  });

  it("shows no lifecycle controls to a teacher", () => {
    const rows = buildMeetingRows(lessons, { id: TEACHER.id, role: "TEACHER" }, NOW);
    expect(rows.every((r) => !r.canSchedulePending && !r.canReschedule && !r.canCancel && r.rescheduleBlock === null)).toBe(true);
  });

  it("parses the request bodies", () => {
    expect(parseRescheduleInput({ newScheduledAt: NEW_AT, reason: "  מבחן   בבית הספר " }, NOW)).toEqual({
      ok: true,
      data: { newScheduledAt: new Date(NEW_AT), reason: "מבחן בבית הספר", allowEmergencyOverride: false },
    });
    expect(parseCancelInput({ cancellationReason: "חג" })).toEqual({
      ok: true,
      data: { cancellationReason: "חג", restoreCredit: false },
    });
  });
});
