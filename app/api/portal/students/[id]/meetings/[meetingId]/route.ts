import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../../../../lib/prisma";
import { requireAuth } from "../../../../../../../lib/api-auth";
import { writeAuditLog } from "../../../../../../../lib/audit";
import { INTAKE_RECORDER_ROLES } from "../../../../../../../lib/auth/staff-roles";
import { toCommunicationAuthorRole, type CommunicationAuthorRole } from "../../../../../../../lib/communication-templates";
import { dailyRoomNameForLesson, deleteDailyRoom, roomNameFromDailyUrl } from "../../../../../../../lib/daily";
import {
  parseCancelInput,
  parseRescheduleInput,
  RESCHEDULE_BLOCK_LABELS,
  rescheduleBlock,
  type CancelResult,
  type RescheduleResult,
} from "../../../../../../../lib/lesson-lifecycle";
import {
  bookTeacherSlot,
  findLessonConflict,
  releaseTeacherSlot,
  resolveStudentAccess,
  studentHasDirectPackage,
  type LessonConflict,
} from "../../../../../../../lib/student-portal";
import { formatIsraelDateTime } from "../../../../../../../lib/student-portal-shared";
import {
  formatQuadLessonDate,
  sendQuadGroupLessonCancelled,
  sendQuadGroupLessonRescheduled,
  type QuadLessonChangeInput,
} from "../../../../../../../lib/whatsapp";

type RouteContext = { params: Promise<{ id: string; meetingId: string }> };

const ACCESS_ERRORS = { 403: "אין לך גישה לתלמיד הזה", 404: "התלמיד לא נמצא" } as const;

type StaffLesson = {
  id: string;
  studentId: string;
  teacherId: string;
  status: string;
  title: string | null;
  scheduledAt: Date;
  startTime: Date | null;
  durationMinutes: number | null;
  rescheduledCount: number;
  dailyRoomUrl: string | null;
  whatsappGroupId: string | null;
};

type LessonLookup =
  | { ok: true; lesson: StaffLesson; groupId: string | null; authorRole: CommunicationAuthorRole }
  | { ok: false; response: NextResponse };

class LifecycleConflictError extends Error {
  constructor(readonly conflict: NonNullable<LessonConflict> | null) {
    super("LIFECYCLE_CONFLICT");
  }
}

function conflictResponse(error: LifecycleConflictError): NextResponse {
  const { conflict } = error;
  const message = !conflict
    ? "השיעור עודכן בינתיים, רעננו ונסו שוב"
    : conflict.party === "STUDENT"
      ? `לתלמיד כבר יש מפגש סמוך ל-${formatIsraelDateTime(conflict.at.toISOString())}`
      : `המורה כבר משובץ למפגש סמוך ל-${formatIsraelDateTime(conflict.at.toISOString())}`;
  return NextResponse.json({ success: false, error: message }, { status: 409 });
}

/** Student access + the lesson, which must belong to that student. */
async function loadStaffLesson(
  viewer: { id: string; role: string },
  studentId: string,
  meetingId: string
): Promise<LessonLookup> {
  const authorRole = toCommunicationAuthorRole(viewer.role);
  if (!authorRole) {
    return { ok: false, response: NextResponse.json({ success: false, error: "אין לך הרשאה לפעולה זו" }, { status: 403 }) };
  }
  const access = await resolveStudentAccess(viewer, studentId);
  if (!access.ok) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: ACCESS_ERRORS[access.status] }, { status: access.status }),
    };
  }
  const [lesson, student] = await Promise.all([
    prisma.lesson.findUnique({
      where: { id: meetingId },
      select: {
        id: true,
        studentId: true,
        teacherId: true,
        status: true,
        title: true,
        scheduledAt: true,
        startTime: true,
        durationMinutes: true,
        rescheduledCount: true,
        dailyRoomUrl: true,
        whatsappGroupId: true,
      },
    }),
    prisma.user.findUnique({ where: { id: studentId }, select: { whatsappGroupId: true } }),
  ]);
  if (!lesson || lesson.studentId !== studentId) {
    return { ok: false, response: NextResponse.json({ success: false, error: "השיעור לא נמצא" }, { status: 404 }) };
  }
  const groupId = lesson.whatsappGroupId?.trim() || student?.whatsappGroupId?.trim() || null;
  return { ok: true, lesson, groupId, authorRole };
}

function notScheduledResponse(status: string): NextResponse {
  const error =
    status === "CANCELLED" || status === "CANCELLED_LATE" ? "השיעור כבר בוטל" : "אפשר לעדכן רק שיעור שנקבע וטרם התקיים";
  return NextResponse.json({ success: false, error }, { status: 409 });
}

/** Best effort: the classroom page provisions a fresh room for the new time on the next entry. */
async function teardownDailyRoom(lessonId: string, roomUrl: string | null): Promise<void> {
  if (!roomUrl) return;
  try {
    await deleteDailyRoom(roomNameFromDailyUrl(roomUrl) ?? dailyRoomNameForLesson(lessonId));
  } catch (roomError: unknown) {
    console.error(`[lesson-lifecycle] Daily room teardown for ${lessonId} failed:`, roomError);
  }
}

