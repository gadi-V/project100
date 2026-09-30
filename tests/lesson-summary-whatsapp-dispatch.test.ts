import { isValidElement, type ReactElement, type ReactNode } from "react";
import Link from "next/link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  lessonFindFirst: vi.fn(),
  referralFindFirst: vi.fn(),
  logCreate: vi.fn(),
}));
const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const audit = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: db.userFindUnique },
    lesson: { findFirst: db.lessonFindFirst },
    teacherReferral: { findFirst: db.referralFindFirst },
    studentCommunicationLog: { create: db.logCreate },
  },
}));
vi.mock("../lib/session", () => session);
vi.mock("../lib/audit", () => audit);

import { POST } from "../app/api/portal/students/[id]/communication/route";
import { LessonRoomAction } from "../components/portal/student/MeetingsTab";
import { buildMeetingRows } from "../lib/student-portal";
import { canEnterLessonRoom, lessonRoomHref, type MeetingRow } from "../lib/student-portal-shared";
import { buildQuadCommunicationSummaryMessage } from "../lib/whatsapp";

type FetchMock = ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>;

const GATEWAY = "https://wa-gateway.example.test";
const GROUP_ID = "120363025555555555@g.us";
const STUDENT_ID = "stu-1";
const TEACHER_ID = "teacher-1";
const NOW = new Date("2026-09-29T19:00:00.000Z");

const STUDENT = { id: STUDENT_ID, name: "מתן קולמן", role: "STUDENT", whatsappGroupId: GROUP_ID as string | null };

const LESSON_SUMMARY = [
  "* עבדנו על: משוואות ריבועיות ונוסחת השורשים",
  "* כשיעורי בית: תרגילים 1-10 בעמוד 45",
  "* שיעור הבא: פרבולות",
].join("\n");

const MAPPING_SUMMARY = [
  "כיתה והקבצה: י׳ · 5 יח״ל",
  "מטרה מרכזית: לעלות ל-90 בבגרות",
  "התאמה לפורמט: מתאים",
  "המלצה למנוי: דו שבועי",
].join("\n");

function sessionUser(role: string, id = `user-${role.toLowerCase()}`) {
  return { id, name: `משתמש ${role}`, role, lessonCredits: 0, isApproved: true };
}

function context(id = STUDENT_ID) {
  return { params: Promise.resolve({ id }) };
}

function postSummary(body: Record<string, unknown>) {
  return POST(
    new Request(`https://project100.test/api/portal/students/${STUDENT_ID}/communication`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    context()
  );
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

function sentMessages(fetchMock: FetchMock): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url]) => url === `${GATEWAY}/sendMessage`)
    .map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>);
}

function withStudent(overrides: Partial<typeof STUDENT> = {}) {
  const student = { ...STUDENT, ...overrides };
  db.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === STUDENT_ID ? student : null
  );
}

