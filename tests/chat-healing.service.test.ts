import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  lessonFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  lessonUpdate: vi.fn(),
}));

const stream = vi.hoisted(() => ({
  createStreamChannel: vi.fn(),
  hasStreamCredentials: vi.fn(),
  getStreamServerClient: vi.fn(),
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
import { streamDisplayName } from "../lib/stream-display-name";

const TEACHER = "teacher-1";
const STUDENT = "student-1";
const SUBSTITUTE = "substitute-9";
const CHANNEL = "lesson_lesson-1";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("ensureLiveStreamChannel mock ids", () => {
  it.each(["mock-lesson_lesson-1", "mock-package-pkg-9"])(
    "replaces %s with a live lesson channel and stores it",
    async (currentChannelId) => {
      stream.hasStreamCredentials.mockReturnValue(true);
      db.lessonFindUnique.mockResolvedValue({
        teacherId: TEACHER,
        studentId: STUDENT,
      });
      db.userFindMany.mockResolvedValue([{ id: "manager-1" }]);
      stream.createStreamChannel.mockResolvedValue(CHANNEL);
      db.lessonUpdate.mockResolvedValue({ id: "lesson-1" });

      const channelId = await ensureLiveStreamChannel("lesson-1", currentChannelId);

      expect(channelId).toBe(CHANNEL);
      expect(stream.getStreamServerClient).not.toHaveBeenCalled();
      expect(stream.createStreamChannel).toHaveBeenCalledWith("lesson-1", [
        TEACHER,
        STUDENT,
        "manager-1",
      ]);
      expect(db.lessonUpdate).toHaveBeenCalledWith({
        where: { id: "lesson-1" },
        data: {
          chatChannel: {
            upsert: {
              create: { streamChannelId: CHANNEL },
              update: { streamChannelId: CHANNEL },
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
    expect(stream.getStreamServerClient).not.toHaveBeenCalled();
    expect(db.lessonFindUnique).not.toHaveBeenCalled();
    expect(db.lessonUpdate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});

type FakeChannel = {
  id: string;
  memberIds: string[];
};

function installClient(
  channels: FakeChannel[],
  upsert: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({}),
  queryUsers: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ users: [] })
) {
  const addMembers = vi.fn().mockResolvedValue({});
  const create = vi.fn().mockResolvedValue({});
  const removeMembers = vi.fn().mockResolvedValue({});
  const queryChannels = vi.fn(async (filter: { cid?: string }) =>
    channels
      .filter((channel) => filter.cid === `messaging:${channel.id}`)
      .map((channel) => ({
        state: {
          members: Object.fromEntries(channel.memberIds.map((id) => [id, { user_id: id }])),
        },
        addMembers,
        removeMembers,
      }))
  );
  const channel = vi.fn(() => ({ create, addMembers, removeMembers }));
  stream.getStreamServerClient.mockReturnValue({
    upsertUsers: upsert,
    queryUsers,
    queryChannels,
    channel,
  });
  return { addMembers, create, removeMembers, upsert, queryUsers, queryChannels, channel };
}

describe("ensureLiveStreamChannel real channels", () => {
  beforeEach(() => {
    stream.hasStreamCredentials.mockReturnValue(true);
    db.lessonFindUnique.mockResolvedValue({ teacherId: TEACHER, studentId: STUDENT });
  });

  it("(a) creates a missing channel and adds the teacher and student", async () => {
    const client = installClient([]);

    const channelId = await ensureLiveStreamChannel("lesson-1", CHANNEL);

    expect(channelId).toBe(CHANNEL);
    expect(client.upsert).toHaveBeenCalledWith([
      { id: TEACHER, name: "User teac" },
      { id: STUDENT, name: "User stud" },
    ]);
    expect(client.channel).toHaveBeenCalledWith("messaging", CHANNEL, {
      members: [TEACHER, STUDENT],
      created_by_id: TEACHER,
    });
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.addMembers).toHaveBeenCalledWith([TEACHER, STUDENT]);
    expect(client.upsert.mock.invocationCallOrder[0]).toBeLessThan(client.create.mock.invocationCallOrder[0]);
    expect(client.create.mock.invocationCallOrder[0]).toBeLessThan(client.addMembers.mock.invocationCallOrder[0]);
    expect(client.removeMembers).not.toHaveBeenCalled();
    expect(stream.createStreamChannel).not.toHaveBeenCalled();
  });

  it("(b) adds both members when the channel exists with zero members", async () => {
    const client = installClient([{ id: CHANNEL, memberIds: [] }]);

    await ensureLiveStreamChannel("lesson-1", CHANNEL);

    expect(client.create).not.toHaveBeenCalled();
    expect(client.channel).not.toHaveBeenCalled();
    expect(client.addMembers).toHaveBeenCalledWith([TEACHER, STUDENT]);
    expect(client.removeMembers).not.toHaveBeenCalled();
  });

  it("(c) adds the student when only the teacher is a member", async () => {
    const client = installClient([{ id: CHANNEL, memberIds: [TEACHER] }]);

    await ensureLiveStreamChannel("lesson-1", CHANNEL);

    expect(client.create).not.toHaveBeenCalled();
    expect(client.addMembers).toHaveBeenCalledWith([TEACHER, STUDENT]);
    expect(client.removeMembers).not.toHaveBeenCalled();
  });

  it("(d) does not call create or addMembers when both users are already members", async () => {
    const client = installClient([{ id: CHANNEL, memberIds: [TEACHER, STUDENT, "manager-1"] }]);

    await ensureLiveStreamChannel("lesson-1", CHANNEL);

    expect(client.upsert).toHaveBeenCalledTimes(1);
    expect(client.create).not.toHaveBeenCalled();
    expect(client.addMembers).not.toHaveBeenCalled();
    expect(client.removeMembers).not.toHaveBeenCalled();
  });

  it("(e) adds the current substitute teacher and does not remove anyone", async () => {
    db.lessonFindUnique.mockResolvedValue({ teacherId: SUBSTITUTE, studentId: STUDENT });
    const client = installClient([{ id: CHANNEL, memberIds: [TEACHER, STUDENT] }]);

    await ensureLiveStreamChannel("lesson-1", CHANNEL);

    expect(client.upsert).toHaveBeenCalledWith([
      { id: SUBSTITUTE, name: "User subs" },
      { id: STUDENT, name: "User stud" },
    ]);
    expect(client.addMembers).toHaveBeenCalledWith([SUBSTITUTE, STUDENT]);
    expect(client.removeMembers).not.toHaveBeenCalled();
  });

  it("returns the channel id when Stream fails and does not throw", async () => {
    const failure = Object.assign(new Error("ReadChannel denied"), { code: 17 });
    const upsert = vi.fn().mockRejectedValue(failure);
    installClient([{ id: CHANNEL, memberIds: [] }], upsert);

    await expect(ensureLiveStreamChannel("lesson-1", CHANNEL)).resolves.toBe(CHANNEL);
    expect(console.error).toHaveBeenCalledWith(
      "[ensureLiveStreamChannel] failed",
      expect.objectContaining({
        lessonId: "lesson-1",
        teacherId: TEACHER,
        studentId: STUDENT,
        code: 17,
      })
    );
  });
});

describe("streamDisplayName", () => {
  it("uses the first word and the id prefix", () => {
    expect(streamDisplayName("משה כהן", TEACHER)).toBe("משה (teac)");
    expect(streamDisplayName("  נועה   לוי  ", STUDENT)).toBe("נועה (stud)");
  });

  it("falls back when the name is missing or blank", () => {
    expect(streamDisplayName(null, TEACHER)).toBe("User teac");
    expect(streamDisplayName(undefined, STUDENT)).toBe("User stud");
    expect(streamDisplayName("", TEACHER)).toBe("User teac");
    expect(streamDisplayName("   ", STUDENT)).toBe("User stud");
  });
});

describe("reconcile display names", () => {
  const namedLesson = {
    teacherId: TEACHER,
    studentId: STUDENT,
    teacher: { id: TEACHER, name: "משה כהן" },
    student: { id: STUDENT, name: "נועה לוי" },
  };

  beforeEach(() => {
    stream.hasStreamCredentials.mockReturnValue(true);
    db.lessonFindUnique.mockResolvedValue(namedLesson);
  });

  it("(a) does not upsert when both users already exist in Stream", async () => {
    const queryUsers = vi.fn().mockResolvedValue({
      users: [{ id: TEACHER, name: "משה (teac)" }, { id: STUDENT, name: "נועה (stud)" }],
    });
    const client = installClient(
      [{ id: CHANNEL, memberIds: [TEACHER, STUDENT] }],
      vi.fn().mockResolvedValue({}),
      queryUsers
    );

    await ensureLiveStreamChannel("lesson-1", CHANNEL);

    expect(queryUsers).toHaveBeenCalledWith({ id: { $in: [TEACHER, STUDENT] } });
    expect(client.upsert).not.toHaveBeenCalled();
    expect(client.queryChannels).toHaveBeenCalledTimes(1);
    expect(client.addMembers).not.toHaveBeenCalled();
    expect(client.removeMembers).not.toHaveBeenCalled();
  });

  it("(b) upserts only the user Stream does not have, with the formatted name", async () => {
    const queryUsers = vi.fn().mockResolvedValue({
      users: [{ id: TEACHER, name: "משה (teac)" }],
    });
    const client = installClient([{ id: CHANNEL, memberIds: [] }], vi.fn().mockResolvedValue({}), queryUsers);

    await ensureLiveStreamChannel("lesson-1", CHANNEL);

    expect(client.upsert).toHaveBeenCalledTimes(1);
    expect(client.upsert).toHaveBeenCalledWith([{ id: STUDENT, name: "נועה (stud)" }]);
    expect(client.addMembers).toHaveBeenCalledWith([TEACHER, STUDENT]);
  });

  it("(c) upserts both missing users before querying the channel", async () => {
    const client = installClient([]);

    await ensureLiveStreamChannel("lesson-1", CHANNEL);

    expect(db.lessonFindUnique).toHaveBeenCalledWith({
      where: { id: "lesson-1" },
      select: {
        teacherId: true,
        studentId: true,
        teacher: { select: { id: true, name: true } },
        student: { select: { id: true, name: true } },
      },
    });
    expect(client.upsert).toHaveBeenCalledWith([
      { id: TEACHER, name: "משה (teac)" },
      { id: STUDENT, name: "נועה (stud)" },
    ]);
    expect(client.queryUsers.mock.invocationCallOrder[0]).toBeLessThan(
      client.upsert.mock.invocationCallOrder[0]
    );
    expect(client.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      client.queryChannels.mock.invocationCallOrder[0]
    );
    expect(client.queryChannels.mock.invocationCallOrder[0]).toBeLessThan(
      client.addMembers.mock.invocationCallOrder[0]
    );
  });

  it.each([
    { teacherName: "", studentName: null },
    { teacherName: null, studentName: "   " },
  ])("(d) falls back when a stored name is empty (%j)", async ({ teacherName, studentName }) => {
    db.lessonFindUnique.mockResolvedValue({
      teacherId: TEACHER,
      studentId: STUDENT,
      teacher: { id: TEACHER, name: teacherName },
      student: { id: STUDENT, name: studentName },
    });
    const client = installClient([{ id: CHANNEL, memberIds: [TEACHER, STUDENT] }]);

    await ensureLiveStreamChannel("lesson-1", CHANNEL);

    expect(client.upsert).toHaveBeenCalledWith([
      { id: TEACHER, name: "User teac" },
      { id: STUDENT, name: "User stud" },
    ]);
  });

  it("(e) logs a queryUsers failure and still returns the channel id", async () => {
    const failure = Object.assign(new Error("query users failed"), { code: 9 });
    const queryUsers = vi.fn().mockRejectedValue(failure);
    const client = installClient(
      [{ id: CHANNEL, memberIds: [] }],
      vi.fn().mockResolvedValue({}),
      queryUsers
    );

    await expect(ensureLiveStreamChannel("lesson-1", CHANNEL)).resolves.toBe(CHANNEL);
    expect(client.upsert).not.toHaveBeenCalled();
    expect(client.addMembers).toHaveBeenCalledWith([TEACHER, STUDENT]);
    expect(console.error).toHaveBeenCalledWith(
      "[ensureLiveStreamChannel] failed",
      expect.objectContaining({
        lessonId: "lesson-1",
        teacherId: TEACHER,
        studentId: STUDENT,
        code: 9,
      })
    );
  });
});

describe("user lookup failure still repairs the channel", () => {
  beforeEach(() => {
    stream.hasStreamCredentials.mockReturnValue(true);
    db.lessonFindUnique.mockResolvedValue({
      teacherId: TEACHER,
      studentId: STUDENT,
      teacher: { id: TEACHER, name: "משה כהן" },
      student: { id: STUDENT, name: "נועה לוי" },
    });
  });

  it("(a) adds both members when queryUsers throws and the channel has zero members", async () => {
    const failure = Object.assign(new Error("query users failed"), { code: 9 });
    const client = installClient(
      [{ id: CHANNEL, memberIds: [] }],
      vi.fn().mockResolvedValue({}),
      vi.fn().mockRejectedValue(failure)
    );

    await expect(ensureLiveStreamChannel("lesson-1", CHANNEL)).resolves.toBe(CHANNEL);

    expect(client.upsert).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
    expect(client.addMembers).toHaveBeenCalledWith([TEACHER, STUDENT]);
    expect(console.error).toHaveBeenCalledWith(
      "[ensureLiveStreamChannel] failed",
      expect.objectContaining({
        lessonId: "lesson-1",
        teacherId: TEACHER,
        studentId: STUDENT,
        code: 9,
        error: "query users failed",
      })
    );
  });

  it("(b) creates a missing channel when queryUsers throws", async () => {
    const failure = Object.assign(new Error("query users failed"), { code: 9 });
    const client = installClient([], vi.fn().mockResolvedValue({}), vi.fn().mockRejectedValue(failure));

    await ensureLiveStreamChannel("lesson-1", CHANNEL);

    expect(client.upsert).not.toHaveBeenCalled();
    expect(client.channel).toHaveBeenCalledWith("messaging", CHANNEL, {
      members: [TEACHER, STUDENT],
      created_by_id: TEACHER,
    });
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.addMembers).toHaveBeenCalledWith([TEACHER, STUDENT]);
    expect(client.create.mock.invocationCallOrder[0]).toBeLessThan(
      client.addMembers.mock.invocationCallOrder[0]
    );
  });

  it("(c) logs a lookup failure and a membership failure without throwing", async () => {
    const lookupFailure = Object.assign(new Error("query users failed"), { code: 9 });
    const memberFailure = Object.assign(new Error("add members failed"), { code: 17 });
    const client = installClient(
      [{ id: CHANNEL, memberIds: [] }],
      vi.fn().mockResolvedValue({}),
      vi.fn().mockRejectedValue(lookupFailure)
    );
    client.addMembers.mockRejectedValue(memberFailure);

    await expect(ensureLiveStreamChannel("lesson-1", CHANNEL)).resolves.toBe(CHANNEL);

    expect(client.upsert).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      "[ensureLiveStreamChannel] failed",
      expect.objectContaining({ code: 9, error: "query users failed" })
    );
    expect(console.error).toHaveBeenCalledWith(
      "[ensureLiveStreamChannel] failed",
      expect.objectContaining({
        lessonId: "lesson-1",
        teacherId: TEACHER,
        studentId: STUDENT,
        code: 17,
        error: "add members failed",
      })
    );
  });
});
