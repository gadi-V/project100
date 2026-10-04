import { randomUUID } from "node:crypto";
import { LedgerEntryType } from "@prisma/client";
import { prisma } from "./prisma";
import { writeLedgerEntryInTransaction } from "./services/LedgerService";
import {
  describePayment,
  LEDGER_ENTRY_LABELS,
  MANUAL_PAYMENT_AUDIT_ACTION,
  MANUAL_TRANSACTION_PREFIX,
  manualPackageType,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  type BillingPaymentRow,
  type ManualPaymentInput,
  type StudentBillingData,
} from "./student-billing-shared";

/** Server-only reads and writes behind `/api/portal/students/[id]/billing`. */

const HISTORY_LIMIT = 100;

type PaymentRecord = {
  id: string;
  createdAt: Date;
  packageType: string;
  amountPaid: number;
  creditsAdded: number;
  status: string;
  transactionId: string;
};

function toPaymentRow(payment: PaymentRecord): BillingPaymentRow {
  return {
    id: payment.id,
    createdAt: payment.createdAt.toISOString(),
    amount: payment.amountPaid,
    ...describePayment(payment.packageType, payment.transactionId),
    creditsAdded: payment.creditsAdded,
    status: payment.status,
    statusLabel: PAYMENT_STATUS_LABELS[payment.status] ?? payment.status,
  };
}

export async function loadStudentBilling(studentId: string): Promise<StudentBillingData> {
  const [student, payments, ledger] = await Promise.all([
    prisma.user.findUnique({ where: { id: studentId }, select: { lessonCredits: true } }),
    prisma.payment.findMany({
      where: { studentId },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      select: { id: true, createdAt: true, packageType: true, amountPaid: true, creditsAdded: true, status: true, transactionId: true },
    }),
    prisma.billingLedger.findMany({
      where: { userId: studentId },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      select: { id: true, createdAt: true, entryType: true, amount: true, description: true },
    }),
  ]);
  return {
    lessonCredits: student?.lessonCredits ?? 0,
    totalPaidIls: payments.filter((p) => p.status === "COMPLETED").reduce((sum, p) => sum + p.amountPaid, 0),
    payments: payments.map(toPaymentRow),
    ledger: ledger.map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt.toISOString(),
      entryType: entry.entryType,
      entryLabel: LEDGER_ENTRY_LABELS[entry.entryType] ?? entry.entryType,
      amount: Number(entry.amount.toString()),
      description: entry.description,
    })),
  };
}

export type ManualPaymentResult = { payment: BillingPaymentRow; lessonCredits: number; ledgerEntryId: string };

/**
 * One transaction: `Payment` (COMPLETED), a `CHARGE` ledger row for the income (the ledger has no separate
 * payment type; online payments use CHARGE too), the credit increment and the audit entry. The ledger
 * `transactionId` is unique, so replaying the same `requestId` fails with P2002 instead of charging twice.
 */
export async function recordManualPayment(
  student: { id: string; name: string },
  input: ManualPaymentInput,
  actor: { id: string; role: string }
): Promise<ManualPaymentResult> {
  const transactionId = `${MANUAL_TRANSACTION_PREFIX}${input.requestId ?? randomUUID()}`;
  const methodLabel = PAYMENT_METHOD_LABELS[input.paymentMethod];

  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        studentId: student.id,
        packageType: manualPackageType(input.paymentMethod),
        amountPaid: input.amount,
        creditsAdded: input.creditsToAdd,
        transactionId,
        status: "COMPLETED",
      },
    });

    const ledgerEntryId = await writeLedgerEntryInTransaction(tx, {
      userId: student.id,
      entryType: LedgerEntryType.CHARGE,
      amount: input.amount,
      currency: "ILS",
      description: `תשלום ידני · ${methodLabel} · ${input.creditsToAdd} שיעורים`,
      relatedId: payment.id,
      transactionId,
      metadata: {
        source: "MANUAL_PAYMENT",
        paymentMethod: input.paymentMethod,
        creditsAdded: input.creditsToAdd,
        notes: input.notes,
        recordedById: actor.id,
        recordedByRole: actor.role,
      },
    });

    const updated = await tx.user.update({
      where: { id: student.id },
      data: { lessonCredits: { increment: input.creditsToAdd } },
      select: { lessonCredits: true },
    });

    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: MANUAL_PAYMENT_AUDIT_ACTION,
        entityType: "Payment",
        entityId: payment.id,
        metadata: {
          studentId: student.id,
          amount: input.amount,
          paymentMethod: input.paymentMethod,
          creditsAdded: input.creditsToAdd,
          lessonCreditsAfter: updated.lessonCredits,
          notes: input.notes,
          transactionId,
          ledgerEntryId,
        },
      },
    });

    return { payment: toPaymentRow(payment), lessonCredits: updated.lessonCredits, ledgerEntryId };
  });
}
