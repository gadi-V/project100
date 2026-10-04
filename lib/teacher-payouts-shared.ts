import type { Role } from "@prisma/client";

/** Client-safe types and rules of teacher payout settlement (`/api/admin/payouts`, `/admin/payouts`). */

export const PAYOUT_ADMIN_ROLES: Role[] = ["ADMIN", "MANAGER"];

/**
 * Settlement rows in the ledger. `markPayoutPaid` writes them positive (one per payout); the bulk settlement
 * of `POST /api/admin/payouts` writes one negative offset. Either way they count by absolute value.
 */
export const PAYOUT_SETTLEMENT_PREFIX = "payout-paid-";
/** ADJUSTMENT rows written by `/api/admin/appeals` when an approved appeal cancels a teacher PENALTY. */
export const PENALTY_WAIVER_PREFIX = "appeal-waive-";
export const PAYOUT_SETTLED_AUDIT_ACTION = "TEACHER_BALANCE_SETTLED";
export const SETTLEMENT_NOTE_MAX = 300;

/** Ledger entry types that move a teacher's balance: pay, fines, and fine waivers. */
export const TEACHER_BALANCE_ENTRY_TYPES = ["PAYOUT", "PENALTY", "ADJUSTMENT"] as const;

type AmountLike = number | string | { toString(): string };

export type PayoutLedgerRow = {
  userId: string;
  /** Omitted rows count as PAYOUT. */
  entryType?: string;
  amount: AmountLike;
  transactionId: string | null;
  createdAt: Date;
};

export type TeacherLedgerTotals = {
  /** PAYOUT rows owed to the teacher (lesson pay, late-cancel shares). */
  earnedIls: number;
  /** PENALTY rows by absolute value, less waived fines; never below 0. */
  penaltyIls: number;
  /** Settlement rows, by absolute value. */
  paidIls: number;
  /** earned − penalties − paid, never below 0; what the platform still owes. */
  balanceIls: number;
  lastPaidAt: Date | null;
};

export type TeacherBalanceRow = {
  teacherId: string;
  name: string;
  phone: string;
  email: string | null;
  bank: { bankName: string | null; bankBranch: string | null; accountNumber: string | null; accountHolderName: string | null } | null;
  completedLessons: number;
  /** Gross pay (PAYOUT rows without `payout-paid-`). */
  earnedAmount: number;
  /** Net fines (PENALTY less appeal waivers). */
  penaltyAmount: number;
  /** Settlements already paid (`payout-paid-` rows). */
  paidAmount: number;
  /** earnedAmount − penaltyAmount − paidAmount, never below 0. */
  balance: number;
  lastPaidAt: string | null;
};

export type TeacherBalancesSummary = {
  teachers: TeacherBalanceRow[];
  totalOpenIls: number;
  teachersWithBalance: number;
};

export type SettlePayoutInput = { teacherId: string; amount: number; note: string | null };

export type SettlePayoutResponse =
  | {
      success: true;
      teacherId: string;
      amountPaid: number;
      /** Net fines already deducted from `balanceBefore`. */
      penaltyAmount: number;
      balanceBefore: number;
      balanceAfter: number;
      transactionId: string;
      payoutsMarkedPaid: number;
    }
  | { success: false; error: string; currentBalance?: number };

export function roundIls(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isSettlementRow(transactionId: string | null): boolean {
  return Boolean(transactionId?.startsWith(PAYOUT_SETTLEMENT_PREFIX));
}

export function isPenaltyWaiverRow(transactionId: string | null): boolean {
  return Boolean(transactionId?.startsWith(PENALTY_WAIVER_PREFIX));
}

/**
 * Per-teacher totals of PAYOUT, PENALTY and penalty-waiver ADJUSTMENT rows; other ADJUSTMENT rows are ignored.
 * Fines are written positive by the cancel route and negative elsewhere, so they count by absolute value.
 */
export function summarizePayoutLedger(rows: readonly PayoutLedgerRow[]): Map<string, TeacherLedgerTotals> {
  const totals = new Map<string, TeacherLedgerTotals>();
  for (const row of rows) {
    const entryType = row.entryType ?? "PAYOUT";
    const waiver = entryType === "ADJUSTMENT" && isPenaltyWaiverRow(row.transactionId);
    if (entryType !== "PAYOUT" && entryType !== "PENALTY" && !waiver) continue;

    const current = totals.get(row.userId) ?? { earnedIls: 0, penaltyIls: 0, paidIls: 0, balanceIls: 0, lastPaidAt: null };
    const amount = Number(row.amount.toString());
    if (entryType === "PENALTY") {
      current.penaltyIls += Math.abs(amount);
    } else if (waiver) {
      current.penaltyIls -= Math.abs(amount);
    } else if (isSettlementRow(row.transactionId)) {
      current.paidIls += Math.abs(amount);
      if (!current.lastPaidAt || row.createdAt > current.lastPaidAt) current.lastPaidAt = row.createdAt;
    } else {
      current.earnedIls += amount;
    }
    totals.set(row.userId, current);
  }
  for (const value of totals.values()) {
    value.earnedIls = roundIls(value.earnedIls);
    value.penaltyIls = roundIls(Math.max(0, value.penaltyIls));
    value.paidIls = roundIls(value.paidIls);
    value.balanceIls = roundIls(Math.max(0, value.earnedIls - value.penaltyIls - value.paidIls));
  }
  return totals;
}

type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

export function parseSettlePayoutInput(body: unknown): ParseResult<SettlePayoutInput> {
  const source = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const teacherId = typeof source.teacherId === "string" ? source.teacherId.trim() : "";
  if (!teacherId) errors.push("יש לבחור מורה");

  const amount = typeof source.amount === "number" ? source.amount : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    errors.push("סכום התשלום צריך להיות חיובי, עד שתי ספרות אחרי הנקודה");
  }

  let note: string | null = null;
  if (source.note !== undefined && source.note !== null) {
    if (typeof source.note !== "string" || source.note.trim().length > SETTLEMENT_NOTE_MAX) {
      errors.push(`ההערה צריכה להיות טקסט של עד ${SETTLEMENT_NOTE_MAX} תווים`);
    } else note = source.note.trim() || null;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: { teacherId, amount: roundIls(amount), note } };
}

export async function submitSettlePayout(
  input: SettlePayoutInput,
  fetchImpl: typeof fetch = fetch
): Promise<Extract<SettlePayoutResponse, { success: true }>> {
  const response = await fetchImpl("/api/admin/payouts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as SettlePayoutResponse | { error?: string } | null;
  if (!response.ok || !body || !("success" in body) || !body.success) {
    throw new Error((body && "error" in body && body.error) || "סימון התשלום נכשל");
  }
  return body;
}
