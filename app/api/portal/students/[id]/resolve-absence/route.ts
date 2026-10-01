import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../../../lib/prisma";
import { requireAuth } from "../../../../../../lib/api-auth";
import { toCommunicationAuthorRole } from "../../../../../../lib/communication-templates";
import {
  ABSENCE_RESOLUTION_CONTEXT,
  ABSENCE_RESOLUTION_ROLES,
  MAKEUP_LESSON_TYPE,
  makeupLessonTitle,
  parseResolveAbsenceInput,
  renderAbsenceResolutionContent,
  type ResolveAbsenceResponse,
} from "../../../../../../lib/absence-resolution";
import { PENDING_SCHEDULE_STATUS } from "../../../../../../lib/pedagogic-decision";
import { clearUnexcusedAbsenceFlag, resolveStudentAccess } from "../../../../../../lib/student-portal";
import { REGULAR_LESSON_MINUTES } from "../../../../../../lib/student-portal-shared";

type RouteContext = { params: Promise<{ id: string }> };

const ACCESS_ERRORS = { 403: "אין לך גישה לתלמיד הזה", 404: "התלמיד לא נמצא" } as const;

class NoOpenAbsenceError extends Error {
  constructor() {
    super("NO_OPEN_ABSENCE");
  }
}

function fail(error: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error } satisfies ResolveAbsenceResponse, { status });
}

/**
 * Closes the follow-up of an unexcused absence after the call with the family. REPRESENTATIVE / ADMIN / MANAGER.
 * One transaction: the "חיסור לא מוצדק" flag leaves the CRM card, the call is written to the communication tab
 * ("שיחת בירור חיסור"), an excused absence with a make-up opens a PENDING_SCHEDULE "שיעור השלמה" with the missed
 * lesson's teacher, and AuditLog `ABSENCE_RESOLVED` is recorded. `409` when there is no open absence (already handled).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await requireAuth(ABSENCE_RESOLUTION_ROLES);
  if (auth.error) return auth.error;
  const { id } = await params;

  const authorRole = toCommunicationAuthorRole(auth.user.role);
  if (!authorRole) return fail("אין לך הרשאה לפעולה זו", 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("גוף הבקשה אינו JSON תקין", 400);
  }
  const parsed = parseResolveAbsenceInput(body);
  if (!parsed.ok) return fail(parsed.errors.join(" · "), 400);
  const input = parsed.data;
  const makeup = input.resolutionType === "EXCUSED_MAKEUP";

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) return fail(ACCESS_ERRORS[access.status], access.status);

    const absentLesson = await prisma.lesson.findFirst({
      where: { studentId: id, attendanceStatus: "ABSENT", ...(input.lessonId ? { id: input.lessonId } : {}) },
      orderBy: { scheduledAt: "desc" },
      select: {
        id: true,
        title: true,
        scheduledAt: true,
        startTime: true,
        teacherId: true,
        durationMinutes: true,
        whatsappGroupId: true,
      },
    });
    if (input.lessonId && !absentLesson) return fail("השיעור שהוחסר לא נמצא אצל התלמיד הזה", 404);
    if (makeup && !absentLesson) {
      return fail("לא נמצא שיעור שסומן כחיסור, ולכן אי אפשר לפתוח שיעור השלמה. אפשר לקבוע מפגש חדש בלשונית המפגשים", 422);
    }

    const now = new Date();
    const absentStartsAt = absentLesson ? (absentLesson.startTime ?? absentLesson.scheduledAt) : null;

    let saved: { studentStatus: string[]; makeupLessonId: string | null };
    try {
      saved = await prisma.$transaction(async (tx) => {
        const studentStatus = await clearUnexcusedAbsenceFlag(tx, id, auth.user.id, now);
        if (!studentStatus) throw new NoOpenAbsenceError();

        let makeupLessonId: string | null = null;
        if (makeup && absentLesson) {
          const created = await tx.lesson.create({
            data: {
              studentId: id,
              teacherId: absentLesson.teacherId,
              title: makeupLessonTitle(absentLesson.title),
              scheduledAt: now,
              durationMinutes: absentLesson.durationMinutes ?? REGULAR_LESSON_MINUTES,
              status: PENDING_SCHEDULE_STATUS,
              lessonType: MAKEUP_LESSON_TYPE,
              whatsappGroupId: absentLesson.whatsappGroupId,
            },
            select: { id: true },
          });
          makeupLessonId = created.id;
        }

        const content = renderAbsenceResolutionContent({
          resolutionType: input.resolutionType,
          reason: input.reason,
          notes: input.notes,
          absentLesson: absentLesson && absentStartsAt ? { title: absentLesson.title, startsAt: absentStartsAt } : null,
          makeupLessonCreated: makeupLessonId !== null,
        });
        const log = await tx.studentCommunicationLog.create({
          data: {
            studentId: id,
            authorId: auth.user.id,
            authorName: auth.user.name,
            authorRole,
            type: "GENERAL",
            courseContext: ABSENCE_RESOLUTION_CONTEXT,
            content,
            structuredData: {
              source: "ABSENCE_RESOLUTION",
              resolutionType: input.resolutionType,
              reason: input.reason,
              notes: input.notes,
              absentLessonId: absentLesson?.id ?? null,
              makeupLessonId,
            } satisfies Prisma.InputJsonValue,
          },
          select: { id: true },
        });

        await tx.auditLog.create({
          data: {
            actorId: auth.user.id,
            action: "ABSENCE_RESOLVED",
            entityType: "Student",
            entityId: id,
            metadata: {
              resolutionType: input.resolutionType,
              reason: input.reason,
              notes: input.notes,
              absentLessonId: absentLesson?.id ?? null,
              makeupLessonId,
              communicationLogId: log.id,
              studentStatus,
            } satisfies Prisma.InputJsonValue,
          },
        });

        return { studentStatus, makeupLessonId };
      });
    } catch (txError: unknown) {
      if (txError instanceof NoOpenAbsenceError) {
        return fail("לתלמיד אין חיסור פתוח לבירור. ייתכן שהחיסור כבר טופל", 409);
      }
      throw txError;
    }

    return NextResponse.json({
      success: true,
      absenceResolved: true,
      makeupLessonCreated: saved.makeupLessonId !== null,
      makeupLessonId: saved.makeupLessonId,
      studentStatus: saved.studentStatus,
    } satisfies ResolveAbsenceResponse);
  } catch (error: unknown) {
    console.error("Absence resolution error:", error);
    return fail("שמירת הטיפול בחיסור נכשלה", 500);
  }
}
