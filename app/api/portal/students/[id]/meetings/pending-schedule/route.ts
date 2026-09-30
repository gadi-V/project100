import { NextResponse } from "next/server";
import { prisma } from "../../../../../../../lib/prisma";
import { requireAuth } from "../../../../../../../lib/api-auth";
import { writeAuditLog } from "../../../../../../../lib/audit";
import { INTAKE_RECORDER_ROLES } from "../../../../../../../lib/auth/staff-roles";
import { PENDING_SCHEDULE_STATUS } from "../../../../../../../lib/pedagogic-decision";
import {
  parseSchedulePendingInput,
  type SchedulePendingResult,
} from "../../../../../../../lib/lesson-lifecycle";
import {
  bookTeacherSlot,
  findLessonConflict,
  resolveStudentAccess,
  type LessonConflict,
} from "../../../../../../../lib/student-portal";
import { formatIsraelDateTime } from "../../../../../../../lib/student-portal-shared";
import { sendQuadGroupPrivateLessonScheduled } from "../../../../../../../lib/whatsapp";

type RouteContext = { params: Promise<{ id: string }> };

const ACCESS_ERRORS = { 403: "אין לך גישה לתלמיד הזה", 404: "התלמיד לא נמצא" } as const;

class ScheduleConflictError extends Error {
  constructor(readonly conflict: NonNullable<LessonConflict> | null) {
    super("SCHEDULE_CONFLICT");
  }
}

/**
 * Locks a date, time and teacher for an extra private lesson waiting in PENDING_SCHEDULE.
 * REPRESENTATIVE / ADMIN / MANAGER only. Anti-collision checked for student and teacher (`409`); the lesson
 * becomes SCHEDULED and is linked to the quad group, which gets a scheduling update. A failed WhatsApp post
 * never rolls back the lesson (`whatsappDispatched: false`).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await requireAuth(INTAKE_RECORDER_ROLES);
  if (auth.error) return auth.error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "גוף הבקשה אינו JSON תקין" }, { status: 400 });
  }
  const parsed = parseSchedulePendingInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.errors.join(" · ") }, { status: 400 });
  }
  const { lessonId, teacherId, scheduledAt } = parsed.data;

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) {
      return NextResponse.json({ success: false, error: ACCESS_ERRORS[access.status] }, { status: access.status });
    }

    const [lesson, student, teacher] = await Promise.all([
      prisma.lesson.findUnique({
        where: { id: lessonId },
        select: { id: true, studentId: true, status: true, title: true, durationMinutes: true },
      }),
      prisma.user.findUnique({ where: { id }, select: { whatsappGroupId: true } }),
      prisma.user.findUnique({ where: { id: teacherId }, select: { id: true, name: true, role: true, isApproved: true } }),
    ]);
    if (!lesson || lesson.studentId !== id) {
      return NextResponse.json({ success: false, error: "השיעור לא נמצא" }, { status: 404 });
    }
    if (lesson.status !== PENDING_SCHEDULE_STATUS) {
      return NextResponse.json({ success: false, error: "השיעור הזה כבר שובץ או אינו ממתין לשיבוץ" }, { status: 409 });
    }
    if (!teacher || teacher.role !== "TEACHER" || !teacher.isApproved) {
      return NextResponse.json({ success: false, error: "המורה לא נמצא או שאינו פעיל" }, { status: 404 });
    }

    const groupId = student?.whatsappGroupId?.trim() || null;
    const durationMinutes = lesson.durationMinutes ?? 50;

    try {
      await prisma.$transaction(async (tx) => {
        const conflict = await findLessonConflict(tx, { studentId: id, teacherId, at: scheduledAt, excludeLessonId: lessonId });
        if (conflict) throw new ScheduleConflictError(conflict);
        const claimed = await tx.lesson.updateMany({
          where: { id: lessonId, status: PENDING_SCHEDULE_STATUS },
          data: {
            status: "SCHEDULED",
            scheduledAt,
            startTime: null,
            endTime: null,
            teacherId,
            whatsappGroupId: groupId,
            reminderSent: false,
          },
        });
        if (claimed.count !== 1) throw new ScheduleConflictError(null);
        await bookTeacherSlot(tx, teacherId, scheduledAt);
      });
    } catch (txError: unknown) {
      if (txError instanceof ScheduleConflictError) {
        const { conflict } = txError;
        const error = !conflict
          ? "השיעור כבר שובץ בבקשה אחרת"
          : conflict.party === "STUDENT"
            ? `לתלמיד כבר יש מפגש סמוך ל-${formatIsraelDateTime(conflict.at.toISOString())}`
            : `המורה כבר משובץ למפגש סמוך ל-${formatIsraelDateTime(conflict.at.toISOString())}`;
        return NextResponse.json({ success: false, error }, { status: 409 });
      }
      throw txError;
    }

    const subject = lesson.title?.trim() || "שיעור פרטי";
    let whatsappDispatched = false;
    if (groupId) {
      try {
        const sent = await sendQuadGroupPrivateLessonScheduled(groupId, {
          subject,
          scheduledAt,
          durationMinutes,
          teacherName: teacher.name,
        });
        whatsappDispatched = sent.sent;
        if (!sent.sent) console.error(`[pending-schedule] group post for lesson ${lessonId} not sent: ${sent.error}`);
      } catch (whatsappError: unknown) {
        console.error(`[pending-schedule] group post for lesson ${lessonId} failed:`, whatsappError);
      }
    }

    await writeAuditLog({
      actorId: auth.user.id,
      action: "PENDING_LESSON_SCHEDULED",
      entityType: "Lesson",
      entityId: lessonId,
      metadata: { studentId: id, teacherId, scheduledAt: scheduledAt.toISOString(), whatsappDispatched },
    });

    const data: SchedulePendingResult = { lessonId, scheduledAt: scheduledAt.toISOString(), teacherName: teacher.name };
    return NextResponse.json({ success: true, data, whatsappDispatched });
  } catch (error: unknown) {
    console.error("Pending lesson scheduling error:", error);
    return NextResponse.json({ success: false, error: "שיבוץ השיעור נכשל" }, { status: 500 });
  }
}
