import { NextResponse } from "next/server";
import { LedgerEntryType, Prisma } from "@prisma/client";
import { prisma } from "../../../../lib/prisma";
import { requireAuth } from "../../../../lib/api-auth";
import { writeAuditLog } from "../../../../lib/audit";

const LESSON_VALUE_ILS = 200;

/**
 * List lessons with PENDING fine appeals.
 */
export async function GET() {
  try {
    const auth = await requireAuth(["ADMIN", "MANAGER"]);
    if (auth.error) return auth.error;

    const appeals = await prisma.lesson.findMany({
      where: { appealStatus: "PENDING" },
      orderBy: { canceledAt: "asc" },
      select: {
        id: true,
        title: true,
        scheduledAt: true,
        status: true,
        appealStatus: true,
        canceledAt: true,
        canceledById: true,
        teacherId: true,
        studentId: true,
        teacher: { select: { id: true, name: true, phone: true } },
        student: { select: { id: true, name: true, phone: true } },
      },
    });

    return NextResponse.json({
      appeals: appeals.map((a) => ({
        ...a,
        scheduledAt: a.scheduledAt.toISOString(),
        canceledAt: a.canceledAt?.toISOString() ?? null,
      })),
    });
  } catch (error: unknown) {
    console.error("Admin appeals GET error:", error);
    return NextResponse.json({ error: "שגיאה בשליפת ערעורים" }, { status: 500 });
  }
}

type AppealActionBody = {
  lessonId?: unknown;
  action?: unknown;
};

/**
 * Resolve a pending appeal.
 * Approve → credit student (ensure ₪360 ledger) + waive teacher PENALTY.
 * Reject → keep teacher PENALTY in force.
 * Body: { lessonId: string, action: "APPROVE" | "REJECT" }
 */
export async function POST(request: Request) {
  try {
    const auth = await requireAuth(["ADMIN", "MANAGER"]);
    if (auth.error) return auth.error;

    const body = (await request.json()) as AppealActionBody;

    if (typeof body.lessonId !== "string" || !body.lessonId.trim()) {
      return NextResponse.json({ error: "lessonId הוא שדה חובה" }, { status: 400 });
    }

    const action =
      body.action === "APPROVE" || body.action === "REJECT" ? body.action : null;
    if (!action) {
      return NextResponse.json(
        { error: "action חייב להיות APPROVE או REJECT" },
        { status: 400 }
      );
    }

    const lessonId = body.lessonId.trim();

    const result = await prisma.$transaction(async (tx) => {
      const lesson = await tx.lesson.findUnique({
        where: { id: lessonId },
        select: {
          id: true,
          teacherId: true,
          studentId: true,
          appealStatus: true,
          status: true,
        },
      });

      if (!lesson) {
        throw Object.assign(new Error("השיעור לא נמצא"), { status: 404 });
      }

      if (lesson.appealStatus !== "PENDING") {
        throw Object.assign(new Error("אין ערעור ממתין לשיעור זה"), { status: 409 });
      }

      if (action === "REJECT") {
        await tx.lesson.update({
          where: { id: lessonId },
          data: { appealStatus: "REJECTED" },
        });
        return { appealStatus: "REJECTED" as const };
      }

      // APPROVE: waive teacher penalty + ensure student is credited
      await tx.lesson.update({
        where: { id: lessonId },
        data: { appealStatus: "APPROVED" },
      });

      const penalty = await tx.billingLedger.findFirst({
        where: {
          relatedId: lessonId,
          userId: lesson.teacherId,
          entryType: LedgerEntryType.PENALTY,
        },
      });

      if (penalty) {
        const alreadyWaived = await tx.billingLedger.findFirst({
          where: {
            transactionId: `appeal-waive-${lessonId}`,
          },
        });
        if (!alreadyWaived) {
          await tx.billingLedger.create({
            data: {
              userId: lesson.teacherId,
              entryType: LedgerEntryType.ADJUSTMENT,
              amount: penalty.amount,
              currency: "ILS",
              description: `ביטול קנס לאחר אישור ערעור לשיעור ${lessonId}`,
              relatedId: lessonId,
              transactionId: `appeal-waive-${lessonId}`,
              metadata: {
                waivedPenaltyId: penalty.id,
                approvedById: auth.user.id,
              },
            },
          });
        }
      }

      // Ensure student received REFUND + PLATFORM_COMPENSATION (₪360 total)
      const studentEntries = await tx.billingLedger.findMany({
        where: {
          relatedId: lessonId,
          userId: lesson.studentId,
          entryType: {
            in: [
              LedgerEntryType.REFUND,
              LedgerEntryType.PLATFORM_COMPENSATION,
              LedgerEntryType.COMPENSATION,
            ],
          },
        },
      });

      const creditedTotal = studentEntries.reduce(
        (sum, e) => sum + Number(e.amount),
        0
      );

      if (creditedTotal < LESSON_VALUE_ILS * 2) {
        const hasRefund = studentEntries.some(
          (e) => e.entryType === LedgerEntryType.REFUND
        );
        const hasCompensation = studentEntries.some(
          (e) =>
            e.entryType === LedgerEntryType.PLATFORM_COMPENSATION ||
            e.entryType === LedgerEntryType.COMPENSATION
        );

        const creditsToAdd =
          (!hasRefund ? 1 : 0) + (!hasCompensation ? 1 : 0);

        if (!hasRefund) {
          await tx.billingLedger.create({
            data: {
              userId: lesson.studentId,
              entryType: LedgerEntryType.REFUND,
              amount: LESSON_VALUE_ILS,
              currency: "ILS",
              description: `החזר קרדיט לאחר אישור ערעור בשיעור ${lessonId}`,
              relatedId: lessonId,
              transactionId: `appeal-refund-${lessonId}`,
              metadata: { approvedById: auth.user.id },
            },
          });
        }
        if (!hasCompensation) {
          await tx.billingLedger.create({
            data: {
              userId: lesson.studentId,
              entryType: LedgerEntryType.PLATFORM_COMPENSATION,
              amount: LESSON_VALUE_ILS,
              currency: "ILS",
              description: `פיצוי פלטפורמה לאחר אישור ערעור בשיעור ${lessonId}`,
              relatedId: lessonId,
              transactionId: `appeal-compensation-${lessonId}`,
              metadata: { approvedById: auth.user.id },
            },
          });
        }
        if (creditsToAdd > 0) {
          await tx.user.update({
            where: { id: lesson.studentId },
            data: { lessonCredits: { increment: creditsToAdd } },
          });
        }
      }

      return { appealStatus: "APPROVED" as const };
    });

    await writeAuditLog({
      actorId: auth.user.id,
      action: action === "APPROVE" ? "APPEAL_APPROVED" : "APPEAL_REJECTED",
      entityType: "Lesson",
      entityId: lessonId,
      metadata: { action, appealStatus: result.appealStatus },
    });

    return NextResponse.json({
      success: true,
      lessonId,
      appealStatus: result.appealStatus,
    });
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      console.error("Admin appeals DB error:", error);
      return NextResponse.json({ error: "שגיאת מסד נתונים" }, { status: 500 });
    }
    if (error instanceof Error && "status" in error) {
      const status = (error as Error & { status?: number }).status;
      return NextResponse.json(
        { error: error.message },
        { status: typeof status === "number" ? status : 500 }
      );
    }
    console.error("Admin appeals POST error:", error);
    return NextResponse.json({ error: "שגיאה בטיפול בערעור" }, { status: 500 });
  }
}
