import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  userUpdateMany: vi.fn(),
  lessonFindFirst: vi.fn(),
  lessonFindMany: vi.fn(),
  lessonCreate: vi.fn(),
  lessonUpdate: vi.fn(),
  transaction: vi.fn(),
}));
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: db.userFindUnique, findMany: db.userFindMany, updateMany: db.userUpdateMany },
    lesson: {
      findFirst: db.lessonFindFirst,
      findMany: db.lessonFindMany,
      create: db.lessonCreate,
      update: db.lessonUpdate,
    },
    $transaction: db.transaction,
  },
}));
vi.mock("../lib/session", () => session);
vi.mock("../lib/audit", () => audit);
vi.mock("../lib/whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/whatsapp")>();
  return {
    ...actual,
    createWhatsAppQuadGroup: vi.fn(actual.createWhatsAppQuadGroup),
    sendQuadGroupLessonUpdate: vi.fn(actual.sendQuadGroupLessonUpdate),
  };
});

import { GET, POST } from "../app/api/portal/students/[id]/meetings/route";
import * as whatsapp from "../lib/whatsapp";
import { buildMeetingRows } from "../lib/student-portal";
import {
  israelDateKey,
  israelLocalToIso,
  parseScheduleMeetingInput,
} from "../lib/student-portal-shared";

type FetchMock = ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>;

const GATEWAY = "https://wa-gateway.example.test";
const GROUP_ID = "120363025555555555@g.us";
const EXISTING_GROUP_ID = "120363011111111111@g.us";
const INVITE = "https://chat.whatsapp.com/Inv1te";
const JIDS = {
  student: "972541234567@c.us",
  teacher: "972527654321@c.us",
  parent: "972501112233@c.us",
  admin: "972509998877@c.us",
};

const NOW = new Date("2026-09-29T19:00:00.000Z");
/** Monday 05.10.2026, 17:00 Israel time (UTC+3). */
const LESSON_AT = "2026-10-05T14:00:00.000Z";

const STUDENT = {
  id: "stu-1",
  name: "מתן קולמן",
  role: "STUDENT",
  phone: "054-123-4567",
  parentName: "דנה קולמן",
  parentPhone: "0501112233",
  whatsappGroupId: null as string | null,
};
const TEACHER = { id: "teacher-1", name: "רונית לוי", role: "TEACHER", phone: "+972 52 765 4321" };

const tx = { lesson: { findFirst: db.lessonFindFirst, create: db.lessonCreate } };

function staff(role: string) {
  return { id: `user-${role.toLowerCase()}`, name: "שירה", role, lessonCredits: 0, isApproved: true };
}

function context(id = STUDENT.id) {
  return { params: Promise.resolve({ id }) };
}

