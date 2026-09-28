import { NextResponse } from "next/server";
import { Prisma, LedgerEntryType } from "@prisma/client";
import { prisma } from "../../../../../lib/prisma";
import { requireAuth } from "../../../../../lib/api-auth";
import { writeAuditLog } from "../../../../../lib/audit";
import { sendLessonCancellationNotification } from "../../../../../lib/whatsapp";
import { deleteDailyRoom, dailyRoomNameForLesson, roomNameFromDailyUrl } from "../../../../../lib/daily";

// ─── Business constants (ILS) ───
/** Monetary value of a single lesson credit (mirrors app/api/payments SINGLE = 200 ILS). */
const LESSON_VALUE_ILS = 200;
/** Teacher share paid out when a student cancels late (50% of lesson value). */
const TEACHER_LATE_CANCEL_SHARE_ILS = LESSON_VALUE_ILS / 2; // 90
/** Invalidated-teacher penalty when cancelling < 24h (15% of lesson value). */
const TEACHER_CANCEL_PENALTY_ILS = Math.round(LESSON_VALUE_ILS * 0.15); // 27

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

type CancelContext = {
  lessonId: string;
  originalTeacherId: string;
  substituteTeacherId: string | null;
  status: string;
  outcome: string;
  extra: string[];
  canceledBy: string;
};

type PrismaTx = Prisma.TransactionClient;

