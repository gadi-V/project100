import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const order: string[] = [];

const session = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const lessons = vi.hoisted(() => ({ getAuthorizedLessonById: vi.fn() }));
const healing = vi.hoisted(() => ({
  ensureLiveStreamChannel: vi.fn(),
  provisionMissingLessonChannel: vi.fn(),
}));
const packageChat = vi.hoisted(() => ({ resolveLessonStreamChannelId: vi.fn() }));
const stream = vi.hoisted(() => ({
  generateStreamToken: vi.fn(),
  hasStreamCredentials: vi.fn(() => true),
  streamChannelIdForLesson: (lessonId: string) => `lesson_${lessonId}`,
}));
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

function renderedChannel(page: unknown): { streamChannelId: string } | null {
  return (
    page as { props: { lesson: { chatChannel: { streamChannelId: string } | null } } }
  ).props.lesson.chatChannel;
}

describe("lesson without a ChatChannel row", () => {
  beforeEach(() => {
    packageChat.resolveLessonStreamChannelId.mockResolvedValue(null);
    stream.hasStreamCredentials.mockReturnValue(true);
  });

  it("(a) provisions a SCHEDULED lesson and passes the channel id on the first render", async () => {
    lessons.getAuthorizedLessonById.mockResolvedValue({
      ...lesson(),
      status: "SCHEDULED",
      chatChannel: null,
    });
    healing.provisionMissingLessonChannel.mockImplementation(async () => {
      order.push("provision");
      return CHANNEL;
    });

    const page = await LessonPage({ params: { id: "lesson-1" } });

    expect(healing.provisionMissingLessonChannel).toHaveBeenCalledWith("lesson-1");
    expect(healing.ensureLiveStreamChannel).not.toHaveBeenCalled();
    expect(renderedChannel(page)).toEqual({ streamChannelId: CHANNEL });
    expect(order).toEqual(["provision", "token"]);
  });

  it.each(["CANCELLED", "COMPLETED", "CANCELLED_LATE"])(
    "(c) does not provision a %s lesson",
    async (status) => {
      lessons.getAuthorizedLessonById.mockResolvedValue({
        ...lesson(),
        status,
        chatChannel: null,
      });

      const page = await LessonPage({ params: { id: "lesson-1" } });

      expect(healing.provisionMissingLessonChannel).not.toHaveBeenCalled();
      expect(renderedChannel(page)).toBeNull();
    }
  );

  it("(c) does not provision when a participant id is missing", async () => {
    lessons.getAuthorizedLessonById.mockResolvedValue({
      ...lesson(),
      status: "SCHEDULED",
      studentId: "",
      chatChannel: null,
    });

    const page = await LessonPage({ params: { id: "lesson-1" } });

    expect(healing.provisionMissingLessonChannel).not.toHaveBeenCalled();
    expect(renderedChannel(page)).toBeNull();
  });

  it("(d) keeps a package lesson on the package channel", async () => {
    lessons.getAuthorizedLessonById.mockResolvedValue({
      ...lesson(),
      status: "SCHEDULED",
      packageId: "pkg-1",
      chatChannel: null,
    });
    packageChat.resolveLessonStreamChannelId.mockResolvedValue("package-pkg-1");
    healing.ensureLiveStreamChannel.mockImplementation(async (_lessonId: string, channelId: string) => channelId);

    const page = await LessonPage({ params: { id: "lesson-1" } });

    expect(healing.ensureLiveStreamChannel).toHaveBeenCalledWith("lesson-1", "package-pkg-1");
    expect(healing.provisionMissingLessonChannel).not.toHaveBeenCalled();
    expect(renderedChannel(page)).toEqual({ streamChannelId: "package-pkg-1" });
  });

  it("(e) still renders when provisioning returns null and passes no channel", async () => {
    lessons.getAuthorizedLessonById.mockResolvedValue({
      ...lesson(),
      status: "IN_PROGRESS",
      chatChannel: null,
    });
    healing.provisionMissingLessonChannel.mockResolvedValue(null);

    const page = await LessonPage({ params: { id: "lesson-1" } });

    expect(page).toBeTruthy();
    expect(renderedChannel(page)).toBeNull();
    expect(order).toEqual(["token"]);
  });

  it("does not provision when Stream credentials are missing", async () => {
    stream.hasStreamCredentials.mockReturnValue(false);
    lessons.getAuthorizedLessonById.mockResolvedValue({
      ...lesson(),
      status: "SCHEDULED",
      chatChannel: null,
    });

    const page = await LessonPage({ params: { id: "lesson-1" } });

    expect(healing.provisionMissingLessonChannel).not.toHaveBeenCalled();
    expect(renderedChannel(page)).toBeNull();
  });
});
