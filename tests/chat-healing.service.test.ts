import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  lessonFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  lessonUpdate: vi.fn(),
}));

const stream = vi.hoisted(() => ({
  createStreamChannel: vi.fn(),
  hasStreamCredentials: vi.fn(),
  streamChannelIdForLesson: (lessonId: string) => `lesson_${lessonId}`,
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    lesson: {
      findUnique: db.lessonFindUnique,
      update: db.lessonUpdate,
    },
    user: { findMany: db.userFindMany },
  },
}));

vi.mock("../lib/stream", () => stream);

import { ensureLiveStreamChannel } from "../lib/services/chat-healing.service";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("ensureLiveStreamChannel", () => {
  it("returns a live channel id without calling Stream or the database", async () => {
    const channelId = await ensureLiveStreamChannel("lesson-1", "lesson_lesson-1");

    expect(channelId).toBe("lesson_lesson-1");
    expect(stream.hasStreamCredentials).not.toHaveBeenCalled();
    expect(stream.createStreamChannel).not.toHaveBeenCalled();
    expect(db.lessonFindUnique).not.toHaveBeenCalled();
    expect(db.lessonUpdate).not.toHaveBeenCalled();
  });

  it.each(["mock-lesson_lesson-1", "mock-package-pkg-9"])(
    "replaces %s with a live lesson channel and stores it",
    async (currentChannelId) => {
      stream.hasStreamCredentials.mockReturnValue(true);
      db.lessonFindUnique.mockResolvedValue({
        teacherId: "teacher-1",
        studentId: "student-1",
      });
      db.userFindMany.mockResolvedValue([{ id: "manager-1" }]);
      stream.createStreamChannel.mockResolvedValue("lesson_lesson-1");
      db.lessonUpdate.mockResolvedValue({ id: "lesson-1" });

      const channelId = await ensureLiveStreamChannel("lesson-1", currentChannelId);

      expect(channelId).toBe("lesson_lesson-1");
      expect(stream.createStreamChannel).toHaveBeenCalledWith("lesson-1", [
        "teacher-1",
        "student-1",
        "manager-1",
      ]);
      expect(db.lessonUpdate).toHaveBeenCalledWith({
        where: { id: "lesson-1" },
        data: {
          chatChannel: {
            upsert: {
              create: { streamChannelId: "lesson_lesson-1" },
              update: { streamChannelId: "lesson_lesson-1" },
            },
          },
        },
      });
    }
  );

  it("keeps the mock id when Stream credentials are missing", async () => {
    stream.hasStreamCredentials.mockReturnValue(false);

    const channelId = await ensureLiveStreamChannel("lesson-1", "mock-lesson_lesson-1");

    expect(channelId).toBe("mock-lesson_lesson-1");
    expect(stream.createStreamChannel).not.toHaveBeenCalled();
    expect(db.lessonFindUnique).not.toHaveBeenCalled();
    expect(db.lessonUpdate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});
