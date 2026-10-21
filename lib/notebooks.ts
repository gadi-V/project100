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
