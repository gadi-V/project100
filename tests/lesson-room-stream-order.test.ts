import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const order: string[] = [];

const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const lessons = vi.hoisted(() => ({ getAuthorizedLessonById: vi.fn() }));
const healing = vi.hoisted(() => ({ ensureLiveStreamChannel: vi.fn() }));
const packageChat = vi.hoisted(() => ({ resolveLessonStreamChannelId: vi.fn() }));
const stream = vi.hoisted(() => ({ generateStreamToken: vi.fn() }));
const daily = vi.hoisted(() => ({
  ensureDailyRoom: vi.fn(),
  generateDailyToken: vi.fn(),
  dailyRoomNameForLesson: (lessonId: string) => `lesson-${lessonId}`,
  roomNameFromDailyUrl: () => null,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT ${path}`);
  }),
}));
vi.mock("../lib/session", () => session);
vi.mock("../lib/lessons", () => lessons);
vi.mock("../lib/services/chat-healing.service", () => healing);
vi.mock("../lib/package-chat", () => packageChat);
vi.mock("../lib/stream", () => stream);
vi.mock("../lib/daily", () => daily);
vi.mock("../lib/prisma", () => ({
  prisma: {
    diagnosticQuiz: { findFirst: vi.fn().mockResolvedValue(null) },
    lesson: { update: vi.fn() },
  },
}));
vi.mock("../app/lessons/[id]/LessonRoomUI", () => ({
  default: () => null,
}));

import LessonPage from "../app/lessons/[id]/page";

const CHANNEL = "lesson_lesson-1";

function lesson() {
  return {
    id: "lesson-1",
    title: "שיעור מתמטיקה",
    status: "IN_PROGRESS",
    studentId: "student-1",
    teacherId: "teacher-1",
    dailyRoomUrl: null,
    scheduledAt: new Date("2026-08-10T12:22:44.035Z"),
    createdAt: new Date("2026-08-10T12:22:44.038Z"),
    durationMinutes: 60,
    packageId: null,
    lessonType: "REGULAR",
    student: { id: "student-1", name: "תלמיד" },
    teacher: { id: "teacher-1", name: "מורה" },
    chatChannel: { streamChannelId: CHANNEL },
  };
}

beforeEach(() => {
  order.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  session.getCurrentUser.mockResolvedValue({
    id: "student-1",
    name: "תלמיד בדיקה",
    role: "STUDENT",
    lessonCredits: 1,
    isApproved: true,
  });
  lessons.getAuthorizedLessonById.mockResolvedValue(lesson());
  packageChat.resolveLessonStreamChannelId.mockResolvedValue(CHANNEL);
  daily.ensureDailyRoom.mockResolvedValue(null);
  healing.ensureLiveStreamChannel.mockImplementation(async () => {
    order.push("reconcile");
    return CHANNEL;
  });
  stream.generateStreamToken.mockImplementation(() => {
    order.push("token");
    return "stream-token";
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("lesson room stream order", () => {
  it("(f) reconciles membership before issuing the token", async () => {
    const page = await LessonPage({ params: { id: "lesson-1" } });

    expect(page).toBeTruthy();
    expect(healing.ensureLiveStreamChannel).toHaveBeenCalledWith("lesson-1", CHANNEL);
    expect(order).toEqual(["reconcile", "token"]);
  });

  it("(f) still renders the room when reconciliation throws", async () => {
    const failure = Object.assign(new Error("ReadChannel denied"), { code: 17 });
    healing.ensureLiveStreamChannel.mockImplementation(async () => {
      order.push("reconcile");
      throw failure;
    });

    const page = await LessonPage({ params: { id: "lesson-1" } });

    expect(page).toBeTruthy();
    expect(order).toEqual(["reconcile", "token"]);
    expect(console.error).toHaveBeenCalledWith(
      "[lesson-room] Stream membership reconciliation failed",
      expect.objectContaining({
        lessonId: "lesson-1",
        teacherId: "teacher-1",
        studentId: "student-1",
        userId: "student-1",
        code: 17,
      })
    );
  });
});