async function postToGroup(
  groupId: string | null,
  lessonId: string,
  send: (groupId: string) => Promise<{ sent: true } | { sent: false; error: string }>
): Promise<boolean> {
  if (!groupId) return false;
  try {
    const result = await send(groupId);
    if (!result.sent) console.error(`[lesson-lifecycle] group post for lesson ${lessonId} not sent: ${result.error}`);
    return result.sent;
  } catch (whatsappError: unknown) {
    console.error(`[lesson-lifecycle] group post for lesson ${lessonId} failed:`, whatsappError);
    return false;
  }
}

function subjectOf(lesson: StaffLesson): string {
  return lesson.title?.trim() || "שיעור פרטי";
}

/**
 * Reschedules a scheduled lesson (REPRESENTATIVE / ADMIN / MANAGER). Same policy as the student/teacher path:
 * more than 24 h before the start and only once (`422`), 60-minute anti-collision for student and teacher
 * (`409`). The reason is kept on the communication tab; the quad group gets the new date. A failed WhatsApp
 * post never rolls back the change (`whatsappDispatched: false`).
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const auth = await requireAuth(INTAKE_RECORDER_ROLES);
  if (auth.error) return auth.error;
  const { id, meetingId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "גוף הבקשה אינו JSON תקין" }, { status: 400 });
  }
  const now = new Date();
  const parsed = parseRescheduleInput(body, now);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.errors.join(" · ") }, { status: 400 });
  }
  const { newScheduledAt, reason } = parsed.data;

  try {
    const lookup = await loadStaffLesson(auth.user, id, meetingId);
    if (!lookup.ok) return lookup.response;
    const { lesson, groupId, authorRole } = lookup;

    if (lesson.status !== "SCHEDULED") return notScheduledResponse(lesson.status);
    const previousAt = lesson.startTime ?? lesson.scheduledAt;
    const block = rescheduleBlock({ scheduledAt: previousAt, rescheduledCount: lesson.rescheduledCount }, now);
    if (block) {
      return NextResponse.json({ success: false, error: RESCHEDULE_BLOCK_LABELS[block] }, { status: 422 });
    }
    if (newScheduledAt.getTime() === previousAt.getTime()) {
      return NextResponse.json({ success: false, error: "המועד החדש זהה למועד הנוכחי" }, { status: 400 });
    }

    const durationMinutes = lesson.durationMinutes ?? 60;
    const subject = subjectOf(lesson);
    const content = [
      `מועד השיעור ${subject} שונה`,
      `ממועד: ${formatQuadLessonDate(previousAt, durationMinutes)}`,
      `למועד: ${formatQuadLessonDate(newScheduledAt, durationMinutes)}`,
      ...(reason ? [`סיבה: ${reason}`] : []),
    ].join("\n");

    try {
      await prisma.$transaction(async (tx) => {
        const conflict = await findLessonConflict(tx, {
          studentId: id,
          teacherId: lesson.teacherId,
          at: newScheduledAt,
          excludeLessonId: lesson.id,
        });
        if (conflict) throw new LifecycleConflictError(conflict);
        const moved = await tx.lesson.updateMany({
          where: { id: lesson.id, status: "SCHEDULED", rescheduledCount: lesson.rescheduledCount },
          data: {
            scheduledAt: newScheduledAt,
            startTime: null,
            endTime: null,
            reminderSent: false,
            dailyRoomUrl: null,
            rescheduledCount: { increment: 1 },
          },
        });
        if (moved.count !== 1) throw new LifecycleConflictError(null);
        await releaseTeacherSlot(tx, lesson.teacherId, previousAt);
        await bookTeacherSlot(tx, lesson.teacherId, newScheduledAt);
        await tx.studentCommunicationLog.create({
          data: {
            studentId: id,
            authorId: auth.user.id,
            authorName: auth.user.name,
            authorRole,
            type: "GENERAL",
            courseContext: subject,
            content,
            structuredData: {
              source: "LESSON_RESCHEDULED",
              lessonId: lesson.id,
              from: previousAt.toISOString(),
              to: newScheduledAt.toISOString(),
              reason,
            } satisfies Prisma.InputJsonValue,
          },
        });
      });
    } catch (txError: unknown) {
      if (txError instanceof LifecycleConflictError) return conflictResponse(txError);
      throw txError;
    }

    await teardownDailyRoom(lesson.id, lesson.dailyRoomUrl);

    const change: QuadLessonChangeInput = { subject, scheduledAt: newScheduledAt, durationMinutes };
    const whatsappDispatched = await postToGroup(groupId, lesson.id, (group) =>
      sendQuadGroupLessonRescheduled(group, change)
    );

    await writeAuditLog({
      actorId: auth.user.id,
      action: "LESSON_RESCHEDULED_BY_STAFF",
      entityType: "Lesson",
      entityId: lesson.id,
      metadata: {
        studentId: id,
        from: previousAt.toISOString(),
        to: newScheduledAt.toISOString(),
        reason,
        whatsappDispatched,
      },
    });

    const data: RescheduleResult = {
      lessonId: lesson.id,
      scheduledAt: newScheduledAt.toISOString(),
      previousScheduledAt: previousAt.toISOString(),
    };
    return NextResponse.json({ success: true, data, whatsappDispatched });
  } catch (error: unknown) {
    console.error("Staff lesson reschedule error:", error);
    return NextResponse.json({ success: false, error: "שינוי המועד נכשל" }, { status: 500 });
  }
}

/**
 * Cancels a scheduled lesson (REPRESENTATIVE / ADMIN / MANAGER): status CANCELLED, the teacher's slot is
 * freed and the reason is kept on the communication tab. `restoreCredit: true` returns one lesson credit only
 * when the student is on the direct package track. The quad group is told about the cancellation (the reason
 * stays internal); a failed post never rolls back the cancellation.
 */
