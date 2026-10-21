import { Prisma, PrismaClient, type Role } from "@prisma/client";
import { prisma } from "./prisma";

/** Lesson statuses that mean the meeting was cancelled. A teacher needs some other lesson. */
const CANCELED_LESSON_STATUSES = ["CANCELLED", "CANCELLED_LATE"] as const;

type NotebookDb = PrismaClient | Prisma.TransactionClient;

export type NotebookViewer = {
  id: string;
  role: Role;
};

const notebookInclude = {
  student: { select: { id: true, name: true } },
  pages: { orderBy: { pageIndex: "asc" as const } },
} satisfies Prisma.NotebookInclude;

export type NotebookWithPages = Prisma.NotebookGetPayload<{ include: typeof notebookInclude }>;

/**
 * One notebook per student. Safe to call on every booking: the unique studentId
 * makes a second call return the existing row.
 */
export async function ensureNotebookForStudent(studentId: string, db: NotebookDb = prisma) {
  return db.notebook.upsert({
    where: { studentId },
    create: { studentId },
    update: {},
  });
}

/**
 * Idempotent. Creates the student's notebook when it is missing and stores its id on the lesson.
 * A second call for the same lesson does not write the lesson row again.
 */
export async function ensureNotebookForLesson(lessonId: string) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    select: { id: true, studentId: true, notebookId: true },
  });
  if (!lesson) return null;

  const notebook = await ensureNotebookForStudent(lesson.studentId);
  if (lesson.notebookId !== notebook.id) {
    await prisma.lesson.update({
      where: { id: lesson.id },
      data: { notebookId: notebook.id },
    });
  }
  return notebook;
}

/**
 * Who may open a student's notebook.
 * Owner student; a teacher with at least one non-cancelled lesson with that student;
 * MANAGER and ADMIN. TeacherReferral does not grant access. Everyone else is refused.
 * Missing and refused both return null, same as getAuthorizedLessonById.
 */
export async function getNotebookAccess(
  user: NotebookViewer,
  notebookId: string,
): Promise<NotebookWithPages | null> {
  const notebook = await prisma.notebook.findUnique({
    where: { id: notebookId },
    include: notebookInclude,
  });
  if (!notebook) return null;

  if (user.role === "MANAGER" || user.role === "ADMIN") return notebook;
  if (user.role === "STUDENT" && notebook.studentId === user.id) return notebook;

  if (user.role === "TEACHER") {
    const lesson = await prisma.lesson.findFirst({
      where: {
        teacherId: user.id,
        studentId: notebook.studentId,
        status: { notIn: [...CANCELED_LESSON_STATUSES] },
      },
      select: { id: true },
    });
    if (lesson) return notebook;
  }

  return null;
}