function scheduleRequest(body: Record<string, unknown>) {
  return new Request(`https://project100.example/api/portal/students/${STUDENT.id}/meetings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const mappingBody = (overrides: Record<string, unknown> = {}) => ({
  teacherId: TEACHER.id,
  subject: "מתמטיקה 5 יח״ל",
  scheduledAt: LESSON_AT,
  lessonType: "MAPPING",
  ...overrides,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubGateway(
  groupResponse: () => Promise<Response> = async () =>
    json({ created: true, chatId: GROUP_ID, groupInviteLink: INVITE }),
  sendResponse: () => Promise<Response> = async () => json({ idMessage: "msg-1" })
): FetchMock {
  const fetchMock: FetchMock = vi.fn(async (url: string) => {
    if (url === `${GATEWAY}/createGroup`) return groupResponse();
    if (url === `${GATEWAY}/sendMessage`) return sendResponse();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: FetchMock, path: string) {
  return fetchMock.mock.calls.filter(([url]) => url === `${GATEWAY}${path}`);
}

function bodyOf(call: [string, RequestInit]): Record<string, unknown> {
  return JSON.parse(String(call[1].body)) as Record<string, unknown>;
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
    if (where.id === "rep-1") return { id: "rep-1", name: "נציג", role: "REPRESENTATIVE", phone: "0520000000" };
    return null;
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("WHATSAPP_API_URL", GATEWAY);
  vi.stubEnv("WHATSAPP_API_KEY", "wa-key");
  vi.stubEnv("WHATSAPP_ADMIN_PHONE", "050-999-8877");
  vi.stubEnv("APP_URL", "https://project100.example");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  session.getCurrentUser.mockResolvedValue(staff("REPRESENTATIVE"));
  withStudent();
  db.transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  db.lessonFindFirst.mockResolvedValue(null);
  db.lessonCreate.mockResolvedValue({ id: "lesson-new" });
  db.lessonUpdate.mockResolvedValue({});
  db.userUpdateMany.mockResolvedValue({ count: 1 });
  audit.writeAuditLog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("POST /api/portal/students/[id]/meetings — access", () => {
  it("rejects an anonymous caller with 401 before touching the database", async () => {
    session.getCurrentUser.mockResolvedValue(null);
    const fetchMock = stubGateway();

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(res.status).toBe(401);
    expect(db.userFindUnique).not.toHaveBeenCalled();
    expect(db.lessonCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["TEACHER", "STUDENT"])("rejects a %s with 403", async (role) => {
    session.getCurrentUser.mockResolvedValue(staff(role));
    const fetchMock = stubGateway();

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(res.status).toBe(403);
    expect(db.lessonCreate).not.toHaveBeenCalled();
    expect(whatsapp.createWhatsAppQuadGroup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["REPRESENTATIVE", "ADMIN", "MANAGER"])("lets a %s schedule", async (role) => {
    session.getCurrentUser.mockResolvedValue(staff(role));
    stubGateway();

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(res.status).toBe(201);
  });

  it("answers 404 for an id that is not a student", async () => {
    const res = await POST(scheduleRequest(mappingBody()), context("rep-1"));
    expect(res.status).toBe(404);
    expect(db.lessonCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/portal/students/[id]/meetings — validation", () => {
  it.each([
    ["a past date", { scheduledAt: "2026-09-01T10:00:00.000Z" }],
    ["an invalid date", { scheduledAt: "not-a-date" }],
    ["no teacher", { teacherId: "" }],
    ["an empty subject", { subject: "   " }],
    ["an unknown lesson type", { lessonType: "TRIAL" }],
    ["a too long duration", { durationMinutes: 600 }],
  ])("returns 400 for %s", async (_label, overrides) => {
    const res = await POST(scheduleRequest(mappingBody(overrides)), context());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false });
    expect(db.lessonCreate).not.toHaveBeenCalled();
  });

  it("returns 404 when the selected user is not a teacher", async () => {
    const res = await POST(scheduleRequest(mappingBody({ teacherId: "rep-1" })), context());
    expect(res.status).toBe(404);
    expect(db.lessonCreate).not.toHaveBeenCalled();
  });

  it("refuses a slot that collides with another active lesson (409) and opens no group", async () => {
    db.lessonFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "busy" });
    const fetchMock = stubGateway();

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(res.status).toBe(409);
    expect(db.lessonCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const [studentCheck, teacherCheck] = db.lessonFindFirst.mock.calls.map(([arg]) => arg.where);
    expect(studentCheck).toMatchObject({ studentId: STUDENT.id, status: { in: ["SCHEDULED", "IN_PROGRESS"] } });
    expect(teacherCheck).toMatchObject({ teacherId: TEACHER.id });
    expect(teacherCheck.scheduledAt.gt).toEqual(new Date("2026-10-05T13:00:00.000Z"));
    expect(teacherCheck.scheduledAt.lt).toEqual(new Date("2026-10-05T15:00:00.000Z"));
  });
});

describe("POST /api/portal/students/[id]/meetings — lesson and quad group", () => {
  it("creates a SCHEDULED mapping lesson with every required field (45 minutes by default)", async () => {
    stubGateway();

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(res.status).toBe(201);
    expect(db.lessonCreate).toHaveBeenCalledWith({
      data: {
        studentId: STUDENT.id,
        teacherId: TEACHER.id,
        title: "מתמטיקה 5 יח״ל",
        scheduledAt: new Date(LESSON_AT),
        durationMinutes: 45,
        status: "SCHEDULED",
        lessonType: "MAPPING",
      },
      select: { id: true },
    });
    expect(await res.json()).toEqual({
      success: true,
      data: {
        lessonId: "lesson-new",
        lessonType: "MAPPING",
        scheduledAt: LESSON_AT,
        durationMinutes: 45,
        teacherName: TEACHER.name,
        groupStatus: "OPENED",
        whatsappGroupCreated: true,
        whatsappGroupLinked: true,
        groupUpdateSent: false,
        whatsappErrorCode: null,
      },
    });
  });

  it("opens the quad group with student, teacher, parent and admin and posts the welcome message", async () => {
    const fetchMock = stubGateway();

    await POST(scheduleRequest(mappingBody()), context());

    expect(whatsapp.createWhatsAppQuadGroup).toHaveBeenCalledTimes(1);
    expect(whatsapp.createWhatsAppQuadGroup).toHaveBeenCalledWith({
      student: { name: STUDENT.name, phone: STUDENT.phone },
      teacher: { name: TEACHER.name, phone: TEACHER.phone },
      parent: { name: STUDENT.parentName, phone: STUDENT.parentPhone },
      lesson: { scheduledAt: new Date(LESSON_AT), durationMinutes: 45, subject: "מתמטיקה 5 יח״ל" },
      questionnaireUrl: "https://project100.example/onboarding/diagnostic",
    });

    const createGroup = callsTo(fetchMock, "/createGroup");
    expect(createGroup).toHaveLength(1);
    expect(bodyOf(createGroup[0]).chatIds).toEqual([JIDS.student, JIDS.teacher, JIDS.parent, JIDS.admin]);

    const welcome = bodyOf(callsTo(fetchMock, "/sendMessage")[0]);
    expect(welcome.chatId).toBe(GROUP_ID);
    expect(String(welcome.message)).toContain("ביום שני 05.10.2026 יתקיים שיעור המיפוי שלך בשעה 17:00-17:45");
    expect(String(welcome.message)).toContain("https://project100.example/onboarding/diagnostic");
  });

  it("stores the group id on the student (only if still empty) and on the lesson, and audits both steps", async () => {
    stubGateway();

    await POST(scheduleRequest(mappingBody()), context());

    expect(db.userUpdateMany).toHaveBeenCalledWith({
      where: { id: STUDENT.id, whatsappGroupId: null },
      data: { whatsappGroupId: GROUP_ID, quadGroupUrl: INVITE },
    });
    expect(db.lessonUpdate).toHaveBeenCalledWith({
      where: { id: "lesson-new" },
      data: { whatsappGroupId: GROUP_ID },
    });

    expect(auditCall("MAPPING_LESSON_SCHEDULED")).toMatchObject({
      entityType: "Lesson",
      entityId: "lesson-new",
      metadata: {
        studentId: STUDENT.id,
        teacherId: TEACHER.id,
        lessonType: "MAPPING",
        groupStatus: "OPENED",
        whatsappGroupCreated: true,
      },
    });
    expect(auditCall("WHATSAPP_QUAD_GROUP_CREATED")).toMatchObject({
      entityType: "User",
      entityId: STUDENT.id,
      metadata: {
        chatId: GROUP_ID,
        lessonId: "lesson-new",
        roles: ["STUDENT", "TEACHER", "PARENT", "ADMIN"],
        welcomeSent: true,
      },
    });
  });

  it("opens a group without the parent when no parent phone is stored", async () => {
    withStudent({ parentPhone: null as unknown as string, parentName: null as unknown as string });
    const fetchMock = stubGateway();

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(await res.json()).toMatchObject({ data: { whatsappGroupCreated: true } });
    expect(bodyOf(callsTo(fetchMock, "/createGroup")[0]).chatIds).toEqual([JIDS.student, JIDS.teacher, JIDS.admin]);
  });

  it("schedules a regular lesson without opening a group when the student has none", async () => {
    const fetchMock = stubGateway();

    const res = await POST(
      scheduleRequest(mappingBody({ lessonType: "REGULAR", subject: "פיזיקה" })),
      context()
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      data: { lessonType: "REGULAR", durationMinutes: 50, groupStatus: "NOT_OPENED", whatsappGroupCreated: false },
    });
    expect(whatsapp.createWhatsAppQuadGroup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditCall("LESSON_SCHEDULED")).toMatchObject({ entityId: "lesson-new" });
  });
});

describe("POST /api/portal/students/[id]/meetings — idempotency", () => {
  it("does not open a second group; it posts a lesson update into the existing one", async () => {
    withStudent({ whatsappGroupId: EXISTING_GROUP_ID });
    const fetchMock = stubGateway();

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      data: {
        groupStatus: "EXISTING",
        whatsappGroupCreated: false,
        whatsappGroupLinked: true,
        groupUpdateSent: true,
      },
    });
    expect(whatsapp.createWhatsAppQuadGroup).not.toHaveBeenCalled();
    expect(callsTo(fetchMock, "/createGroup")).toHaveLength(0);

    const update = bodyOf(callsTo(fetchMock, "/sendMessage")[0]);
    expect(update.chatId).toBe(EXISTING_GROUP_ID);
    expect(String(update.message)).toContain("נקבע שיעור מיפוי חדש");
    expect(String(update.message)).toContain("ביום שני 05.10.2026 בשעה 17:00-17:45 עם רונית לוי");

    expect(db.userUpdateMany).not.toHaveBeenCalled();
    expect(db.lessonUpdate).toHaveBeenCalledWith({
      where: { id: "lesson-new" },
      data: { whatsappGroupId: EXISTING_GROUP_ID },
    });
  });

  it("keeps the group stored by a parallel request and links the lesson to it", async () => {
    stubGateway();
    db.userUpdateMany.mockResolvedValue({ count: 0 });
    db.userFindUnique.mockImplementation(async ({ where, select }: { where: { id: string }; select: Record<string, boolean> }) => {
      if (where.id === TEACHER.id) return TEACHER;
      if (where.id !== STUDENT.id) return null;
      const onlyGroup = Object.keys(select).length === 1 && select.whatsappGroupId;
      return onlyGroup ? { whatsappGroupId: EXISTING_GROUP_ID } : STUDENT;
    });

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(await res.json()).toMatchObject({ data: { groupStatus: "EXISTING", whatsappGroupCreated: false } });
    expect(db.lessonUpdate).toHaveBeenCalledWith({
      where: { id: "lesson-new" },
      data: { whatsappGroupId: EXISTING_GROUP_ID },
    });
    expect(auditCall("WHATSAPP_QUAD_GROUP_CREATED")?.metadata).toMatchObject({ duplicate: true });
  });

  it("createWhatsAppQuadGroup refuses to open a group when one is already stored", async () => {
    const fetchMock = stubGateway();

    const result = await whatsapp.createWhatsAppQuadGroup({
      student: { name: STUDENT.name, phone: STUDENT.phone },
      teacher: { name: TEACHER.name, phone: TEACHER.phone },
      lesson: { scheduledAt: new Date(LESSON_AT), durationMinutes: 45 },
      existingGroupId: EXISTING_GROUP_ID,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "ALREADY_EXISTS" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/portal/students/[id]/meetings — gateway failures never lose the lesson", () => {
  it("keeps the lesson on a 503 gateway error and reports whatsappGroupCreated: false", async () => {
    stubGateway(async () => new Response("service unavailable", { status: 503 }));

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      success: true,
      data: {
        lessonId: "lesson-new",
        groupStatus: "FAILED",
        whatsappGroupCreated: false,
        whatsappGroupLinked: false,
        whatsappErrorCode: "GATEWAY_ERROR",
      },
    });
    expect(db.lessonCreate).toHaveBeenCalledTimes(1);
    expect(db.userUpdateMany).not.toHaveBeenCalled();
    expect(db.lessonUpdate).not.toHaveBeenCalled();
    expect(auditCall("WHATSAPP_QUAD_GROUP_CREATED")).toBeUndefined();
    expect(auditCall("MAPPING_LESSON_SCHEDULED")?.metadata).toMatchObject({
      groupStatus: "FAILED",
      whatsappErrorCode: "GATEWAY_ERROR",
    });
  });

  it("keeps the lesson when the gateway is unreachable (network error)", async () => {
    stubGateway(async () => {
      throw new TypeError("fetch failed");
    });

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      data: { whatsappGroupCreated: false, whatsappErrorCode: "NETWORK" },
    });
    expect(db.lessonCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps the lesson when WhatsApp is not configured", async () => {
    vi.stubEnv("WHATSAPP_API_URL", "");
    const fetchMock = stubGateway();

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      data: { whatsappGroupCreated: false, whatsappErrorCode: "NOT_CONFIGURED" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the lesson linked to an existing group even when the update message fails", async () => {
    withStudent({ whatsappGroupId: EXISTING_GROUP_ID });
    stubGateway(undefined, async () => {
      throw new TypeError("fetch failed");
    });

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      data: { groupStatus: "EXISTING", groupUpdateSent: false, whatsappGroupLinked: true },
    });
  });

  it("still answers 201 if the WhatsApp step throws unexpectedly", async () => {
    vi.mocked(whatsapp.createWhatsAppQuadGroup).mockRejectedValueOnce(new Error("boom"));

    const res = await POST(scheduleRequest(mappingBody()), context());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      data: { groupStatus: "FAILED", whatsappGroupCreated: false, whatsappErrorCode: "UNEXPECTED" },
    });
  });
});

describe("GET /api/portal/students/[id]/meetings", () => {
  it("returns the meetings and approved teachers to staff", async () => {
    db.lessonFindMany.mockResolvedValue([
      {
        id: "lesson-new",
        title: "מתמטיקה",
        scheduledAt: new Date(LESSON_AT),
        startTime: null,
        endTime: null,
        durationMinutes: 45,
        status: "SCHEDULED",
        teacherId: TEACHER.id,
        packageId: null,
        attendanceStatus: null,
        lessonType: "MAPPING",
        whatsappGroupId: GROUP_ID,
        teacher: { name: TEACHER.name },
        package: null,
      },
    ]);
    db.userFindMany.mockResolvedValue([{ id: TEACHER.id, name: TEACHER.name }]);

    const res = await GET(new Request("https://project100.example/api/portal/students/stu-1/meetings"), context());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.teachers).toEqual([{ id: TEACHER.id, name: TEACHER.name }]);
    expect(body.data.meetings[0]).toMatchObject({
      id: "lesson-new",
      lessonType: "MAPPING",
      whatsappLinked: true,
      endsAt: "2026-10-05T14:45:00.000Z",
    });
    expect(db.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: "TEACHER", isApproved: true } })
    );
  });

  it("is closed to teachers", async () => {
    session.getCurrentUser.mockResolvedValue(staff("TEACHER"));
    const res = await GET(new Request("https://project100.example/api/portal/students/stu-1/meetings"), context());
    expect(res.status).toBe(403);
    expect(db.lessonFindMany).not.toHaveBeenCalled();
  });
});

describe("schedule helpers", () => {
  it("converts Israel wall-clock time to UTC in summer and winter", () => {
    expect(israelLocalToIso("2026-10-05", "17:00")).toBe("2026-10-05T14:00:00.000Z");
    expect(israelLocalToIso("2026-12-10", "10:30")).toBe("2026-12-10T08:30:00.000Z");
    expect(israelLocalToIso("2026-13-01", "10:00")).toBeNull();
    expect(israelLocalToIso("2026-10-05", "24:00")).toBeNull();
  });

  it("gives tomorrow's Israel date as the default", () => {
    expect(israelDateKey(new Date("2026-09-29T22:30:00.000Z"))).toBe("2026-09-30");
    expect(israelDateKey(new Date("2026-09-29T19:00:00.000Z"), 1)).toBe("2026-09-30");
  });

  it("defaults to a 45-minute mapping lesson", () => {
    const parsed = parseScheduleMeetingInput({ teacherId: "t", subject: "מתמטיקה", scheduledAt: LESSON_AT }, NOW);
    expect(parsed).toEqual({
      ok: true,
      data: {
        teacherId: "t",
        subject: "מתמטיקה",
        scheduledAt: new Date(LESSON_AT),
        durationMinutes: 45,
        lessonType: "MAPPING",
      },
    });
  });

  it("marks mapping lessons and linked groups in the meetings table", () => {
    const base = {
      title: "מתמטיקה",
      scheduledAt: new Date(LESSON_AT),
      startTime: null,
      endTime: null,
      durationMinutes: 45,
      status: "SCHEDULED",
      teacherId: TEACHER.id,
      packageId: null,
      attendanceStatus: null,
      teacher: { name: TEACHER.name },
      package: null,
    };
    const rows = buildMeetingRows(
      [
        { ...base, id: "a", lessonType: "MAPPING", whatsappGroupId: GROUP_ID },
        { ...base, id: "b", lessonType: "REGULAR", whatsappGroupId: null },
      ],
      { id: "rep", role: "REPRESENTATIVE" },
      NOW
    );
    expect(rows.map((r) => [r.id, r.lessonType, r.whatsappLinked])).toEqual([
      ["a", "MAPPING", true],
      ["b", "REGULAR", false],
    ]);
  });
});
