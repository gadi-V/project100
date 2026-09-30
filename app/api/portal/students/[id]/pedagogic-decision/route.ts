import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../../../lib/prisma";
import { requireAuth } from "../../../../../../lib/api-auth";
import { writeAuditLog } from "../../../../../../lib/audit";
import { ENROLLMENT_DECISION_ROLES } from "../../../../../../lib/auth/staff-roles";
import { toCommunicationAuthorRole } from "../../../../../../lib/communication-templates";
import { lessonAntiCollisionWindow } from "../../../../../../lib/scheduling";
import {
  loadPedagogicOverview,
  markStudentActive,
  resolveStudentAccess,
} from "../../../../../../lib/student-portal";
import { formatIsraelDateTime } from "../../../../../../lib/student-portal-shared";
import {
  buildDecisionStructuredData,
  buildRecurringOccurrences,
  formatWeeklySchedule,
  parsePedagogicDecisionInput,
  PENDING_SCHEDULE_STATUS,
  renderDecisionContent,
  SUBSCRIPTION_LESSON_MINUTES,
  SUBSCRIPTION_TYPE_LABELS,
  type PedagogicDecisionResult,
} from "../../../../../../lib/pedagogic-decision";
import { sendQuadGroupPedagogicDecision } from "../../../../../../lib/whatsapp";

type RouteContext = { params: Promise<{ id: string }> };

const ACCESS_ERRORS = { 403: "אין לך גישה לתלמיד הזה", 404: "התלמיד לא נמצא" } as const;

class SlotConflictError extends Error {
  constructor(
    readonly party: "STUDENT" | "TEACHER",
    readonly at: Date
  ) {
    super("SLOT_CONFLICT");
  }
}

function conflictMessage(conflict: SlotConflictError): string {
  const when = formatIsraelDateTime(conflict.at.toISOString());
  return conflict.party === "STUDENT"
    ? `לתלמיד כבר יש מפגש סמוך ל-${when}`
    : `המורה כבר משובץ למפגש סמוך ל-${when}`;
}

/** 360° overview (intake call, questionnaires, mapping summary) + active teachers for the decision modal. */
export async function GET(_request: Request, { params }: RouteContext) {
  const auth = await requireAuth(ENROLLMENT_DECISION_ROLES);
  if (auth.error) return auth.error;
  const { id } = await params;

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) {
      return NextResponse.json({ success: false, error: ACCESS_ERRORS[access.status] }, { status: access.status });
    }
    const overview = await loadPedagogicOverview(id);
    if (!overview) {
      return NextResponse.json({ success: false, error: ACCESS_ERRORS[404] }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: overview }, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    console.error("Pedagogic overview error:", error);
    return NextResponse.json({ success: false, error: "טעינת תמונת המצב נכשלה" }, { status: 500 });
  }
}