export async function DELETE(request: Request, { params }: RouteContext) {
  const auth = await requireAuth(INTAKE_RECORDER_ROLES);
  if (auth.error) return auth.error;
  const { id, meetingId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "גוף הבקשה אינו JSON תקין" }, { status: 400 });
  }
  const parsed = parseCancelInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.errors.join(" · ") }, { status: 400 });
  }
  const { cancellationReason, restoreCredit } = parsed.data;

  try {
    const lookup = await loadStaffLesson(auth.user, id, meetingId);
    if (!lookup.ok) return lookup.response;
    const { lesson, groupId, authorRole } = lookup;
    if (lesson.status !== "SCHEDULED") return notScheduledResponse(lesson.status);

    const creditEligible = restoreCredit && (await studentHasDirectPackage(id));
    const startsAt = lesson.startTime ?? lesson.scheduledAt;
    const durationMinutes = lesson.durationMinutes ?? 60;
    const subject = subjectOf(lesson);
    const content = [
      `השיעור ${subject} בוטל`,
      `מועד: ${formatQuadLessonDate(startsAt, durationMinutes)}`,
      `סיבה: ${cancellationReason}`,
      ...(creditEligible ? ["הוחזר שיעור אחד ליתרה"] : []),
    ].join("\n");

    let lessonCredits: number | null = null;
    try {
      lessonCredits = await prisma.$transaction(async (tx) => {
        const cancelled = await tx.lesson.updateMany({
          where: { id: lesson.id, status: "SCHEDULED" },
          data: {
            status: "CANCELLED",
            canceledAt: new Date(),
            canceledById: auth.user.id,
            appealStatus: "NONE",
            dailyRoomUrl: null,
          },
        });
        if (cancelled.count !== 1) throw new LifecycleConflictError(null);
        await releaseTeacherSlot(tx, lesson.teacherId, startsAt);
        let balance: number | null = null;
        if (creditEligible) {
          const updated = await tx.user.update({
            where: { id },
            data: { lessonCredits: { increment: 1 } },
            select: { lessonCredits: true },
          });
          balance = updated.lessonCredits;
        }
        await tx.studentCommunicationLog.create({
          data: {
            studentId: id,
            authorId: auth.user.id,
            authorName: auth.user.name,
            authorRole,
            type: "GENERAL",
            courseContext: subject,
            content,
            structuredData: {
              source: "LESSON_CANCELLED",
              lessonId: lesson.id,
              scheduledAt: startsAt.toISOString(),
              reason: cancellationReason,
              creditRestored: creditEligible,
            } satisfies Prisma.InputJsonValue,
          },
        });
        return balance;
      });
    } catch (txError: unknown) {
      if (txError instanceof LifecycleConflictError) return conflictResponse(txError);
      throw txError;
    }

    await teardownDailyRoom(lesson.id, lesson.dailyRoomUrl);

    const change: QuadLessonChangeInput = { subject, scheduledAt: startsAt, durationMinutes };
    const whatsappDispatched = await postToGroup(groupId, lesson.id, (group) =>
      sendQuadGroupLessonCancelled(group, change)
    );

    await writeAuditLog({
      actorId: auth.user.id,
      action: "LESSON_CANCELLED_BY_STAFF",
      entityType: "Lesson",
      entityId: lesson.id,
      metadata: {
        studentId: id,
        scheduledAt: startsAt.toISOString(),
        cancellationReason,
        restoreCreditRequested: restoreCredit,
        creditRestored: creditEligible,
        lessonCredits,
        whatsappDispatched,
      },
    });

    const data: CancelResult = { lessonId: lesson.id, status: "CANCELLED", creditRestored: creditEligible, lessonCredits };
    return NextResponse.json({ success: true, data, whatsappDispatched });
  } catch (error: unknown) {
    console.error("Staff lesson cancel error:", error);
    return NextResponse.json({ success: false, error: "ביטול השיעור נכשל" }, { status: 500 });
  }
}
