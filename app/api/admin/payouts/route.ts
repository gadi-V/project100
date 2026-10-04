import { NextResponse } from "next/server";
import { PayoutStatus } from "@prisma/client";
import { prisma } from "../../../../lib/prisma";
import { requireAuth } from "../../../../lib/api-auth";
import { listTeacherBalances, settleTeacherBalance } from "../../../../lib/teacher-payouts";
import {
  parseSettlePayoutInput,
  PAYOUT_ADMIN_ROLES,
  type SettlePayoutResponse,
} from "../../../../lib/teacher-payouts-shared";

const NO_STORE = { "Cache-Control": "no-store" };

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2034";
}

/**
 * ADMIN / MANAGER only.
 * `teachers`: per teacher `earnedAmount` (PAYOUT rows), `penaltyAmount` (PENALTY rows less appeal waivers),
 * `paidAmount` (`payout-paid-` settlements) and `balance` = earned − penalties − paid (never below 0), with the
 * number of completed lessons and bank details. `payouts`: the per-payout queue (SCHEDULED / PROCESSING)
 * still used by the `/admin` payouts tab.
 */
export async function GET() {
  try {
    const auth = await requireAuth(PAYOUT_ADMIN_ROLES);
    if (auth.error) return auth.error;

    const balances = await listTeacherBalances();
    const payouts = await prisma.teacherPayout.findMany({
      where: {
        status: { in: [PayoutStatus.SCHEDULED, PayoutStatus.PROCESSING] },
      },
      orderBy: { createdAt: "asc" },
      include: {
        teacher: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            teacherProfile: {
              select: {
                bankName: true,
                bankBranch: true,
                accountNumber: true,
                accountHolderName: true,
              },
            },
          },
        },
        lesson: {
          select: {
            id: true,
            title: true,
            scheduledAt: true,
          },
        },
      },
    });

    const queue = payouts.map((p) => ({
      id: p.id,
      amount: p.amount.toString(),
      currency: p.currency,
      status: p.status,
      periodStart: p.periodStart.toISOString(),
      periodEnd: p.periodEnd.toISOString(),
      createdAt: p.createdAt.toISOString(),
      lessonId: p.lessonId,
      lesson: p.lesson
        ? {
            id: p.lesson.id,
            title: p.lesson.title,
            scheduledAt: p.lesson.scheduledAt.toISOString(),
          }
        : null,
      teacher: {
        id: p.teacher.id,
        name: p.teacher.name,
        phone: p.teacher.phone,
        email: p.teacher.email,
        bank: p.teacher.teacherProfile
          ? {
              bankName: p.teacher.teacherProfile.bankName,
              bankBranch: p.teacher.teacherProfile.bankBranch,
              accountNumber: p.teacher.teacherProfile.accountNumber,
              accountHolderName: p.teacher.teacherProfile.accountHolderName,
            }
          : null,
      },
    }));

    return NextResponse.json({ ...balances, payouts: queue }, { headers: NO_STORE });
  } catch (error: unknown) {
    console.error("Admin payouts GET error:", error);
    return NextResponse.json({ error: "שגיאה בשליפת תור התשלומים" }, { status: 500 });
  }
}

/**
 * Mark a teacher's open balance as paid: `{ teacherId, amount, note? }`. `amount` must equal the net balance after
 * fines (`409` otherwise, with `currentBalance`). Writes a negative PAYOUT ledger offset `payout-paid-{uuid}`,
 * closes the teacher's open TeacherPayout rows and logs AuditLog `TEACHER_BALANCE_SETTLED`.
 */
export async function POST(request: Request) {
  const auth = await requireAuth(PAYOUT_ADMIN_ROLES);
  if (auth.error) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<SettlePayoutResponse>({ success: false, error: "גוף הבקשה אינו JSON תקין" }, { status: 400 });
  }
  const parsed = parseSettlePayoutInput(body);
  if (!parsed.ok) {
    return NextResponse.json<SettlePayoutResponse>({ success: false, error: parsed.errors.join(" · ") }, { status: 400 });
  }

  try {
    const result = await settleTeacherBalance(parsed.data, auth.user);
    if (!result.ok) {
      return NextResponse.json<SettlePayoutResponse>(
        { success: false, error: result.error, currentBalance: result.currentBalance },
        { status: result.status }
      );
    }
    return NextResponse.json<SettlePayoutResponse>({
      success: true,
      teacherId: parsed.data.teacherId,
      amountPaid: parsed.data.amount,
      penaltyAmount: result.penaltyAmount,
      balanceBefore: result.balanceBefore,
      balanceAfter: result.balanceAfter,
      transactionId: result.transactionId,
      payoutsMarkedPaid: result.payoutsMarkedPaid,
    });
  } catch (error: unknown) {
    if (isSerializationFailure(error)) {
      return NextResponse.json<SettlePayoutResponse>(
        { success: false, error: "התשלום עודכן במקביל. רעננו את הדף ונסו שוב" },
        { status: 409 }
      );
    }
    console.error("Admin payouts settle balance error:", error);
    return NextResponse.json<SettlePayoutResponse>({ success: false, error: "סימון התשלום נכשל" }, { status: 500 });
  }
}
