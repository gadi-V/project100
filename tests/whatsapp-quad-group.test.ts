import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  lessonFindFirst: vi.fn(),
  diagnosticQuizFindFirst: vi.fn(),
}));

const auth = vi.hoisted(() => ({ requireAuthOrMonitor: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: db.userFindUnique, findFirst: db.userFindFirst, update: db.userUpdate },
    lesson: { findFirst: db.lessonFindFirst },
    diagnosticQuiz: { findFirst: db.diagnosticQuizFindFirst },
  },
}));
vi.mock("../lib/api-auth", () => auth);
vi.mock("../lib/audit", () => audit);

type FetchMock = ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>;

const GATEWAY = "https://wa-gateway.example.test";
const GROUP_ID = "120363025555555555@g.us";
const JIDS = {
  student: "972541234567@c.us",
  teacher: "972527654321@c.us",
  parent: "972501112233@c.us",
  admin: "972509998877@c.us",
};

/** Monday 05.10.2026, 17:00 Israel time (UTC+3, before DST ends). */
const SUMMER_LESSON = new Date("2026-10-05T14:00:00.000Z");
/** Thursday 10.12.2026, 10:30 Israel time (UTC+2). */
const WINTER_LESSON = new Date("2026-12-10T08:30:00.000Z");

const baseInput = () => ({
  student: { name: "מתן קולמן", phone: "054-123-4567" },
  teacher: { name: "רונית לוי", phone: "+972 52 765 4321" },
  parent: { name: "דנה קולמן", phone: "0501112233" },
  lesson: { scheduledAt: SUMMER_LESSON, durationMinutes: 60, subject: "מתמטיקה" },
  questionnaireUrl: "https://project100.example/q/abc",
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubGateway(
  groupResponse: () => Promise<Response> = async () =>
    json({ created: true, chatId: GROUP_ID, groupInviteLink: "https://chat.whatsapp.com/Inv1te" }),
  sendResponse: () => Promise<Response> = async () => json({ idMessage: "welcome-msg-1" })
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

async function loadWhatsApp() {
  return import("../lib/whatsapp");
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("WHATSAPP_API_URL", GATEWAY);
  vi.stubEnv("WHATSAPP_API_KEY", "wa-key");
  vi.stubEnv("WHATSAPP_ADMIN_PHONE", "050-999-8877");
  vi.stubEnv("APP_URL", "https://project100.example");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("collectQuadGroupParticipants", () => {
  it("normalizes student, teacher, parent and admin to WhatsApp JIDs", async () => {
    const { collectQuadGroupParticipants } = await loadWhatsApp();

    expect(collectQuadGroupParticipants(baseInput())).toEqual({
      participants: [
        { role: "STUDENT", chatId: JIDS.student },
        { role: "TEACHER", chatId: JIDS.teacher },
        { role: "PARENT", chatId: JIDS.parent },
        { role: "ADMIN", chatId: JIDS.admin },
      ],
      droppedRoles: [],
    });
  });

  it("drops a missing parent, an invalid admin phone and duplicate numbers", async () => {
    vi.stubEnv("WHATSAPP_ADMIN_PHONE", "12345");
    const { collectQuadGroupParticipants } = await loadWhatsApp();

    const withoutParent = collectQuadGroupParticipants({ ...baseInput(), parent: undefined });
    expect(withoutParent.participants.map((p) => p.role)).toEqual(["STUDENT", "TEACHER"]);
    expect(withoutParent.droppedRoles).toEqual(["PARENT", "ADMIN"]);

    const parentIsStudent = collectQuadGroupParticipants({
      ...baseInput(),
      parent: { phone: "+972541234567" },
    });
    expect(parentIsStudent.droppedRoles).toContain("PARENT");
    expect(parentIsStudent.participants.filter((p) => p.chatId === JIDS.student)).toHaveLength(1);
  });
});

describe("buildQuadGroupName", () => {
  it("keeps the PROJECT100 suffix within 25 characters without cutting words", async () => {
    const { buildQuadGroupName } = await loadWhatsApp();

    expect(buildQuadGroupName("מתן קולמן", "מתמטיקה")).toBe("מתן מתמטיקה | PROJECT100");
    expect(buildQuadGroupName("נועה", "פיזיקה")).toBe("נועה פיזיקה | PROJECT100");
    expect(buildQuadGroupName("מתן קולמן")).toBe("מתן קולמן | PROJECT100");
    expect(buildQuadGroupName("אלכסנדרה-מרגריטה בן-שושן", "ביולוגיה")).toBe(
      "אלכסנדרה-מרג | PROJECT100"
    );
  });

  it.each([
    ["מתן קולמן", "מתמטיקה"],
    ["שם ארוך מאוד מאוד מאוד", "היסטוריה ואזרחות"],
    ["", undefined],
  ])("never exceeds 25 characters (%s / %s)", async (name, subject) => {
    const { buildQuadGroupName, QUAD_GROUP_NAME_MAX_CHARS } = await loadWhatsApp();
    const groupName = buildQuadGroupName(name, subject);
    expect(Array.from(groupName).length).toBeLessThanOrEqual(QUAD_GROUP_NAME_MAX_CHARS);
    expect(groupName.endsWith(" | PROJECT100")).toBe(true);
  });
});

describe("buildQuadWelcomeMessage", () => {
  it("renders the exact welcome copy with Hebrew day, date and time range", async () => {
    const { buildQuadWelcomeMessage } = await loadWhatsApp();

    const text = buildQuadWelcomeMessage({
      studentName: "מתן קולמן",
      teacherName: "רונית לוי",
      scheduledAt: SUMMER_LESSON,
      durationMinutes: 60,
      questionnaireUrl: "https://project100.example/q/abc",
    });

    expect(text).toBe(
      [
        "היי מתן קולמן, ברוך הבא ל-PROJECT100 ובהצלחה! 🎉",
        "ביום שני 05.10.2026 יתקיים שיעור המיפוי שלך בשעה 17:00-18:00",
        "עד אז מוזמן לענות על השאלון המצורף:",
        "https://project100.example/q/abc",
        "",
        "נשמח לקבל כאן את הלו״ז השבועי שלך - חוגים, אימונים וזמנים פנויים, ובנוסף צילום של המבחן האחרון על מנת שנוכל לעבור עליו לפני המיפוי.",
        "",
        "📌 חלוקת פעילות בקבוצה:",
        "- רונית לוי ילווה אותך במעטפת הלימודית ובכל הקשור לחומר המקצועי (המורה ישלח כאן בהמשך סרטון היכרות אישי).",
        "- צוות המערכת זמין כאן לכל נושאי לו״ז, שינויים, תשלומים ובירוקרטיה.",
      ].join("\n")
    );
  });

  it("uses Israel winter time and the lesson duration for the range", async () => {
    const { formatQuadLessonWindow } = await loadWhatsApp();

    expect(formatQuadLessonWindow(WINTER_LESSON, 90)).toEqual({
      dayName: "חמישי",
      date: "10.12.2026",
      timeRange: "10:30-12:00",
    });
  });

  it("keeps teacher and system-team responsibilities on separate lines", async () => {
    const { buildQuadWelcomeMessage } = await loadWhatsApp();
    const lines = buildQuadWelcomeMessage({
      studentName: "נועה",
      teacherName: "אבי",
      scheduledAt: SUMMER_LESSON,
      durationMinutes: 45,
      questionnaireUrl: "https://q.example",
    }).split("\n");

    const teacherLine = lines.find((l) => l.startsWith("- אבי"));
    const teamLine = lines.find((l) => l.startsWith("- צוות המערכת"));
    expect(teacherLine).toContain("לחומר המקצועי");
    expect(teacherLine).not.toContain("תשלומים");
    expect(teamLine).toContain("תשלומים");
    expect(teamLine).not.toContain("חומר המקצועי");
    expect(lines).toContain("ביום שני 05.10.2026 יתקיים שיעור המיפוי שלך בשעה 17:00-17:45");
  });
});

describe("createWhatsAppQuadGroup", () => {
  it("creates the group with all four JIDs and posts the welcome message into it", async () => {
    const fetchMock = stubGateway();
    const { createWhatsAppQuadGroup } = await loadWhatsApp();

    const result = await createWhatsAppQuadGroup(baseInput());

    expect(result).toMatchObject({
      ok: true,
      chatId: GROUP_ID,
      inviteUrl: "https://chat.whatsapp.com/Inv1te",
      groupName: "מתן מתמטיקה | PROJECT100",
      welcome: { sent: true, messageId: "welcome-msg-1" },
    });

    const [createCall] = callsTo(fetchMock, "/createGroup");
    expect((createCall[1].headers as Record<string, string>).Authorization).toBe("Bearer wa-key");
    expect(createCall[1].signal).toBeInstanceOf(AbortSignal);
    expect(bodyOf(createCall)).toEqual({
      groupName: "מתן מתמטיקה | PROJECT100",
      chatIds: [JIDS.student, JIDS.teacher, JIDS.parent, JIDS.admin],
    });

    const [welcomeCall] = callsTo(fetchMock, "/sendMessage");
    const welcomeBody = bodyOf(welcomeCall);
    expect(welcomeBody.chatId).toBe(GROUP_ID);
    expect(welcomeBody.message).toContain("היי מתן קולמן");
    expect(welcomeBody.message).toContain("17:00-18:00");
    expect(welcomeBody.message).toContain("https://project100.example/q/abc");
  });

  it("opens the group with three members when parent details are missing", async () => {
    const fetchMock = stubGateway();
    const { createWhatsAppQuadGroup } = await loadWhatsApp();

    const result = await createWhatsAppQuadGroup({ ...baseInput(), parent: undefined });

    expect(result.ok).toBe(true);
    expect(result.droppedRoles).toEqual(["PARENT"]);
    expect(bodyOf(callsTo(fetchMock, "/createGroup")[0]).chatIds).toEqual([
      JIDS.student,
      JIDS.teacher,
      JIDS.admin,
    ]);
  });

  it("falls back to the diagnostic page when no questionnaire link is given", async () => {
    const fetchMock = stubGateway();
    const { createWhatsAppQuadGroup } = await loadWhatsApp();

    await createWhatsAppQuadGroup({ ...baseInput(), questionnaireUrl: undefined });

    expect(bodyOf(callsTo(fetchMock, "/sendMessage")[0]).message).toContain(
      "https://project100.example/onboarding/diagnostic"
    );
  });

  it("accepts WAHA-style gid responses", async () => {
    stubGateway(async () => json({ gid: { _serialized: GROUP_ID } }));
    const { createWhatsAppQuadGroup } = await loadWhatsApp();

    const result = await createWhatsAppQuadGroup(baseInput());

    expect(result).toMatchObject({ ok: true, chatId: GROUP_ID, inviteUrl: null });
  });

  it.each([
    [
      "a network failure",
      async () => {
        throw new TypeError("fetch failed");
      },
      { code: "NETWORK" },
    ],
    [
      "a timeout",
      async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      { code: "TIMEOUT" },
    ],
    ["an HTTP 500", async () => new Response("boom", { status: 500 }), { code: "GATEWAY_ERROR", status: 500 }],
    ["created: false", async () => json({ created: false }), { code: "GATEWAY_ERROR" }],
    ["a response without a group id", async () => json({ ok: true }), { code: "INVALID_RESPONSE" }],
  ])("returns a structured error on %s without throwing or sending", async (_label, groupResponse, error) => {
    const fetchMock = stubGateway(groupResponse);
    const { createWhatsAppQuadGroup } = await loadWhatsApp();

    const result = await createWhatsAppQuadGroup(baseInput());

    expect(result).toMatchObject({ ok: false, error });
    expect(callsTo(fetchMock, "/sendMessage")).toHaveLength(0);
  });

  it("reports NOT_CONFIGURED instead of inventing a mock group", async () => {
    vi.stubEnv("WHATSAPP_API_KEY", "");
    const fetchMock = stubGateway();
    const { createWhatsAppQuadGroup } = await loadWhatsApp();

    const result = await createWhatsAppQuadGroup(baseInput());

    expect(result).toMatchObject({ ok: false, error: { code: "NOT_CONFIGURED" } });
    expect(result).not.toHaveProperty("inviteUrl");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to open a group without a valid teacher", async () => {
    const fetchMock = stubGateway();
    const { createWhatsAppQuadGroup } = await loadWhatsApp();

    const result = await createWhatsAppQuadGroup({
      ...baseInput(),
      teacher: { name: "רונית", phone: "" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "MISSING_REQUIRED_PARTICIPANT" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the created group when only the welcome message fails", async () => {
    stubGateway(undefined, async () => new Response("rate limited", { status: 429 }));
    const { createWhatsAppQuadGroup } = await loadWhatsApp();

    const result = await createWhatsAppQuadGroup(baseInput());

    expect(result).toMatchObject({ ok: true, chatId: GROUP_ID, welcome: { sent: false } });
    expect(result.ok && !result.welcome.sent && result.welcome.error).toContain("429");
  });
});

describe("POST /api/whatsapp/dispatch-channel — quad group", () => {
  const STUDENT = {
    id: "stu-1",
    name: "מתן קולמן",
    phone: "054-123-4567",
    parentName: "דנה קולמן",
    parentPhone: "0501112233",
    quadGroupUrl: "https://chat.whatsapp.com/mock-quad-stu-1",
    whatsappGroupId: null as string | null,
    role: "STUDENT",
  };
  const LESSON = {
    id: "lesson-1",
    title: "שיעור מיפוי",
    scheduledAt: SUMMER_LESSON,
    durationMinutes: 60,
    teacher: { id: "teacher-1", name: "רונית לוי", phone: "+972 52 765 4321" },
  };

  function dispatchRequest(body: Record<string, unknown>) {
    return new NextRequest("https://project100.example/api/whatsapp/dispatch-channel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function loadRoute() {
    return (await import("../app/api/whatsapp/dispatch-channel/route")).POST;
  }

  function auditActions(): string[] {
    return audit.writeAuditLog.mock.calls.map(([entry]) => (entry as { action: string }).action);
  }

  beforeEach(() => {
    auth.requireAuthOrMonitor.mockResolvedValue({
      user: { id: STUDENT.id, name: STUDENT.name, role: "STUDENT", lessonCredits: 3, isApproved: true },
      via: "session",
      actorId: STUDENT.id,
    });
    db.userFindUnique.mockResolvedValue({ ...STUDENT });
    db.userUpdate.mockResolvedValue({});
    db.lessonFindFirst.mockResolvedValue(LESSON);
    db.diagnosticQuizFindFirst.mockResolvedValue({ subject: "מתמטיקה" });
    audit.writeAuditLog.mockResolvedValue(undefined);
  });

  it("opens the group, stores its chat id, and writes WHATSAPP_QUAD_GROUP_CREATED", async () => {
    const fetchMock = stubGateway();
    const POST = await loadRoute();

    const res = await POST(dispatchRequest({ packageType: "TRIO", studentPhone: "0529999999" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      data: {
        channel: "QUAD_GROUP",
        isGroupOpened: true,
        groupStatus: "OPENED",
        quadGroupUrl: "https://chat.whatsapp.com/Inv1te",
      },
    });
    expect(db.userUpdate).toHaveBeenCalledWith({
      where: { id: STUDENT.id },
      data: { whatsappGroupId: GROUP_ID, quadGroupUrl: "https://chat.whatsapp.com/Inv1te" },
    });
    expect(bodyOf(callsTo(fetchMock, "/createGroup")[0]).chatIds).toEqual([
      JIDS.student,
      JIDS.teacher,
      JIDS.parent,
      JIDS.admin,
    ]);
    expect(audit.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WHATSAPP_QUAD_GROUP_CREATED",
        entityType: "User",
        entityId: STUDENT.id,
        metadata: expect.objectContaining({
          chatId: GROUP_ID,
          lessonId: "lesson-1",
          teacherId: "teacher-1",
          roles: ["STUDENT", "TEACHER", "PARENT", "ADMIN"],
          welcomeSent: true,
          welcomeMessageId: "welcome-msg-1",
        }),
      })
    );
  });

  it("never adds a body-supplied phone to the group", async () => {
    const fetchMock = stubGateway();
    const POST = await loadRoute();

    await POST(dispatchRequest({ packageType: "MULTI", studentPhone: "0529999999" }));

    expect(JSON.stringify(bodyOf(callsTo(fetchMock, "/createGroup")[0]))).not.toContain(
      "972529999999"
    );
  });

  it("reports PENDING_TEACHER_ASSIGNMENT when no scheduled lesson exists", async () => {
    db.lessonFindFirst.mockResolvedValue(null);
    const fetchMock = stubGateway();
    const POST = await loadRoute();

    const res = await POST(dispatchRequest({ packageType: "TRIO" }));

    expect(await res.json()).toMatchObject({
      success: true,
      data: { isGroupOpened: false, groupStatus: "PENDING_TEACHER_ASSIGNMENT" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.userUpdate).not.toHaveBeenCalled();
  });

  it("does not open a second group when one already exists", async () => {
    db.userFindUnique.mockResolvedValue({ ...STUDENT, whatsappGroupId: GROUP_ID });
    const fetchMock = stubGateway();
    const POST = await loadRoute();

    const res = await POST(dispatchRequest({ packageType: "TRIO" }));

    expect(await res.json()).toMatchObject({ data: { groupStatus: "EXISTING", isGroupOpened: false } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a structured 502 on a gateway failure without persisting or auditing a group", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubGateway(async () => new Response("gateway down", { status: 500 }));
    const POST = await loadRoute();

    const res = await POST(dispatchRequest({ packageType: "TRIO" }));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      success: false,
      data: { groupStatus: "FAILED", errorCode: "GATEWAY_ERROR", isGroupOpened: false },
    });
    expect(db.userUpdate).not.toHaveBeenCalled();
    expect(auditActions()).not.toContain("WHATSAPP_QUAD_GROUP_CREATED");
    expect(auditActions()).toContain("WHATSAPP_DISPATCH_CHANNEL");
  });

  it("returns 503 when the gateway is not configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("WHATSAPP_API_URL", "");
    const POST = await loadRoute();

    const res = await POST(dispatchRequest({ packageType: "TRIO" }));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ data: { errorCode: "NOT_CONFIGURED" } });
    expect(db.userUpdate).not.toHaveBeenCalled();
  });
});
