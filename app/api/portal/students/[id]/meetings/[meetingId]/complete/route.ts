import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../../../../../lib/prisma";
import { requireAuth } from "../../../../../../../../lib/api-auth";
import { toCommunicationAuthorRole } from "../../../../../../../../lib/communication-templates";
import {
  ATTENDANCE_OUTCOME_LABELS,
  COMPLETABLE_STATUSES,
  creditTakenAtBooking,
  isLessonManagementRole,
  lessonPayoutKey,
  outcomeEffects,
  parseCompleteLessonInput,
  teacherCompensation,
  TEACHER_HOURLY_RATE_ILS,
  type CompleteLessonResponse,
} from "../../../../../../../../lib/lesson-completion";
import { resolveStudentAccess, studentHasDirectPackage } from "../../../../../../../../lib/student-portal";
import { formatQuadLessonDate } from "../../../../../../../../lib/whatsapp";
import { schedulePayoutInTransaction } from "../../../../../../../../lib/services/PayoutService";
import { writeLedgerEntryInTransaction } from "../../../../../../../../lib/services/LedgerService";

type RouteContext = { params: Promise<{ id: string; meetingId: string }> };

const ACCESS_ERRORS = { 403: "אין לך גישה לתלמיד הזה", 404: "התלמיד לא נמצא" } as const;

class CompletionRaceError extends Error {
  constructor() {
    super("COMPLETION_RACE");
  }
}

function fail(error: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error } satisfies CompleteLessonResponse, { status });
}

function closedLessonError(status: string): string {
  if (status === "COMPLETED") return "השיעור כבר סומן כהסתיים";
  if (status === "CANCELLED" || status === "CANCELLED_LATE") return "השיעור כבר בוטל";
  return "אפשר לסיים רק שיעור שנקבע לו מועד";
}

