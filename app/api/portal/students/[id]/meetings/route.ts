import { NextResponse } from "next/server";
import { prisma } from "../../../../../../lib/prisma";
import { requireAuth } from "../../../../../../lib/api-auth";
import { writeAuditLog } from "../../../../../../lib/audit";
import { INTAKE_RECORDER_ROLES } from "../../../../../../lib/auth/staff-roles";
import { lessonAntiCollisionWindow } from "../../../../../../lib/scheduling";
import {
  listMeetingRows,
  listTeacherOptions,
  resolveStudentAccess,
} from "../../../../../../lib/student-portal";
import {
  parseScheduleMeetingInput,
  type MeetingGroupStatus,
  type ScheduleMeetingResult,
} from "../../../../../../lib/student-portal-shared";
import {
  buildDiagnosticQuestionnaireUrl,
  createWhatsAppQuadGroup,
  sendQuadGroupLessonUpdate,
} from "../../../../../../lib/whatsapp";

type RouteContext = { params: Promise<{ id: string }> };

const ACCESS_ERRORS = { 403: "אין לך גישה לתלמיד הזה", 404: "התלמיד לא נמצא" } as const;

const BOOKING_ERRORS: Record<string, { status: number; error: string }> = {
  STUDENT_OVERLAP: { status: 409, error: "לתלמיד כבר יש מפגש בשעה הזו" },
  TEACHER_OVERLAP: { status: 409, error: "המורה כבר משובץ למפגש אחר בשעה הזו" },
};

/** Meetings table + approved teachers for the schedule modal. REPRESENTATIVE / ADMIN / MANAGER only. */
export async function GET(_request: Request, { params }: RouteContext) {
  const auth = await requireAuth(INTAKE_RECORDER_ROLES);
  if (auth.error) return auth.error;
  const { id } = await params;

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) {
      return NextResponse.json({ success: false, error: ACCESS_ERRORS[access.status] }, { status: access.status });
    }
    const [meetings, teachers] = await Promise.all([listMeetingRows(id, auth.user), listTeacherOptions()]);
    return NextResponse.json(
      { success: true, data: { meetings, teachers } },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error: unknown) {
    console.error("Student meetings list error:", error);
    return NextResponse.json({ success: false, error: "טעינת המפגשים נכשלה" }, { status: 500 });
  }
}

