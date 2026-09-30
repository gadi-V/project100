import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  transaction: vi.fn(),
}));
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
const daily = vi.hoisted(() => ({
  createDailyRoom: vi.fn(),
  deleteDailyRoom: vi.fn(),
  roomNameFromDailyUrl: vi.fn((url: string) => url.split("/").pop() ?? null),
  dailyRoomNameForLesson: vi.fn((id: string) => `lesson-${id}`),
}));

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

import { POST as completeLesson } from "../app/api/portal/students/[id]/meetings/[meetingId]/complete/route";
import { PATCH } from "../app/api/portal/students/[id]/meetings/[meetingId]/route";
import { POST as teacherReschedule } from "../app/api/lessons/[id]/reschedule/route";
import { buildMeetingRows } from "../lib/student-portal";
import { parseRescheduleInput } from "../lib/lesson-lifecycle";
import {
  outcomeEffects,
  parseCompleteLessonInput,
  teacherCompensation,
  TEACHER_HOURLY_RATE_ILS,
} from "../lib/lesson-completion";

/** Tuesday 29.09.2026, 22:00 Israel time. */
const NOW = new Date("2026-09-29T19:00:00.000Z");
/** Same day, 20:00 Israel time: the lesson started two hours ago. */
const STARTED_AT = new Date("2026-09-29T17:00:00.000Z");
/** Wednesday 30.09.2026, 18:00 Israel time: 20 hours from now. */
const SOON_AT = new Date("2026-09-30T15:00:00.000Z");
/** Monday 05.10.2026, 17:00 Israel time. */
const LATER_AT = new Date("2026-10-05T14:00:00.000Z");
const NEW_AT = "2026-10-07T15:30:00.000Z";
const GATEWAY = "https://wa-gateway.example.test";
const GROUP_ID = "120363025555555555@g.us";

const STUDENT = { id: "stu-1", name: "מתן קולמן", role: "STUDENT", whatsappGroupId: GROUP_ID, lessonCredits: 5 };
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

/** Portal-scheduled lesson (title = subject), started two hours ago. */
const PORTAL_LESSON: LessonFixture = {
  id: "lesson-1",
  studentId: STUDENT.id,
  teacherId: TEACHER.id,
  status: "SCHEDULED",
  title: "מתמטיקה 5 יח״ל",
  scheduledAt: STARTED_AT,
  startTime: null,
  durationMinutes: 50,
  rescheduledCount: 0,
  dailyRoomUrl: null,
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
};

function staff(role: string, id = `user-${role.toLowerCase()}`) {
  return { id, name: "שירה מהצוות", role, lessonCredits: 0, isApproved: true };
}

function withLesson(overrides: Partial<LessonFixture> = {}) {
  const lesson = { ...PORTAL_LESSON, ...overrides };
  db.lessonFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === lesson.id) return lesson;
    if (where.id === "foreign-1") return { ...lesson, id: "foreign-1", studentId: "stu-other" };
    return null;
  });
  return lesson;
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

function context(meetingId = PORTAL_LESSON.id, id = STUDENT.id) {
  return { params: Promise.resolve({ id, meetingId }) };
}