function errorWithStatus(message: string, status: number, code: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Resolve which `TeacherAvailability` row backs a lesson so its booking can be
 * released (or re-locked) atomically. We match on the stored teacher + start
 * time, which is unique per teacher (the overlap check in availability
 * guarantees a teacher never owns two slots with the same start time).
 */
async function findLessonSlot(tx: PrismaTx, teacherId: string, scheduledAt: Date) {
  return tx.teacherAvailability.findFirst({
    where: { teacherId, startTime: scheduledAt },
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

async function writeCancellationAudit(
  record: Parameters<typeof writeAuditLog>[0]
): Promise<void> {
  try {
    await writeAuditLog(record);
  } catch {
    // Non-blocking.
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id: lessonId } = await ctx.params;

    const auth = await requireAuth(["STUDENT", "TEACHER", "MANAGER", "ADMIN"]);
    if (auth.error) return auth.error;

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { student: true, teacher: true },
    });

    if (!lesson) {
      return NextResponse.json({ error: "השיעור לא נמצא" }, { status: 404 });
    }

    const isPrivileged = auth.user.role === "MANAGER" || auth.user.role === "ADMIN";
    const isLessonTeacher = auth.user.role === "TEACHER" && lesson.teacherId === auth.user.id;
    const isLessonStudent = auth.user.role === "STUDENT" && lesson.studentId === auth.user.id;

    if (!isPrivileged && !isLessonTeacher && !isLessonStudent) {
      return NextResponse.json({ error: "אין לך הרשאה לבטל שיעור זה" }, { status: 403 });
    }

    // Terminated lessons can't be cancelled.
    if (lesson.status === "COMPLETED" || lesson.status === "IN_PROGRESS") {
      return NextResponse.json(
        { error: `לא ניתן לבטל שיעור במצב ${lesson.status}` },
        { status: 409 }
      );
    }

    // Already cancelled — idempotent success.
    if (lesson.status === "CANCELLED" || lesson.status === "CANCELLED_LATE") {
      return NextResponse.json({
        success: true,
        alreadyCancelled: true,
        status: lesson.status,
        lesson: { id: lesson.id, status: lesson.status },
      });
    }

    const isTeacherActing = auth.user.role === "TEACHER" && lesson.teacherId === auth.user.id;
    const isStudentActing = auth.user.role === "STUDENT" && lesson.studentId === auth.user.id;

    const initiator = auth.user.role;
    const timeUntilLesson = lesson.scheduledAt.getTime() - Date.now();
    const isWithin24h = timeUntilLesson < TWENTY_FOUR_HOURS_MS;

    const result = await prisma.$transaction(async (tx): Promise<CancelContext> => {
      const lock = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Lesson" WHERE id = ${lessonId} FOR UPDATE`;
      if (lock.length === 0) {
        throw errorWithStatus("השיעור לא נמצא", 404, "LESSON_NOT_FOUND");
      }

      const baseUpdate = {
        status: "CANCELLED" as string,
        canceledAt: new Date(nowIso()),
        canceledById: auth.user.id,
        appealStatus: "NONE",
      };

      const lessonEnd = new Date(lesson.scheduledAt.getTime() + (lesson.durationMinutes ?? 60) * 60 * 1000);
      const originalSlot = await findLessonSlot(tx, lesson.teacherId, lesson.scheduledAt);

      if (isTeacherActing && isWithin24h) {
        // Record the teacher penalty (immutable ledger → automatic, appeal-able later).
        await tx.billingLedger.create({
          data: {
            userId: lesson.teacherId,
            entryType: LedgerEntryType.PENALTY,
            amount: TEACHER_CANCEL_PENALTY_ILS,
            currency: "ILS",
            description: `קנס ביטול מאוחר (מתחת ל-24 שעות) בשיעור ${lesson.id}`,
            relatedId: lesson.id,
            metadata: { canceledAt: nowIso(), canceledById: auth.user.id },
          },
        });

        // Try to find a substitute teacher with an identical free slot.
        const matches = await tx.teacherAvailability.findMany({
          where: {
            teacherId: { not: lesson.teacherId },
            isBooked: false,
            startTime: lesson.scheduledAt,
            endTime: lessonEnd,
            teacher: { role: "TEACHER", isApproved: true },
          },
          select: { id: true, teacherId: true },
          orderBy: { teacherId: "asc" },
        });

        const substitute = matches[0] ?? null;

        if (substitute) {
          // Release old slot, lock the substitute's slot, keep the lesson going.
          if (originalSlot) {
            await tx.teacherAvailability.update({
              where: { id: originalSlot.id },
              data: { isBooked: false },
            });
          }
          await tx.teacherAvailability.update({
            where: { id: substitute.id },
            data: { isBooked: true },
          });

          await tx.lesson.update({
            where: { id: lessonId },
            data: {
              teacherId: substitute.teacherId,
              originalTeacherId: lesson.teacherId,
              substituteTeacherId: substitute.teacherId,
              status: "SCHEDULED",
              canceledAt: null,
              canceledById: null,
              appealStatus: "NONE",
            },
          });

          return {
            lessonId,
            originalTeacherId: lesson.teacherId,
            substituteTeacherId: substitute.teacherId,
            status: "SCHEDULED",
            outcome: "הוחלף במורה חלוף",
            extra: [],
            canceledBy: auth.user.id,
          };
        }

        // No substitute → cancel + ₪360 student credit (REFUND 180 + PLATFORM_COMPENSATION 180).
        await tx.lesson.update({ where: { id: lessonId }, data: baseUpdate });
        if (originalSlot) {
          await tx.teacherAvailability.update({
            where: { id: originalSlot.id },
            data: { isBooked: false },
          });
        }
        await tx.user.update({
          where: { id: lesson.studentId },
          data: { lessonCredits: { increment: 2 } },
        });
        // ₪180 lesson credit refund
        await tx.billingLedger.create({
          data: {
            userId: lesson.studentId,
            entryType: LedgerEntryType.REFUND,
            amount: LESSON_VALUE_ILS,
            currency: "ILS",
            description: `החזר קרדיט שיעור בגין ביטול מאוחר של מורה בשיעור ${lesson.id}`,
            relatedId: lesson.id,
            transactionId: `late-teacher-refund-${lesson.id}`,
            metadata: {
              canceledAt: nowIso(),
              canceledById: auth.user.id,
              type: "SUBSTITUTE_NOT_FOUND",
            },
          },
        });
        // ₪180 platform compensation for late teacher cancel → total ₪360 credit
        await tx.billingLedger.create({
          data: {
            userId: lesson.studentId,
            entryType: LedgerEntryType.PLATFORM_COMPENSATION,
            amount: LESSON_VALUE_ILS,
            currency: "ILS",
            description: `פיצוי פלטפורמה בגין ביטול מאוחר של מורה בשיעור ${lesson.id}`,
            relatedId: lesson.id,
            transactionId: `late-teacher-compensation-${lesson.id}`,
            metadata: {
              canceledAt: nowIso(),
              canceledById: auth.user.id,
              type: "SUBSTITUTE_NOT_FOUND",
            },
          },
        });

        return {
          lessonId,
          originalTeacherId: lesson.teacherId,
          substituteTeacherId: null,
          status: "CANCELLED",
          outcome: "בוטל",
          extra: ["לא נמצא מורה חלוף. זוכית ב־₪360 (החזר + פיצוי) — 2 קרדיטים."],
          canceledBy: auth.user.id,
        };
      }

      if (isStudentActing && isWithin24h) {
        // Late student cancellation — no credit refund; teacher gets a 50% payout.
        await tx.lesson.update({
          where: { id: lessonId },
          data: { ...baseUpdate, status: "CANCELLED_LATE" },
        });
        if (originalSlot) {
          await tx.teacherAvailability.update({
            where: { id: originalSlot.id },
            data: { isBooked: false },
          });
        }
        const payoutPeriodStart = new Date(nowIso());
        const payoutPeriodEnd = new Date(nowIso());
        await tx.teacherPayout.create({
          data: {
            teacherId: lesson.teacherId,
            amount: TEACHER_LATE_CANCEL_SHARE_ILS,
            currency: "ILS",
            status: "SCHEDULED",
            periodStart: payoutPeriodStart,
            periodEnd: payoutPeriodEnd,
            idempotencyKey: `late-cancel-${lessonId}`,
            lessonId,
            metadata: { type: "STUDENT_LATE_CANCEL", canceledAt: nowIso(), canceledById: auth.user.id },
          },
        });
        await tx.billingLedger.create({
          data: {
            userId: lesson.teacherId,
            entryType: LedgerEntryType.PAYOUT,
            amount: TEACHER_LATE_CANCEL_SHARE_ILS,
            currency: "ILS",
            description: `זיכוי 50% בגין ביטול מאוחר של תלמיד בשיעור ${lesson.id}`,
            relatedId: lessonId,
            metadata: { type: "STUDENT_LATE_CANCEL", canceledAt: nowIso(), canceledById: auth.user.id },
          },
        });

        return {
          lessonId,
          originalTeacherId: lesson.teacherId,
          substituteTeacherId: null,
          status: "CANCELLED_LATE",
          outcome: "בוטל באיחור",
          extra: ["התלמיד לא יקבל קרדיט בחזרה."],
          canceledBy: auth.user.id,
        };
      }

      // Early cancellation (≥24h) by either party — credit refund, slot released.
      await tx.lesson.update({ where: { id: lessonId }, data: baseUpdate });
      if (originalSlot) {
        await tx.teacherAvailability.update({
          where: { id: originalSlot.id },
          data: { isBooked: false },
        });
      }
      await tx.user.update({
        where: { id: lesson.studentId },
        data: { lessonCredits: { increment: 1 } },
      });
      await tx.billingLedger.create({
        data: {
          userId: lesson.studentId,
          entryType: LedgerEntryType.REFUND,
          amount: LESSON_VALUE_ILS,
          currency: "ILS",
          description: `החזר קרדיט בגין ביטול מעל 24 שעות בשיעור ${lesson.id}`,
          relatedId: lessonId,
          metadata: { canceledAt: nowIso(), canceledById: auth.user.id, initiator },
        },
      });

      return {
        lessonId,
        originalTeacherId: lesson.teacherId,
        substituteTeacherId: null,
        status: "CANCELLED",
        outcome: "בוטל",
        extra: [],
        canceledBy: auth.user.id,
      };
    });

    // Tear down the Daily video room async (best-effort; never blocks the success response).
    if (lesson.dailyRoomUrl) {
      void (async () => {
        try {
          await deleteDailyRoom(roomNameFromDailyUrl(lesson.dailyRoomUrl!) ?? dailyRoomNameForLesson(lessonId));
        } catch (roomError) {
          console.error(`Failed to delete Daily room for cancelled lesson ${lessonId}:`, roomError);
        }
      })();
    }

    const subject = lesson.title?.trim() || "שיעור פרטי";

    // Notify affected parties (fire-and-forget, never blocks the transaction response).
    void (async () => {
      const notifyStudent = sendLessonCancellationNotification({
        phone: lesson.student.phone,
        recipientName: lesson.student.name,
        lessonId,
        subject,
        scheduledAt: lesson.scheduledAt,
        outcome: result.outcome,
        extra: (result.extra ?? []).join("\n"),
      });

      const notifyTeacher = sendLessonCancellationNotification({
        phone: lesson.teacher.phone,
        recipientName: lesson.teacher.name,
        lessonId,
        subject,
        scheduledAt: lesson.scheduledAt,
        outcome: result.outcome,
        extra: (result.extra ?? []).join("\n"),
      });

      const outcomes = await Promise.allSettled([notifyStudent, notifyTeacher]);
      const failed = outcomes.filter((o) => o.status === "rejected").length;

      await writeCancellationAudit({
        actorId: auth.user.id,
        action: "LESSON_CANCEL",
        entityType: "Lesson",
        entityId: lessonId,
        metadata: { status: result.status, initiator, failedNotifications: failed },
      });
    })().catch((err) => console.error("Cancellation notification dispatch failed:", err));

    return NextResponse.json({
      success: true,
      ...(result.substituteTeacherId ? { substituteTeacherId: result.substituteTeacherId } : {}),
      status: result.status,
      message: "פעולת הביטול בוצעה בהצלחה.",
    });
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      console.error("Lesson Cancel DB Error:", error);
      return NextResponse.json({ error: "שגיאה פנימית בעת ביטול השיעור" }, { status: 500 });
    }
    if (error instanceof Error && "status" in error) {
      const e = error as unknown as { status?: unknown; code?: unknown; message?: unknown };
      const status = e.status;
      const code = e.code;
      const message = e.message;
      return NextResponse.json(
        { error: typeof message === "string" ? message : "שגיאה בביטול השיעור", code },
        { status: typeof status === "number" ? status : 500 }
      );
    }
    console.error("Lesson Cancel Error:", error);
    return NextResponse.json({ error: "שגיאה פנימית בביטול השיעור" }, { status: 500 });
  }
}