/**
 * Closes a lesson and records attendance: the lesson's teacher, MANAGER (pedagogic manager) or ADMIN, once the
 * start time has arrived. One transaction:
 * - ATTENDED / STUDENT_NO_SHOW: `COMPLETED`, attendance PRESENT / ABSENT, a scheduled `TeacherPayout` at the
 *   teacher's hourly rate (PAYOUT + PLATFORM_FEE ledger rows, same idempotency key as `/api/lessons/complete`),
 *   and one lesson taken from the direct-package balance unless the credit was already taken at booking.
 * - TEACHER_CANCELLED: `CANCELLED`, no payout, and a credit taken at booking goes back to the student.
 * The outcome and internal notes go to the communication tab and AuditLog `LESSON_COMPLETED_ATTENDANCE_RECORDED`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await requireAuth(["TEACHER", "MANAGER", "ADMIN"]);
  if (auth.error) return auth.error;
  const { id, meetingId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("גוף הבקשה אינו JSON תקין", 400);
  }
  const parsed = parseCompleteLessonInput(body);
  if (!parsed.ok) return fail(parsed.errors.join(" · "), 400);
  const { attendanceStatus, internalNotes } = parsed.data;

  try {
    const authorRole = toCommunicationAuthorRole(auth.user.role);
    if (!authorRole) return fail("אין לך הרשאה לפעולה זו", 403);
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) return fail(ACCESS_ERRORS[access.status], access.status);

    const lesson = await prisma.lesson.findUnique({
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
      },
    });
    if (!lesson || lesson.studentId !== id) return fail("השיעור לא נמצא", 404);
    if (!isLessonManagementRole(auth.user.role) && lesson.teacherId !== auth.user.id) {
      return fail("רק המורה של השיעור או ההנהלה יכולים לסיים אותו", 403);
    }
    if (!COMPLETABLE_STATUSES.includes(lesson.status)) return fail(closedLessonError(lesson.status), 409);

    const now = new Date();
    const startsAt = lesson.startTime ?? lesson.scheduledAt;
    if (startsAt > now) return fail("אפשר לסיים שיעור רק אחרי שהתחיל", 409);

    const effects = outcomeEffects(attendanceStatus);
    const prepaid = creditTakenAtBooking(lesson);
    const chargeDirectPackage = effects.consumesCredit && !prepaid && (await studentHasDirectPackage(id));
    const restoreBookingCredit = !effects.consumesCredit && prepaid;
    const durationMinutes = lesson.durationMinutes ?? 60;
    const compensation = effects.compensateTeacher ? teacherCompensation(durationMinutes) : null;
    const subject = lesson.title?.trim() || "שיעור פרטי";
    const payoutKey = lessonPayoutKey(lesson.id);

    let outcome: { payoutId: string | null; creditCharged: boolean; creditRestored: boolean; lessonCredits: number | null };
    try {
      outcome = await prisma.$transaction(async (tx) => {
        const closed = await tx.lesson.updateMany({
          where: { id: lesson.id, status: { in: [...COMPLETABLE_STATUSES] } },
          data: {
            status: effects.status,
            ...(effects.attendance
              ? { attendanceStatus: effects.attendance, attendanceMarkedAt: now, attendanceMarkedById: auth.user.id }
              : {}),
            ...(effects.status === "CANCELLED"
              ? { canceledAt: now, canceledById: auth.user.id, appealStatus: "NONE", dailyRoomUrl: null }
              : {}),
          },
        });
        if (closed.count !== 1) throw new CompletionRaceError();

        let payoutId: string | null = null;
        if (compensation) {
          const payout = await schedulePayoutInTransaction(tx, {
            teacherId: lesson.teacherId,
            amount: compensation.teacherPayout,
            periodStart: startsAt,
            periodEnd: new Date(startsAt.getTime() + durationMinutes * 60_000),
            idempotencyKey: payoutKey,
            lessonId: lesson.id,
            metadata: {
              type: "LESSON_COMPLETION",
              source: "PORTAL_ATTENDANCE",
              attendanceStatus,
              completedAt: now.toISOString(),
              completedById: auth.user.id,
              hourlyRate: TEACHER_HOURLY_RATE_ILS,
              billedHours: compensation.billedHours,
              feeSplit: {
                lessonValue: compensation.lessonValue,
                platformFee: compensation.platformFee,
                tutorPayout: compensation.teacherPayout,
              },
            },
          });
          payoutId = payout.id;
          const feeKey = `${payoutKey}-fee`;
          const feeBooked = await tx.billingLedger.findUnique({ where: { transactionId: feeKey }, select: { id: true } });
          if (!feeBooked) {
            await writeLedgerEntryInTransaction(tx, {
              userId: lesson.teacherId,
              entryType: "PLATFORM_FEE",
              amount: compensation.platformFee,
              description: `עמלת פלטפורמה עבור השיעור ${lesson.id}`,
              relatedId: payout.id,
              transactionId: feeKey,
              metadata: { lessonId: lesson.id, attendanceStatus, completedAt: now.toISOString() },
            });
          }
        }

        let creditCharged = false;
        let creditRestored = false;
        let lessonCredits: number | null = null;
        if (chargeDirectPackage) {
          const charged = await tx.user.updateMany({
            where: { id, lessonCredits: { gt: 0 } },
            data: { lessonCredits: { decrement: 1 } },
          });
          creditCharged = charged.count === 1;
        } else if (restoreBookingCredit) {
          await tx.user.update({ where: { id }, data: { lessonCredits: { increment: 1 } } });
          creditRestored = true;
        }
        if (creditCharged || creditRestored) {
          const balance = await tx.user.findUnique({ where: { id }, select: { lessonCredits: true } });
          lessonCredits = balance?.lessonCredits ?? null;
        }

        const content = [
          `השיעור ${subject} (${formatQuadLessonDate(startsAt, durationMinutes)}): ${ATTENDANCE_OUTCOME_LABELS[attendanceStatus]}`,
          compensation ? `שכר מורה נרשם לתשלום: ${compensation.teacherPayout} ₪` : "המורה לא מתוגמל על שיעור זה",
          ...(creditCharged ? [`ירד שיעור אחד מיתרת החבילה (נותרו ${lessonCredits})`] : []),
          ...(chargeDirectPackage && !creditCharged ? ["יתרת החבילה ריקה, השיעור לא ירד מהיתרה"] : []),
          ...(creditRestored ? [`השיעור הוחזר ליתרת התלמיד (${lessonCredits})`] : []),
          ...(internalNotes ? [`הערות פנימיות: ${internalNotes}`] : []),
        ].join("\n");
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
              source: "LESSON_COMPLETED",
              lessonId: lesson.id,
              attendanceStatus,
              internalNotes,
              teacherCompensated: Boolean(compensation),
              compensationAmount: compensation?.teacherPayout ?? null,
              creditCharged,
              creditRestored,
            } satisfies Prisma.InputJsonValue,
          },
        });

        await tx.auditLog.create({
          data: {
            actorId: auth.user.id,
            action: "LESSON_COMPLETED_ATTENDANCE_RECORDED",
            entityType: "Lesson",
            entityId: lesson.id,
            metadata: {
              studentId: id,
              teacherId: lesson.teacherId,
              attendanceStatus,
              lessonStatus: effects.status,
              internalNotes,
              payoutId,
              compensation: compensation
                ? { ...compensation, hourlyRate: TEACHER_HOURLY_RATE_ILS }
                : null,
              creditTakenAtBooking: prepaid,
              creditCharged,
              creditRestored,
              directPackageBalanceEmpty: chargeDirectPackage && !creditCharged,
              lessonCredits,
            } satisfies Prisma.InputJsonValue,
          },
        });

        return { payoutId, creditCharged, creditRestored, lessonCredits };
      });
    } catch (txError: unknown) {
      if (txError instanceof CompletionRaceError) return fail("השיעור עודכן בינתיים, רעננו ונסו שוב", 409);
      throw txError;
    }

    return NextResponse.json({
      success: true,
      lessonId: lesson.id,
      status: effects.status,
      attendanceStatus,
      teacherCompensated: outcome.payoutId !== null,
      compensationAmount: compensation?.teacherPayout ?? null,
      creditCharged: outcome.creditCharged,
      creditRestored: outcome.creditRestored,
      lessonCredits: outcome.lessonCredits,
      promptSummary: effects.promptSummary,
    } satisfies CompleteLessonResponse);
  } catch (error: unknown) {
    console.error("Lesson completion error:", error);
    return fail("סיום השיעור נכשל", 500);
  }
}