function request(method: string, body: unknown) {
  return new Request(`https://project100.example/api/portal/students/${STUDENT.id}/meetings/x`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function complete(body: unknown, meetingId = PORTAL_LESSON.id) {
  return completeLesson(request("POST", body), context(meetingId));
}

function lessonUpdate() {
  return db.lessonUpdateMany.mock.calls[0]?.[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
}

function ledgerEntries() {
  return db.ledgerCreate.mock.calls.map(([arg]) => (arg as { data: Record<string, unknown> }).data);
}

function auditRecord() {
  return db.auditCreate.mock.calls[0]?.[0] as { data: { action: string; entityId: string; metadata: Record<string, unknown> } };
}

function communicationEntry() {
  return db.logCreate.mock.calls[0]?.[0] as { data: { type: string; content: string; structuredData: Record<string, unknown> } };
}

function staffAudit(action: string) {
  return audit.writeAuditLog.mock.calls
    .map(([entry]) => entry as { action: string; metadata: Record<string, unknown> })
    .find((entry) => entry.action === action);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubGateway() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === `${GATEWAY}/sendMessage`) return json({ idMessage: "msg-1" });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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
    return [STUDENT, TEACHER, OTHER_TEACHER].find((u) => u.id === where.id) ?? null;
  });
  withLesson();
  db.lessonFindFirst.mockImplementation(async ({ where }: { where: { teacherId?: string; status?: unknown } }) => {
    if (where.status) return null;
    return where.teacherId === TEACHER.id || where.teacherId === OTHER_TEACHER.id ? { id: "any-lesson" } : null;
  });
  db.referralFindFirst.mockResolvedValue(null);
  db.transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  db.lessonUpdateMany.mockResolvedValue({ count: 1 });
  db.userUpdateMany.mockResolvedValue({ count: 1 });
  db.userUpdate.mockResolvedValue({ lessonCredits: 6 });
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
  db.ledgerCreate.mockImplementation(async () => ({ id: `ledger-${db.ledgerCreate.mock.calls.length}` }));
  db.ledgerFindUnique.mockResolvedValue(null);
  db.auditCreate.mockResolvedValue({ id: "audit-1" });
  daily.deleteDailyRoom.mockResolvedValue(undefined);
  audit.writeAuditLog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("POST …/meetings/[meetingId]/complete — attended lesson", () => {
  it("marks the lesson COMPLETED and books the teacher's pay at the hourly rate", async () => {
    const res = await complete({ attendanceStatus: "ATTENDED", internalNotes: "  עבדנו על  נגזרות  " });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      lessonId: PORTAL_LESSON.id,
      status: "COMPLETED",
      attendanceStatus: "ATTENDED",
      teacherCompensated: true,
      compensationAmount: 140,
      promptSummary: true,
    });

    expect(lessonUpdate().where).toEqual({ id: PORTAL_LESSON.id, status: { in: ["SCHEDULED", "IN_PROGRESS"] } });
    expect(lessonUpdate().data).toMatchObject({
      status: "COMPLETED",
      attendanceStatus: "PRESENT",
      attendanceMarkedById: TEACHER.id,
    });

    expect(db.payoutCreate).toHaveBeenCalledTimes(1);
    expect(db.payoutCreate.mock.calls[0][0].data).toMatchObject({
      teacherId: TEACHER.id,
      amount: 140,
      lessonId: PORTAL_LESSON.id,
      idempotencyKey: `lesson-payout-${PORTAL_LESSON.id}`,
      status: "SCHEDULED",
      periodStart: STARTED_AT,
      periodEnd: new Date(STARTED_AT.getTime() + 50 * 60_000),
    });
    expect(db.payoutCreate.mock.calls[0][0].data.metadata).toMatchObject({
      attendanceStatus: "ATTENDED",
      hourlyRate: TEACHER_HOURLY_RATE_ILS,
      feeSplit: { lessonValue: 200, platformFee: 60, tutorPayout: 140 },
    });
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({ userId: TEACHER.id, entryType: "PAYOUT", amount: 140, relatedId: "payout-1" }),
      expect.objectContaining({
        userId: TEACHER.id,
        entryType: "PLATFORM_FEE",
        amount: 60,
        transactionId: `lesson-payout-${PORTAL_LESSON.id}-fee`,
      }),
    ]);

    const record = auditRecord().data;
    expect(record.action).toBe("LESSON_COMPLETED_ATTENDANCE_RECORDED");
    expect(record.entityId).toBe(PORTAL_LESSON.id);
    expect(record.metadata).toMatchObject({ attendanceStatus: "ATTENDED", lessonStatus: "COMPLETED", payoutId: "payout-1" });

    const entry = communicationEntry().data;
    expect(entry.type).toBe("GENERAL");
    expect(entry.content).toContain("השיעור התקיים בהצלחה");
    expect(entry.content).toContain("שכר מורה נרשם לתשלום: 140 ₪");
    expect(entry.content).toContain("הערות פנימיות: עבדנו על  נגזרות");
    expect(entry.structuredData).toMatchObject({ source: "LESSON_COMPLETED", teacherCompensated: true });
  });

  it("pays a 90-minute lesson by the hour (1.5 × 140 ₪)", async () => {
    withLesson({ durationMinutes: 90 });
    const body = await (await complete({ attendanceStatus: "ATTENDED" })).json();

    expect(body.compensationAmount).toBe(210);
    expect(ledgerEntries().map((e) => [e.entryType, e.amount])).toEqual([
      ["PAYOUT", 210],
      ["PLATFORM_FEE", 90],
    ]);
  });

  it("takes one lesson from a direct-package balance when the lesson is completed", async () => {
    withDirectPackage();
    const body = await (await complete({ attendanceStatus: "ATTENDED" })).json();

    expect(body).toMatchObject({ creditCharged: true, creditRestored: false, lessonCredits: 5 });
    expect(db.userUpdateMany).toHaveBeenCalledWith({
      where: { id: STUDENT.id, lessonCredits: { gt: 0 } },
      data: { lessonCredits: { decrement: 1 } },
    });
  });

  it("leaves the balance alone for a student outside the direct package track", async () => {
    const body = await (await complete({ attendanceStatus: "ATTENDED" })).json();

    expect(body.creditCharged).toBe(false);
    expect(db.userUpdateMany).not.toHaveBeenCalled();
    expect(db.userUpdate).not.toHaveBeenCalled();
  });

  it("does not book the platform fee twice when the lesson was already paid", async () => {
    db.payoutFindUnique.mockResolvedValue({
      id: "payout-old",
      teacherId: TEACHER.id,
      amount: { toString: () => "140" },
      currency: "ILS",
      status: "SCHEDULED",
    });
    db.ledgerFindUnique.mockResolvedValue({ id: "fee-old" });

    const res = await complete({ attendanceStatus: "ATTENDED" });

    expect(res.status).toBe(200);
    expect(db.payoutCreate).not.toHaveBeenCalled();
    expect(db.ledgerCreate).not.toHaveBeenCalled();
  });
});

