import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { isIntakeRecorderRole } from "./auth/staff-roles";
import { whatsappUrl } from "./student-portal";
import {
  DIRECTORY_ABSENCE_FILTER,
  gradeVariants,
  paginationMeta,
  type StudentDirectoryPage,
  type StudentDirectoryQuery,
  type StudentDirectoryRow,
} from "./student-directory-shared";

/**
 * Server-only student list behind `GET /api/portal/students`.
 * REPRESENTATIVE / ADMIN / MANAGER see every student. A TEACHER sees only students with at least
 * one lesson (scheduled or past) where they are the teacher, and only their own lessons in the
 * next / last lesson columns. Any other role gets nothing.
 */

type Viewer = { id: string; role: string };

/** Lessons that never took place: cancelled, or extra private lessons still waiting for a slot. */
const CANCELLED_STATUSES = ["CANCELLED", "CANCELLED_LATE", "PENDING_SCHEDULE"];

/** Digit spellings of a phone term, so "0547654321" also finds "+972547654321" and vice versa. */
function phoneVariants(token: string): string[] {
  const digits = token.replace(/\D/g, "");
  if (digits.length < 3) return [];
  const variants = new Set([digits]);
  if (digits.startsWith("0")) variants.add(digits.slice(1));
  if (digits.startsWith("972")) variants.add(`0${digits.slice(3)}`);
  return [...variants];
}

function searchTokenCondition(token: string): Prisma.UserWhereInput {
  const contains = { contains: token, mode: "insensitive" as const };
  return {
    OR: [
      { name: contains },
      { phone: contains },
      { email: contains },
      { studentProfile: { is: { firstName: contains } } },
      { studentProfile: { is: { lastName: contains } } },
      { studentProfile: { is: { city: contains } } },
      ...phoneVariants(token).map((digits) => ({ phone: { contains: digits } })),
    ],
  };
}

export function buildStudentDirectoryWhere(viewer: Viewer, query: StudentDirectoryQuery): Prisma.UserWhereInput | null {
  const conditions: Prisma.UserWhereInput[] = [{ role: "STUDENT" }];

  if (viewer.role === "TEACHER") {
    conditions.push({ takenLessons: { some: { teacherId: viewer.id } } });
  } else if (!isIntakeRecorderRole(viewer.role)) {
    return null;
  }

  for (const token of query.searchTokens) conditions.push(searchTokenCondition(token));

  if (query.statuses.length > 0) {
    conditions.push({ studentProfile: { is: { studentStatus: { hasSome: query.statuses } } } });
  }

  if (query.grade) {
    const grades = gradeVariants(query.grade);
    conditions.push({
      OR: [
        { studentProfile: { is: { grade: { in: grades } } } },
        {
          AND: [
            { OR: [{ studentProfile: { is: null } }, { studentProfile: { is: { grade: null } } }] },
            { intakeAssessments: { some: { grade: { in: grades } } } },
          ],
        },
      ],
    });
  }

  return { AND: conditions };
}

type LessonSummary = { studentId: string; scheduledAt: Date; teacher: { name: string } | null };

export async function listStudentDirectory(
  viewer: Viewer,
  query: StudentDirectoryQuery,
  now: Date = new Date()
): Promise<StudentDirectoryPage> {
  const where = buildStudentDirectoryWhere(viewer, query);
  if (!where) return { students: [], unexcusedAbsenceCount: 0, ...paginationMeta(0, 1, query.limit) };

  const absenceWhere = buildStudentDirectoryWhere(viewer, {
    ...query,
    searchTokens: [],
    statuses: [DIRECTORY_ABSENCE_FILTER],
    grade: null,
  }) as Prisma.UserWhereInput;
  const [totalCount, unexcusedAbsenceCount] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.count({ where: absenceWhere }),
  ]);
  const { skip, ...meta } = paginationMeta(totalCount, query.page, query.limit);
  if (totalCount === 0) return { students: [], unexcusedAbsenceCount, ...meta };

  const users = await prisma.user.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip,
    take: meta.limit,
    select: {
      id: true,
      name: true,
      phone: true,
      classTrack: true,
      studentProfile: {
        select: { firstName: true, lastName: true, grade: true, studyGroup: true, city: true, studentStatus: true },
      },
      intakeAssessments: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { grade: true, levelUnits: true },
      },
    },
  });

  const ids = users.map((user) => user.id);
  const scope: Prisma.LessonWhereInput = {
    studentId: { in: ids },
    ...(viewer.role === "TEACHER" ? { teacherId: viewer.id } : {}),
  };
  const lessonSelect = { studentId: true, scheduledAt: true, teacher: { select: { name: true } } } as const;

  const [upcoming, past]: [LessonSummary[], LessonSummary[]] = await Promise.all([
    prisma.lesson.findMany({
      where: {
        ...scope,
        OR: [{ status: "IN_PROGRESS" }, { status: "SCHEDULED", scheduledAt: { gte: now } }],
      },
      orderBy: { scheduledAt: "asc" },
      distinct: ["studentId"],
      select: lessonSelect,
    }),
    prisma.lesson.findMany({
      where: { ...scope, status: { notIn: CANCELLED_STATUSES }, scheduledAt: { lt: now } },
      orderBy: { scheduledAt: "desc" },
      distinct: ["studentId"],
      select: lessonSelect,
    }),
  ]);

  const nextByStudent = new Map(upcoming.map((lesson) => [lesson.studentId, lesson]));
  const lastByStudent = new Map(past.map((lesson) => [lesson.studentId, lesson]));

  const students: StudentDirectoryRow[] = users.map((user) => {
    const profile = user.studentProfile;
    const intake = user.intakeAssessments[0] ?? null;
    const profileName = [profile?.firstName, profile?.lastName].filter(Boolean).join(" ").trim();
    const next = nextByStudent.get(user.id) ?? null;
    const last = lastByStudent.get(user.id) ?? null;
    return {
      id: user.id,
      fullName: profileName || user.name,
      phone: user.phone,
      whatsappUrl: whatsappUrl(user.phone),
      grade: profile?.grade ?? intake?.grade ?? null,
      studyGroup: profile?.studyGroup ?? intake?.levelUnits ?? user.classTrack ?? null,
      city: profile?.city ?? null,
      statuses: profile?.studentStatus ?? [],
      nextLessonAt: next ? next.scheduledAt.toISOString() : null,
      lastLessonAt: last ? last.scheduledAt.toISOString() : null,
      teacherName: (next ?? last)?.teacher?.name ?? null,
    };
  });

  return { students, unexcusedAbsenceCount, ...meta };
}
