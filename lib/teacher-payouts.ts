import { randomUUID } from "node:crypto";
import { PayoutStatus, Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  PAYOUT_SETTLED_AUDIT_ACTION,
  PAYOUT_SETTLEMENT_PREFIX,
  roundIls,
  summarizePayoutLedger,
  TEACHER_BALANCE_ENTRY_TYPES,
  type SettlePayoutInput,
  type TeacherBalanceRow,
  type TeacherBalancesSummary,
} from "./teacher-payouts-shared";

/** Server-only teacher balances and settlement behind `/api/admin/payouts`. */

const OPEN_PAYOUT_STATUSES = [PayoutStatus.SCHEDULED, PayoutStatus.PROCESSING];
const PAYOUT_ROW_SELECT = { userId: true, entryType: true, amount: true, transactionId: true, createdAt: true } as const;
const BALANCE_ENTRY_FILTER = { in: [...TEACHER_BALANCE_ENTRY_TYPES] };

export async function listTeacherBalances(): Promise<TeacherBalancesSummary> {
  const rows = await prisma.billingLedger.findMany({ where: { entryType: BALANCE_ENTRY_FILTER }, select: PAYOUT_ROW_SELECT });
  const totals = summarizePayoutLedger(rows);
  const teacherIds = [...totals.keys()];
  if (teacherIds.length === 0) return { teachers: [], totalOpenIls: 0, teachersWithBalance: 0 };

  const [teachers, completed] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: teacherIds }, role: "TEACHER" },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        teacherProfile: { select: { bankName: true, bankBranch: true, accountNumber: true, accountHolderName: true } },
      },
    }),
    prisma.lesson.groupBy({
      by: ["teacherId"],
      where: { teacherId: { in: teacherIds }, status: "COMPLETED" },
      _count: { _all: true },
    }),
  ]);
  const completedByTeacher = new Map(completed.map((group) => [group.teacherId, group._count._all]));

  const rowsOut: TeacherBalanceRow[] = teachers.map((teacher) => {
    const total = totals.get(teacher.id)!;
    return {
      teacherId: teacher.id,
      name: teacher.name,
      phone: teacher.phone,
      email: teacher.email,
      bank: teacher.teacherProfile ?? null,
      completedLessons: completedByTeacher.get(teacher.id) ?? 0,
      earnedAmount: total.earnedIls,
      penaltyAmount: total.penaltyIls,
      paidAmount: total.paidIls,
      balance: total.balanceIls,
      lastPaidAt: total.lastPaidAt?.toISOString() ?? null,
    };
  });
  rowsOut.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name, "he"));

  const open = rowsOut.filter((row) => row.balance > 0);
  return {
    teachers: rowsOut,
    totalOpenIls: roundIls(open.reduce((sum, row) => sum + row.balance, 0)),
    teachersWithBalance: open.length,
  };
}

export type SettleResult =
  | {
      ok: true;
      penaltyAmount: number;
      balanceBefore: number;
      balanceAfter: number;
      transactionId: string;
      payoutsMarkedPaid: number;
    }
  | { ok: false; status: 404 | 409; error: string; currentBalance?: number };

/**
 * Pays a teacher's whole open balance, net of fines. The amount must match the net balance to the agora, which
 * also rejects a stale screen or a second click. One serializable transaction: a negative PAYOUT ledger offset with
 * `transactionId` `payout-paid-{uuid}`, open TeacherPayout rows → PAID (so the per-payout settle cannot pay
 * them again), and the audit entry.
 */
export async function settleTeacherBalance(
  input: SettlePayoutInput,
  actor: { id: string; role: string }
): Promise<SettleResult> {
  const teacher = await prisma.user.findFirst({
    where: { id: input.teacherId, role: "TEACHER" },
    select: { id: true, name: true },
  });
  if (!teacher) return { ok: false, status: 404, error: "המורה לא נמצא" };

  return prisma.$transaction(
    async (tx): Promise<SettleResult> => {
      const rows = await tx.billingLedger.findMany({
        where: { userId: teacher.id, entryType: BALANCE_ENTRY_FILTER },
        select: PAYOUT_ROW_SELECT,
      });
      const totals = summarizePayoutLedger(rows).get(teacher.id);
      const balanceBefore = totals?.balanceIls ?? 0;
      const penaltyAmount = totals?.penaltyIls ?? 0;
      if (balanceBefore <= 0) {
        return { ok: false, status: 409, error: "אין למורה יתרה פתוחה לתשלום", currentBalance: balanceBefore };
      }
      if (Math.round(input.amount * 100) !== Math.round(balanceBefore * 100)) {
        return {
          ok: false,
          status: 409,
          error: "הסכום אינו תואם ליתרה הפתוחה. רעננו את הדף ונסו שוב",
          currentBalance: balanceBefore,
        };
      }

      const transactionId = `${PAYOUT_SETTLEMENT_PREFIX}${randomUUID()}`;
      const openPayouts = await tx.teacherPayout.findMany({
        where: { teacherId: teacher.id, status: { in: OPEN_PAYOUT_STATUSES } },
        select: { id: true },
      });
      const payoutIds = openPayouts.map((payout) => payout.id);
      if (payoutIds.length > 0) {
        await tx.teacherPayout.updateMany({ where: { id: { in: payoutIds } }, data: { status: PayoutStatus.PAID } });
      }

      const entry = await tx.billingLedger.create({
        data: {
          userId: teacher.id,
          entryType: "PAYOUT",
          amount: -input.amount,
          currency: "ILS",
          description: `תשלום שכר למורה ${teacher.name}`,
          transactionId,
          metadata: {
            kind: "TEACHER_BALANCE_SETTLEMENT",
            balanceBefore,
            penaltyAmount,
            settledById: actor.id,
            settledByRole: actor.role,
            note: input.note,
            payoutIds,
          },
        },
        select: { id: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: PAYOUT_SETTLED_AUDIT_ACTION,
          entityType: "Teacher",
          entityId: teacher.id,
          metadata: {
            amount: input.amount,
            balanceBefore,
            penaltyAmount,
            transactionId,
            ledgerEntryId: entry.id,
            payoutsMarkedPaid: payoutIds.length,
            note: input.note,
          },
        },
      });

      return {
        ok: true,
        penaltyAmount,
        balanceBefore,
        balanceAfter: roundIls(balanceBefore - input.amount),
        transactionId,
        payoutsMarkedPaid: payoutIds.length,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}
