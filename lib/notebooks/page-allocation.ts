import { prisma } from "../prisma";

const ALLOCATION_ATTEMPTS = 5;
const ACTIVE_LESSON = new Set(["SCHEDULED", "IN_PROGRESS"]);

export type AllocatedLessonPages = {
  startPage: number;
  endPage: number | null;
};

/** First free index after the notebook's highest page. An empty notebook starts at 0. */
export function nextFreePageIndex(highest: number | null): number {
  if (highest == null || !Number.isFinite(highest)) return 0;
  return highest + 1;
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002";
}

/**
 * Claim `lesson.startPage` for an active lesson. A second call returns the same page.
 * Completed and cancelled lessons keep a start page they already have and never receive a new one.
 * Two rooms racing for the same index retry against the unique (notebookId, pageIndex) constraint.
 */
export async function allocateLessonStartPage(lessonId: string): Promise<AllocatedLessonPages | null> {
  for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const lesson = await tx.lesson.findUnique({
          where: { id: lessonId },
          select: { id: true, status: true, notebookId: true, startPage: true, endPage: true },
        });
        if (!lesson?.notebookId) return null;
        if (lesson.startPage != null) {
          return { startPage: lesson.startPage, endPage: lesson.endPage };
        }
        if (!ACTIVE_LESSON.has(lesson.status)) return null;

        const highest = await tx.notebookPage.aggregate({
          where: { notebookId: lesson.notebookId },
          _max: { pageIndex: true },
        });
        const pageIndex = nextFreePageIndex(highest._max.pageIndex);
        await tx.notebookPage.create({
          data: {
            notebookId: lesson.notebookId,
            pageIndex,
            paperStyle: "grid",
          },
        });
        await tx.lesson.update({
          where: { id: lesson.id },
          data: { startPage: pageIndex },
        });
        return { startPage: pageIndex, endPage: lesson.endPage };
      });
    } catch (error) {
      if (isUniqueConflict(error) && attempt < ALLOCATION_ATTEMPTS - 1) continue;
      if (isUniqueConflict(error)) {
        console.error("[notebook] page allocation conflict", { lessonId });
        return null;
      }
      throw error;
    }
  }
  return null;
}