/**
 * Schedules a lesson for the student (MAPPING by default) with an assigned teacher.
 * A MAPPING lesson opens the quad WhatsApp group (student, teacher, parent, admin) with the welcome
 * message; when the student already has a group, an update is posted there instead. WhatsApp
 * failures never roll back the lesson: the response carries `whatsappGroupCreated: false`.
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
  const parsed = parseScheduleMeetingInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.errors.join(" · ") }, { status: 400 });
  }
  const { teacherId, subject, scheduledAt, durationMinutes, lessonType } = parsed.data;

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) {
      return NextResponse.json({ success: false, error: ACCESS_ERRORS[access.status] }, { status: access.status });
    }

    const [student, teacher] = await Promise.all([
      prisma.user.findUnique({
        where: { id },
        select: { id: true, name: true, phone: true, parentName: true, parentPhone: true, whatsappGroupId: true },
      }),
      prisma.user.findUnique({
        where: { id: teacherId },
        select: { id: true, name: true, phone: true, role: true },
      }),
    ]);
    if (!student) {
      return NextResponse.json({ success: false, error: ACCESS_ERRORS[404] }, { status: 404 });
    }
    if (!teacher || teacher.role !== "TEACHER") {
      return NextResponse.json({ success: false, error: "המורה לא נמצא" }, { status: 404 });
    }

    const { windowStart, windowEnd } = lessonAntiCollisionWindow(scheduledAt);
    const activeInWindow = {
      status: { in: ["SCHEDULED", "IN_PROGRESS"] },
      scheduledAt: { gt: windowStart, lt: windowEnd },
    };

    let lesson: { id: string };
    try {
      lesson = await prisma.$transaction(async (tx) => {
        const [studentOverlap, teacherOverlap] = await Promise.all([
          tx.lesson.findFirst({ where: { studentId: id, ...activeInWindow }, select: { id: true } }),
          tx.lesson.findFirst({ where: { teacherId, ...activeInWindow }, select: { id: true } }),
        ]);
        if (studentOverlap) throw new Error("STUDENT_OVERLAP");
        if (teacherOverlap) throw new Error("TEACHER_OVERLAP");

        return tx.lesson.create({
          data: {
            studentId: id,
            teacherId,
            title: subject,
            scheduledAt,
            durationMinutes,
            status: "SCHEDULED",
            lessonType,
          },
          select: { id: true },
        });
      });
    } catch (txError: unknown) {
      const known = txError instanceof Error ? BOOKING_ERRORS[txError.message] : undefined;
      if (known) return NextResponse.json({ success: false, error: known.error }, { status: known.status });
      throw txError;
    }

    let groupStatus: MeetingGroupStatus = "NOT_OPENED";
    let groupChatId: string | null = null;
    let groupUpdateSent = false;
    let lessonLinked = false;
    let whatsappErrorCode: string | null = null;

    try {
      if (student.whatsappGroupId) {
        groupStatus = "EXISTING";
        groupChatId = student.whatsappGroupId;
        const update = await sendQuadGroupLessonUpdate(student.whatsappGroupId, {
          studentName: student.name,
          teacherName: teacher.name,
          subject,
          scheduledAt,
          durationMinutes,
          lessonType,
        });
        groupUpdateSent = update.sent;
        if (!update.sent) console.error(`[meetings] group update for ${id} not sent: ${update.error}`);
      } else if (lessonType === "MAPPING") {
        const created = await createWhatsAppQuadGroup({
          student: { name: student.name, phone: student.phone },
          teacher: { name: teacher.name, phone: teacher.phone },
          parent: student.parentPhone
            ? { name: student.parentName ?? undefined, phone: student.parentPhone }
            : undefined,
          lesson: { scheduledAt, durationMinutes, subject },
          questionnaireUrl: buildDiagnosticQuestionnaireUrl(),
        });

        if (created.ok) {
          const claimed = await prisma.user.updateMany({
            where: { id, whatsappGroupId: null },
            data: { whatsappGroupId: created.chatId, quadGroupUrl: created.inviteUrl },
          });
          if (claimed.count === 1) {
            groupStatus = "OPENED";
            groupChatId = created.chatId;
          } else {
            // A parallel request stored its group first; link the lesson to that one.
            const stored = await prisma.user.findUnique({ where: { id }, select: { whatsappGroupId: true } });
            groupStatus = "EXISTING";
            groupChatId = stored?.whatsappGroupId ?? null;
            console.error(`[meetings] duplicate quad group ${created.chatId} for ${id}; kept ${groupChatId}`);
          }

          await writeAuditLog({
            actorId: auth.user.id,
            action: "WHATSAPP_QUAD_GROUP_CREATED",
            entityType: "User",
            entityId: id,
            metadata: {
              chatId: created.chatId,
              groupName: created.groupName,
              lessonId: lesson.id,
              teacherId,
              roles: created.participants.map((p) => p.role),
              droppedRoles: created.droppedRoles,
              welcomeSent: created.welcome.sent,
              welcomeError: created.welcome.sent ? null : created.welcome.error,
              duplicate: groupStatus !== "OPENED",
            },
          });
        } else {
          groupStatus = "FAILED";
          whatsappErrorCode = created.error.code;
          console.error(`[meetings] quad group for ${id} failed (${created.error.code}): ${created.error.message}`);
        }
      }

      if (groupChatId) {
        await prisma.lesson.update({ where: { id: lesson.id }, data: { whatsappGroupId: groupChatId } });
        lessonLinked = true;
      }
    } catch (whatsappError: unknown) {
      if (groupStatus === "NOT_OPENED") groupStatus = "FAILED";
      whatsappErrorCode = whatsappErrorCode ?? "UNEXPECTED";
      console.error(`[meetings] WhatsApp step for lesson ${lesson.id} failed:`, whatsappError);
    }

    const whatsappGroupCreated = groupStatus === "OPENED";
    const whatsappGroupLinked = lessonLinked;

    await writeAuditLog({
      actorId: auth.user.id,
      action: lessonType === "MAPPING" ? "MAPPING_LESSON_SCHEDULED" : "LESSON_SCHEDULED",
      entityType: "Lesson",
      entityId: lesson.id,
      metadata: {
        studentId: id,
        teacherId,
        lessonType,
        subject,
        scheduledAt: scheduledAt.toISOString(),
        durationMinutes,
        groupStatus,
        whatsappGroupCreated,
        groupUpdateSent,
        whatsappErrorCode,
      },
    });

    const data: ScheduleMeetingResult = {
      lessonId: lesson.id,
      lessonType,
      scheduledAt: scheduledAt.toISOString(),
      durationMinutes,
      teacherName: teacher.name,
      groupStatus,
      whatsappGroupCreated,
      whatsappGroupLinked,
      groupUpdateSent,
      whatsappErrorCode,
    };
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error: unknown) {
    console.error("Schedule meeting error:", error);
    return NextResponse.json({ success: false, error: "קביעת המפגש נכשלה" }, { status: 500 });
  }
}
