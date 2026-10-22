import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findLesson: vi.fn(),
  updateLesson: vi.fn(),
  aggregate: vi.fn(),
  createPage: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        lesson: { findUnique: db.findLesson, update: db.updateLesson },
        notebookPage: { aggregate: db.aggregate, create: db.createPage },
      }),
  },
}));

import { allocateLessonStartPage, nextFreePageIndex } from "../../lib/notebooks/page-allocation";

const LESSON = "lesson-1";

function uniqueConflict(): Error {
  const error = new Error("Unique constraint failed");
  (error as Error & { code: string }).code = "P2002";
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("nextFreePageIndex", () => {
  it("starts at 0 and steps past the highest page", () => {
    expect(nextFreePageIndex(null)).toBe(0);
    expect(nextFreePageIndex(0)).toBe(1);
    expect(nextFreePageIndex(7)).toBe(8);
  });
});

describe("allocateLessonStartPage", () => {
  it("allocates the next page once and returns the same start page on the next call", async () => {
    let lesson: {
      id: string;
      status: string;
      notebookId: string;
      startPage: number | null;
      endPage: number | null;
    } = {
      id: LESSON,
      status: "SCHEDULED",
      notebookId: "nb-1",
      startPage: null,
      endPage: null,
    };
    let highest: number | null = null;

    db.findLesson.mockImplementation(async () => ({ ...lesson }));
    db.aggregate.mockImplementation(async () => ({ _max: { pageIndex: highest } }));
    db.createPage.mockImplementation(async ({ data }: { data: { pageIndex: number; paperStyle: string } }) => {
      highest = data.pageIndex;
      return data;
    });
    db.updateLesson.mockImplementation(async ({ data }: { data: { startPage: number } }) => {
      lesson = { ...lesson, startPage: data.startPage };
      return lesson;
    });

    const first = await allocateLessonStartPage(LESSON);
    const second = await allocateLessonStartPage(LESSON);

    expect(first).toEqual({ startPage: 0, endPage: null });
    expect(second).toEqual({ startPage: 0, endPage: null });
    expect(db.createPage).toHaveBeenCalledTimes(1);
    expect(db.createPage).toHaveBeenCalledWith({
      data: { notebookId: "nb-1", pageIndex: 0, paperStyle: "grid" },
    });
    expect(db.updateLesson).toHaveBeenCalledTimes(1);
    expect(db.updateLesson).toHaveBeenCalledWith({
      where: { id: LESSON },
      data: { startPage: 0 },
    });
  });

  it("retries after a unique page conflict and takes the next free index", async () => {
    const lesson = {
      id: LESSON,
      status: "IN_PROGRESS",
      notebookId: "nb-1",
      startPage: null as number | null,
      endPage: 2,
    };
    let highest = 4;
    let conflicts = 0;

    db.findLesson.mockImplementation(async () => ({ ...lesson }));
    db.aggregate.mockImplementation(async () => ({ _max: { pageIndex: highest } }));
    db.createPage.mockImplementation(async ({ data }: { data: { pageIndex: number } }) => {
      if (conflicts === 0) {
        conflicts += 1;
        highest = data.pageIndex;
        throw uniqueConflict();
      }
      lesson.startPage = data.pageIndex;
      return data;
    });
    db.updateLesson.mockImplementation(async ({ data }: { data: { startPage: number } }) => {
      lesson.startPage = data.startPage;
      return lesson;
    });

    const allocated = await allocateLessonStartPage(LESSON);

    expect(allocated).toEqual({ startPage: 6, endPage: 2 });
    expect(db.createPage).toHaveBeenCalledTimes(2);
    expect(db.createPage).toHaveBeenLastCalledWith({
      data: { notebookId: "nb-1", pageIndex: 6, paperStyle: "grid" },
    });
  });

  it.each(["COMPLETED", "CANCELLED", "CANCELLED_LATE"])(
    "does not allocate a %s lesson that has no start page",
    async (status) => {
      db.findLesson.mockResolvedValue({
        id: LESSON,
        status,
        notebookId: "nb-1",
        startPage: null,
        endPage: null,
      });

      await expect(allocateLessonStartPage(LESSON)).resolves.toBeNull();
      expect(db.createPage).not.toHaveBeenCalled();
      expect(db.updateLesson).not.toHaveBeenCalled();
    },
  );

  it("returns an existing start page for a completed lesson without inserting another page", async () => {
    db.findLesson.mockResolvedValue({
      id: LESSON,
      status: "COMPLETED",
      notebookId: "nb-1",
      startPage: 3,
      endPage: 5,
    });

    await expect(allocateLessonStartPage(LESSON)).resolves.toEqual({ startPage: 3, endPage: 5 });
    expect(db.createPage).not.toHaveBeenCalled();
  });
});