/**
 * Records the pedagogic manager's post-mapping decision ("סיכום שיחה לאחר מיפוי") and starts the
 * subscription in one transaction: the summary log, the next four weeks of lessons (4 weekly / 8 twice
 * weekly, SCHEDULED, anti-collision checked), extra private lessons as PENDING_SCHEDULE, and the
 * active "תלמיד" status. The learning plan is then posted to the quad WhatsApp group; a failed post
 * never rolls back the decision and is reported as `whatsappDispatched: false`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await requireAuth(ENROLLMENT_DECISION_ROLES);
  if (auth.error) return auth.error;
  const { id } = await params;

  const authorRole = toCommunicationAuthorRole(auth.user.role);
  if (!authorRole) {
    return NextResponse.json({ success: false, error: "אין לך הרשאה לפעולה זו" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "גוף הבקשה אינו JSON תקין" }, { status: 400 });
  }
  const now = new Date();
  const parsed = parsePedagogicDecisionInput(body, now);
  if (!parsed.ok) {
    return NextResponse.json(
      { success: false, error: `ההכרעה לא נשמרה: ${parsed.errors.join(" · ")}` },
      { status: 400 }
    );
  }
  const input = parsed.data;

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) {
      return NextResponse.json({ success: false, error: ACCESS_ERRORS[access.status] }, { status: access.status });
    }

    const [student, teacher] = await Promise.all([
      prisma.user.findUnique({ where: { id }, select: { id: true, name: true, whatsappGroupId: true } }),
      prisma.user.findUnique({
        where: { id: input.teacherId },
        select: { id: true, name: true, role: true, isApproved: true },
      }),
    ]);
    if (!student) {
      return NextResponse.json({ success: false, error: ACCESS_ERRORS[404] }, { status: 404 });
    }
    if (!teacher || teacher.role !== "TEACHER" || !teacher.isApproved) {
      return NextResponse.json({ success: false, error: "המורה לא נמצא או שאינו פעיל" }, { status: 404 });
    }

    const occurrences = buildRecurringOccurrences(input.slots, input.startDate);
    const groupId = student.whatsappGroupId?.trim() || null;
    const structuredData = buildDecisionStructuredData(input, teacher.name, occurrences.length);
    const content = renderDecisionContent(structuredData);

    const lessonRows: Prisma.LessonCreateManyInput[] = [
      ...occurrences.map((scheduledAt) => ({
        studentId: id,
        teacherId: teacher.id,
        title: input.subject,
        scheduledAt,
        durationMinutes: SUBSCRIPTION_LESSON_MINUTES,
        status: "SCHEDULED",
        lessonType: "REGULAR",
        whatsappGroupId: groupId,
      })),
      ...Array.from({ length: input.extraPrivateLessons }, () => ({
        studentId: id,
        teacherId: teacher.id,
        title: `${input.subject} · שיעור פרטי`,
        scheduledAt: occurrences[0],
        durationMinutes: SUBSCRIPTION_LESSON_MINUTES,
        status: PENDING_SCHEDULE_STATUS,
        lessonType: "REGULAR",
        whatsappGroupId: groupId,
      })),
    ];

    const windows = occurrences.map((at) => {
      const { windowStart, windowEnd } = lessonAntiCollisionWindow(at);
      return { scheduledAt: { gt: windowStart, lt: windowEnd } };
    });
    const activeInWindows = { status: { in: ["SCHEDULED", "IN_PROGRESS"] }, OR: windows };

    let saved: { logId: string; studentStatus: string[] };
    try {
      saved = await prisma.$transaction(async (tx) => {
        const [studentOverlap, teacherOverlap] = await Promise.all([
          tx.lesson.findFirst({ where: { studentId: id, ...activeInWindows }, select: { scheduledAt: true } }),
          tx.lesson.findFirst({
            where: { teacherId: teacher.id, ...activeInWindows },
            select: { scheduledAt: true },
          }),
        ]);
        if (studentOverlap) throw new SlotConflictError("STUDENT", studentOverlap.scheduledAt);
        if (teacherOverlap) throw new SlotConflictError("TEACHER", teacherOverlap.scheduledAt);

        const log = await tx.studentCommunicationLog.create({
          data: {
            studentId: id,
            authorId: auth.user.id,
            authorName: auth.user.name,
            authorRole,
            type: "POST_MAPPING_CALL",
            courseContext: input.subject,
            content,
            structuredData: structuredData as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        await tx.lesson.createMany({ data: lessonRows });
        const studentStatus = await markStudentActive(tx, id, auth.user.id, now);
        return { logId: log.id, studentStatus };
      });
    } catch (txError: unknown) {
      if (txError instanceof SlotConflictError) {
        return NextResponse.json({ success: false, error: conflictMessage(txError) }, { status: 409 });
      }
      throw txError;
    }

    let whatsappDispatched = false;
    if (groupId) {
      try {
        const sent = await sendQuadGroupPedagogicDecision(groupId, {
          subscriptionLabel: SUBSCRIPTION_TYPE_LABELS[input.subscriptionType],
          teacherName: teacher.name,
          scheduleLabel: formatWeeklySchedule(input.slots),
        });
        whatsappDispatched = sent.sent;
        if (!sent.sent) console.error(`[pedagogic-decision] group post for ${id} not sent: ${sent.error}`);
      } catch (whatsappError: unknown) {
        console.error(`[pedagogic-decision] group post for ${id} failed:`, whatsappError);
      }
    }

    await writeAuditLog({
      actorId: auth.user.id,
      action: "PEDAGOGIC_DECISION_RECORDED",
      entityType: "StudentCommunicationLog",
      entityId: saved.logId,
      metadata: {
        studentId: id,
        teacherId: teacher.id,
        subscriptionType: input.subscriptionType,
        slots: input.slots,
        startDate: input.startDate,
        lessonsCreated: occurrences.length,
        pendingPrivateLessons: input.extraPrivateLessons,
        studentStatus: saved.studentStatus,
        whatsappDispatched,
      },
    });

    const data: PedagogicDecisionResult = {
      logId: saved.logId,
      subscriptionType: input.subscriptionType,
      teacherName: teacher.name,
      lessonsCreated: occurrences.length,
      pendingPrivateLessons: input.extraPrivateLessons,
      firstLessonAt: occurrences[0].toISOString(),
      studentStatus: saved.studentStatus,
    };
    return NextResponse.json({ success: true, data, whatsappDispatched }, { status: 201 });
  } catch (error: unknown) {
    console.error("Pedagogic decision error:", error);
    return NextResponse.json({ success: false, error: "שמירת ההכרעה נכשלה" }, { status: 500 });
  }
}