describe("POST …/complete — student no-show", () => {
  it("still pays the teacher and takes the lesson from the student's package", async () => {
    session.getCurrentUser.mockResolvedValue(staff("MANAGER"));
    withDirectPackage();

    const res = await complete({ attendanceStatus: "STUDENT_NO_SHOW" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      status: "COMPLETED",
      teacherCompensated: true,
      compensationAmount: 140,
      creditCharged: true,
      promptSummary: false,
    });
    expect(lessonUpdate().data).toMatchObject({ status: "COMPLETED", attendanceStatus: "ABSENT" });
    expect(db.payoutCreate.mock.calls[0][0].data).toMatchObject({ teacherId: TEACHER.id, amount: 140 });
    expect(db.userUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lessonCredits: { decrement: 1 } } })
    );
    expect(communicationEntry().data.content).toContain("ירד שיעור אחד מיתרת החבילה (נותרו 5)");
  });

  it("does not take a second credit when the lesson was paid for at booking", async () => {
    withLesson({ title: null });
    withDirectPackage();

    const body = await (await complete({ attendanceStatus: "STUDENT_NO_SHOW" })).json();

    expect(body).toMatchObject({ teacherCompensated: true, creditCharged: false });
    expect(db.userUpdateMany).not.toHaveBeenCalled();
    expect(auditRecord().data.metadata).toMatchObject({ creditTakenAtBooking: true, creditCharged: false });
  });

  it("closes the lesson but reports an empty package balance instead of going negative", async () => {
    withDirectPackage();
    db.userUpdateMany.mockResolvedValue({ count: 0 });

    const body = await (await complete({ attendanceStatus: "STUDENT_NO_SHOW" })).json();

    expect(body).toMatchObject({ success: true, creditCharged: false, lessonCredits: null });
    expect(auditRecord().data.metadata).toMatchObject({ directPackageBalanceEmpty: true });
    expect(communicationEntry().data.content).toContain("יתרת החבילה ריקה");
  });
});