beforeEach(() => {
  vi.stubEnv("WHATSAPP_API_URL", GATEWAY);
  vi.stubEnv("WHATSAPP_API_KEY", "wa-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  session.getCurrentUser.mockResolvedValue(sessionUser("TEACHER", TEACHER_ID));
  withStudent();
  db.lessonFindFirst.mockImplementation(async ({ where }: { where: { teacherId: string } }) =>
    where.teacherId === TEACHER_ID ? { id: "lesson-1" } : null
  );
  db.referralFindFirst.mockResolvedValue(null);
  db.logCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "log-1",
    createdAt: NOW,
    ...data,
  }));
  audit.writeAuditLog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("POST /api/portal/students/[id]/communication — WhatsApp group dispatch", () => {
  it("posts a formatted lesson summary to the student's quad group", async () => {
    const fetchMock = stubGateway();

    const res = await postSummary({ type: "LESSON_SUMMARY", content: LESSON_SUMMARY });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ success: true, whatsappDispatched: true, data: { id: "log-1" } });
    expect(db.logCreate).toHaveBeenCalledTimes(1);

    const messages = sentMessages(fetchMock);
    expect(messages).toHaveLength(1);
    expect(messages[0].chatId).toBe(GROUP_ID);
    expect(messages[0].message).toBe(
      "📚 *סיכום שיעור - Project 100*\n" +
        "שלום לכולם, להלן סיכום השיעור שהסתיים כעת:\n\n" +
        "*עבדנו על:* משוואות ריבועיות ונוסחת השורשים\n" +
        "*שיעורי בית:* תרגילים 1-10 בעמוד 45\n" +
        "*בשיעור הבא:* פרבולות\n\n" +
        "המשך למידה מעולה! צוות Project 100"
    );
    expect(audit.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STUDENT_COMMUNICATION_LOGGED",
        metadata: expect.objectContaining({ sendToWhatsApp: true, whatsappDispatched: true }),
      })
    );
  });

  it("posts a short mapping-completed message for a mapping summary", async () => {
    const fetchMock = stubGateway();

    const res = await postSummary({ type: "MAPPING_SUMMARY", content: MAPPING_SUMMARY });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ whatsappDispatched: true });
    const [message] = sentMessages(fetchMock);
    expect(message.chatId).toBe(GROUP_ID);
    expect(String(message.message)).toContain("שיעור המיפוי של מתן קולמן הסתיים בהצלחה");
    expect(String(message.message)).toContain("להצגת תוכנית הלמידה");
    expect(String(message.message)).not.toContain("מטרה מרכזית");
  });

  it("saves but does not post when sendToWhatsApp is false", async () => {
    const fetchMock = stubGateway();

    const res = await postSummary({ type: "LESSON_SUMMARY", content: LESSON_SUMMARY, sendToWhatsApp: false });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ success: true, whatsappDispatched: false });
    expect(db.logCreate).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves but does not post when the student has no WhatsApp group", async () => {
    withStudent({ whatsappGroupId: null });
    const fetchMock = stubGateway();

    const res = await postSummary({ type: "LESSON_SUMMARY", content: LESSON_SUMMARY });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ whatsappDispatched: false });
    expect(db.logCreate).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never posts other summary types to the group", async () => {
    session.getCurrentUser.mockResolvedValue(sessionUser("ADMIN"));
    const fetchMock = stubGateway();

    const res = await postSummary({ type: "GENERAL", content: "שלום, עדכון כללי" });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ whatsappDispatched: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean sendToWhatsApp before saving", async () => {
    const fetchMock = stubGateway();

    const res = await postSummary({ type: "LESSON_SUMMARY", content: LESSON_SUMMARY, sendToWhatsApp: "yes" });

    expect(res.status).toBe(400);
    expect(db.logCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/portal/students/[id]/communication — gateway failures keep the summary", () => {
  it("keeps the summary on a 503 gateway error and reports whatsappDispatched: false", async () => {
    stubGateway(async () => new Response("service unavailable", { status: 503 }));

    const res = await postSummary({ type: "LESSON_SUMMARY", content: LESSON_SUMMARY });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ success: true, whatsappDispatched: false, data: { id: "log-1" } });
    expect(db.logCreate).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "Lesson summary WhatsApp dispatch failed:",
      expect.stringContaining("503")
    );
  });

  it("keeps the summary when the gateway is unreachable", async () => {
    stubGateway(async () => {
      throw new TypeError("fetch failed");
    });

    const res = await postSummary({ type: "MAPPING_SUMMARY", content: MAPPING_SUMMARY });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ success: true, whatsappDispatched: false });
    expect(db.logCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps the summary when WhatsApp is not configured (mock send only)", async () => {
    vi.stubEnv("WHATSAPP_API_URL", "");
    const fetchMock = stubGateway();

    const res = await postSummary({ type: "LESSON_SUMMARY", content: LESSON_SUMMARY });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ whatsappDispatched: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("lesson summary message", () => {
  it("leaves out empty homework and next-lesson lines", () => {
    const message = buildQuadCommunicationSummaryMessage({
      type: "LESSON_SUMMARY",
      workedOn: "שברים",
      homework: null,
      nextLesson: "  ",
    });
    expect(message).toContain("*עבדנו על:* שברים");
    expect(message).not.toContain("שיעורי בית");
    expect(message).not.toContain("בשיעור הבא");
  });
});

describe("meetings tab — enter lesson room", () => {
  const baseLesson = {
    title: "מתמטיקה",
    scheduledAt: new Date("2026-10-05T14:00:00.000Z"),
    startTime: null,
    endTime: null,
    durationMinutes: 50,
    teacherId: TEACHER_ID,
    studentId: STUDENT_ID,
    packageId: null,
    attendanceStatus: null,
    lessonType: "REGULAR",
    whatsappGroupId: null,
    teacher: { name: "רונית לוי" },
    package: null,
  };

  function row(overrides: Partial<MeetingRow> = {}): MeetingRow {
    return {
      id: "lesson-42",
      scheduledAt: "2026-10-05T14:00:00.000Z",
      endsAt: "2026-10-05T14:50:00.000Z",
      title: "מתמטיקה",
      teacherName: "רונית לוי",
      status: "SCHEDULED",
      lessonType: "REGULAR",
      whatsappLinked: false,
      attendanceStatus: null,
      canMarkAttendance: false,
      canEnterRoom: true,
      teacherId: TEACHER_ID,
      durationMinutes: 50,
      canSchedulePending: false,
      canReschedule: false,
      rescheduleBlock: null,
      canEmergencyReschedule: false,
      canCancel: false,
      canComplete: false,
      creditTakenAtBooking: false,
      ...overrides,
    };
  }

  function textOf(node: ReactNode): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
    return "";
  }

  function renderAction(meeting: MeetingRow): ReactElement<Record<string, unknown>> {
    return LessonRoomAction({ meeting }) as ReactElement<Record<string, unknown>>;
  }

  it("links the join button to /lessons/[lessonId]", () => {
    expect(lessonRoomHref("lesson-42")).toBe("/lessons/lesson-42");
    expect(lessonRoomHref("a/b")).toBe("/lessons/a%2Fb");

    const action = renderAction(row());
    expect(action.type).toBe(Link);
    expect(action.props.href).toBe("/lessons/lesson-42");
    expect(textOf(action)).toContain("היכנס לשיעור");
  });

  it("keeps the join button disabled for a viewer who may not enter an open lesson", () => {
    const action = renderAction(row({ canEnterRoom: false }));
    expect(action.type).toBe("button");
    expect(action.props.disabled).toBe(true);
    expect(action.props.href).toBeUndefined();
    expect(textOf(action)).toContain("היכנס לשיעור");
  });

  it.each([
    ["COMPLETED", "הסתיים"],
    ["CANCELLED", "בוטל"],
  ])("disables the button and shows the status for a %s lesson", (status, label) => {
    const action = renderAction(row({ status, canEnterRoom: false }));
    expect(action.type).toBe("button");
    expect(action.props.disabled).toBe(true);
    expect(action.props.href).toBeUndefined();
    expect(textOf(action)).toContain(label);
  });

  it("opens the room to the assigned teacher, the student, MANAGER and ADMIN only", () => {
    const lesson = { status: "IN_PROGRESS", teacherId: TEACHER_ID, studentId: STUDENT_ID };
    expect(canEnterLessonRoom({ id: TEACHER_ID, role: "TEACHER" }, lesson)).toBe(true);
    expect(canEnterLessonRoom({ id: STUDENT_ID, role: "STUDENT" }, lesson)).toBe(true);
    expect(canEnterLessonRoom({ id: "m", role: "MANAGER" }, lesson)).toBe(true);
    expect(canEnterLessonRoom({ id: "a", role: "ADMIN" }, lesson)).toBe(true);
    expect(canEnterLessonRoom({ id: "other-teacher", role: "TEACHER" }, lesson)).toBe(false);
    expect(canEnterLessonRoom({ id: "other-student", role: "STUDENT" }, lesson)).toBe(false);
    expect(canEnterLessonRoom({ id: "rep", role: "REPRESENTATIVE" }, lesson)).toBe(false);
    expect(canEnterLessonRoom({ id: "a", role: "ADMIN" }, { ...lesson, status: "COMPLETED" })).toBe(false);
  });

  it("sets canEnterRoom on meeting rows from status and viewer", () => {
    const lessons = [
      { ...baseLesson, id: "open", status: "SCHEDULED" },
      { ...baseLesson, id: "live", status: "IN_PROGRESS" },
      { ...baseLesson, id: "done", status: "COMPLETED" },
      { ...baseLesson, id: "cancelled", status: "CANCELLED" },
    ];
    const asTeacher = buildMeetingRows(lessons, { id: TEACHER_ID, role: "TEACHER" }, NOW);
    expect(asTeacher.map((r) => [r.id, r.canEnterRoom])).toEqual([
      ["open", true],
      ["live", true],
      ["done", false],
      ["cancelled", false],
    ]);
    const asRepresentative = buildMeetingRows(lessons, { id: "rep", role: "REPRESENTATIVE" }, NOW);
    expect(asRepresentative.every((r) => !r.canEnterRoom)).toBe(true);
  });
});