describe("POST …/complete — teacher cancelled", () => {
  it("does not pay the teacher and returns the credit taken at booking", async () => {
    withLesson({ title: null });

    const res = await complete({ attendanceStatus: "TEACHER_CANCELLED", internalNotes: "המורה חלה" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      status: "CANCELLED",
      teacherCompensated: false,
      compensationAmount: null,
      creditRestored: true,
      creditCharged: false,
      promptSummary: false,
    });
    expect(lessonUpdate().data).toMatchObject({ status: "CANCELLED", canceledById: TEACHER.id });
    expect(lessonUpdate().data).not.toHaveProperty("attendanceStatus");
    expect(db.payoutCreate).not.toHaveBeenCalled();
    expect(db.ledgerCreate).not.toHaveBeenCalled();
    expect(db.userUpdate).toHaveBeenCalledWith({ where: { id: STUDENT.id }, data: { lessonCredits: { increment: 1 } } });
    expect(communicationEntry().data.content).toContain("המורה לא מתוגמל על שיעור זה");
  });

  it("keeps a portal lesson off the package balance, so the student loses nothing", async () => {
    withDirectPackage();

    const body = await (await complete({ attendanceStatus: "TEACHER_CANCELLED" })).json();

    expect(body).toMatchObject({ status: "CANCELLED", teacherCompensated: false, creditCharged: false, creditRestored: false });
    expect(db.userUpdateMany).not.toHaveBeenCalled();
    expect(db.userUpdate).not.toHaveBeenCalled();
    expect(db.payoutCreate).not.toHaveBeenCalled();
  });
});

describe("POST …/complete — guards", () => {
  it("refuses a lesson that has not started yet (409)", async () => {
    withLesson({ scheduledAt: SOON_AT });
    const res = await complete({ attendanceStatus: "ATTENDED" });

    expect(res.status).toBe(409);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a lesson that was already closed (409) without paying again", async () => {
    withLesson({ status: "COMPLETED" });
    const res = await complete({ attendanceStatus: "ATTENDED" });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("השיעור כבר סומן כהסתיים");
    expect(db.payoutCreate).not.toHaveBeenCalled();
  });

  it("answers 409 when a parallel request closed the lesson first", async () => {
    db.lessonUpdateMany.mockResolvedValue({ count: 0 });
    const res = await complete({ attendanceStatus: "ATTENDED" });

    expect(res.status).toBe(409);
    expect(db.payoutCreate).not.toHaveBeenCalled();
    expect(db.auditCreate).not.toHaveBeenCalled();
  });

  it("validates the attendance status (400)", async () => {
    const res = await complete({ attendanceStatus: "PRESENT" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a lesson of another student", async () => {
    const res = await complete({ attendanceStatus: "ATTENDED" }, "foreign-1");
    expect(res.status).toBe(404);
  });
});

describe("security — who may close a lesson", () => {
  it("rejects the student with 403 and writes nothing", async () => {
    session.getCurrentUser.mockResolvedValue({ ...STUDENT, isApproved: true });
    const res = await complete({ attendanceStatus: "ATTENDED" });

    expect(res.status).toBe(403);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.payoutCreate).not.toHaveBeenCalled();
  });

  it("rejects a representative with 403", async () => {
    session.getCurrentUser.mockResolvedValue(staff("REPRESENTATIVE"));
    const res = await complete({ attendanceStatus: "ATTENDED" });
    expect(res.status).toBe(403);
  });

  it("rejects another teacher of the same student with 403", async () => {
    session.getCurrentUser.mockResolvedValue(OTHER_TEACHER);
    const res = await complete({ attendanceStatus: "ATTENDED" });

    expect(res.status).toBe(403);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects an anonymous caller with 401", async () => {
    session.getCurrentUser.mockResolvedValue(null);
    const res = await complete({ attendanceStatus: "ATTENDED" });
    expect(res.status).toBe(401);
  });

  it.each(["MANAGER", "ADMIN"])("lets %s close any lesson", async (role) => {
    session.getCurrentUser.mockResolvedValue(staff(role));
    const res = await complete({ attendanceStatus: "ATTENDED" });
    expect(res.status).toBe(200);
  });
});

describe("PATCH …/meetings/[meetingId] — emergency reschedule override", () => {
  const upcoming = (overrides: Partial<LessonFixture> = {}) =>
    withLesson({ scheduledAt: SOON_AT, dailyRoomUrl: null, ...overrides });

  it("lets the pedagogic manager move a lesson inside 24 hours with allowEmergencyOverride", async () => {
    stubGateway();
    upcoming();
    session.getCurrentUser.mockResolvedValue(staff("MANAGER"));

    const res = await PATCH(
      request("PATCH", { newScheduledAt: NEW_AT, reason: "המורה אושפז", allowEmergencyOverride: true }),
      context()
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ scheduledAt: NEW_AT, emergencyOverride: true });
    expect(body.whatsappDispatched).toBe(true);
    expect(lessonUpdate().data).toMatchObject({ scheduledAt: new Date(NEW_AT), rescheduledCount: { increment: 1 } });
    expect(communicationEntry().data.content).toContain("שינוי חירום באישור הנהלה");
    expect(communicationEntry().data.structuredData).toMatchObject({ emergencyOverride: true });
    expect(staffAudit("LESSON_RESCHEDULED_BY_STAFF")?.metadata).toMatchObject({
      emergencyOverride: true,
      overriddenPolicy: "WITHIN_24H",
      approvedBy: { id: "user-manager", role: "MANAGER" },
      note: "שינוי חירום באישור הנהלה",
    });
  });

  it("lets an admin move a lesson a second time with the override", async () => {
    upcoming({ scheduledAt: LATER_AT, rescheduledCount: 1, whatsappGroupId: null });
    db.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === STUDENT.id ? { ...STUDENT, whatsappGroupId: null } : null
    );
    session.getCurrentUser.mockResolvedValue(staff("ADMIN"));

    const res = await PATCH(request("PATCH", { newScheduledAt: NEW_AT, allowEmergencyOverride: true }), context());

    expect(res.status).toBe(200);
    expect(staffAudit("LESSON_RESCHEDULED_BY_STAFF")?.metadata).toMatchObject({
      emergencyOverride: true,
      overriddenPolicy: "ALREADY_RESCHEDULED",
    });
  });

  it("still blocks the manager inside 24 hours without the flag (422)", async () => {
    upcoming();
    session.getCurrentUser.mockResolvedValue(staff("MANAGER"));

    const res = await PATCH(request("PATCH", { newScheduledAt: NEW_AT }), context());

    expect(res.status).toBe(422);
    expect(db.lessonUpdateMany).not.toHaveBeenCalled();
  });

  it("ignores the flag from a representative (422, management only)", async () => {
    upcoming();
    session.getCurrentUser.mockResolvedValue(staff("REPRESENTATIVE"));

    const res = await PATCH(request("PATCH", { newScheduledAt: NEW_AT, allowEmergencyOverride: true }), context());

    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("שינוי מועד חריג מותר רק למנהל/ת פדגוגי/ת או לאדמין");
    expect(db.lessonUpdateMany).not.toHaveBeenCalled();
  });

  it("blocks a teacher with 422 inside 24 hours even when the flag is sent", async () => {
    const lesson = upcoming();
    db.lessonFindUnique.mockResolvedValue(lesson);

    const res = await teacherReschedule(
      new Request(`https://project100.example/api/lessons/${lesson.id}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newSlotId: "slot-9", allowEmergencyOverride: true }),
      }),
      { params: Promise.resolve({ id: lesson.id }) }
    );

    expect(res.status).toBe(422);
    expect(db.lessonUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps the staff reschedule endpoint closed to teachers (403)", async () => {
    upcoming();
    const res = await PATCH(request("PATCH", { newScheduledAt: NEW_AT, allowEmergencyOverride: true }), context());
    expect(res.status).toBe(403);
  });

  it("rejects a non-boolean override flag", () => {
    const parsed = parseRescheduleInput({ newScheduledAt: NEW_AT, allowEmergencyOverride: "yes" }, NOW);
    expect(parsed.ok).toBe(false);
    expect(parseRescheduleInput({ newScheduledAt: NEW_AT }, NOW)).toMatchObject({
      ok: true,
      data: { allowEmergencyOverride: false },
    });
  });
});

describe("meetings table — completion and emergency controls", () => {
  const lessonRow = (overrides: Partial<{ scheduledAt: Date; status: string; rescheduledCount: number }> = {}) => ({
    id: "row-1",
    title: "מתמטיקה",
    scheduledAt: STARTED_AT,
    startTime: null,
    endTime: null,
    durationMinutes: 50,
    status: "SCHEDULED",
    teacherId: TEACHER.id,
    studentId: STUDENT.id,
    packageId: null,
    attendanceStatus: null,
    lessonType: "REGULAR",
    whatsappGroupId: GROUP_ID,
    rescheduledCount: 0,
    teacher: { name: TEACHER.name },
    package: null,
    ...overrides,
  });
  const row = (viewer: { id: string; role: string }, overrides = {}) => buildMeetingRows([lessonRow(overrides)], viewer, NOW)[0];

  it("offers the completion button to the lesson's teacher and to management once the lesson started", () => {
    expect(row({ id: TEACHER.id, role: "TEACHER" }).canComplete).toBe(true);
    expect(row({ id: "m", role: "MANAGER" }).canComplete).toBe(true);
    expect(row({ id: "a", role: "ADMIN" }).canComplete).toBe(true);
    expect(row({ id: "m", role: "MANAGER" }, { status: "IN_PROGRESS" }).canComplete).toBe(true);
  });

  it("hides it from other viewers, from future lessons and from closed lessons", () => {
    expect(row({ id: OTHER_TEACHER.id, role: "TEACHER" }).canComplete).toBe(false);
    expect(row({ id: "r", role: "REPRESENTATIVE" }).canComplete).toBe(false);
    expect(row({ id: STUDENT.id, role: "STUDENT" }).canComplete).toBe(false);
    expect(row({ id: "m", role: "MANAGER" }, { scheduledAt: SOON_AT }).canComplete).toBe(false);
    expect(row({ id: "m", role: "MANAGER" }, { status: "COMPLETED" }).canComplete).toBe(false);
  });

  it("lets management open the reschedule modal for a blocked lesson, but not a representative", () => {
    const manager = row({ id: "m", role: "MANAGER" }, { scheduledAt: SOON_AT });
    expect(manager).toMatchObject({ canReschedule: false, rescheduleBlock: "WITHIN_24H", canEmergencyReschedule: true });

    const representative = row({ id: "r", role: "REPRESENTATIVE" }, { scheduledAt: SOON_AT });
    expect(representative).toMatchObject({ canReschedule: false, canEmergencyReschedule: false });

    expect(row({ id: "m", role: "MANAGER" }, { scheduledAt: LATER_AT }).canEmergencyReschedule).toBe(false);
  });
});

describe("completion rules", () => {
  it("pays the hourly rate per 60-minute block (at least one block)", () => {
    expect(TEACHER_HOURLY_RATE_ILS).toBe(140);
    expect(teacherCompensation(50)).toEqual({ billedHours: 1, lessonValue: 200, platformFee: 60, teacherPayout: 140 });
    expect(teacherCompensation(null).teacherPayout).toBe(140);
    expect(teacherCompensation(120)).toMatchObject({ lessonValue: 400, teacherPayout: 280 });
  });

  it("maps each outcome to status, pay and credit", () => {
    expect(outcomeEffects("ATTENDED")).toMatchObject({ status: "COMPLETED", compensateTeacher: true, consumesCredit: true });
    expect(outcomeEffects("STUDENT_NO_SHOW")).toMatchObject({ status: "COMPLETED", compensateTeacher: true, consumesCredit: true });
    expect(outcomeEffects("TEACHER_CANCELLED")).toMatchObject({ status: "CANCELLED", compensateTeacher: false, consumesCredit: false });
  });

  it("parses the completion body", () => {
    expect(parseCompleteLessonInput({ attendanceStatus: "ATTENDED", internalNotes: "  " })).toEqual({
      ok: true,
      data: { attendanceStatus: "ATTENDED", internalNotes: null },
    });
    expect(parseCompleteLessonInput({ attendanceStatus: "ATTENDED", internalNotes: 5 }).ok).toBe(false);
    expect(parseCompleteLessonInput({ attendanceStatus: "ATTENDED", internalNotes: "x".repeat(1001) }).ok).toBe(false);
    expect(parseCompleteLessonInput(null).ok).toBe(false);
  });
});
