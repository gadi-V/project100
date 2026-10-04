import type { Role } from "@prisma/client";

/** Client-safe types and rules of the student billing tab (`/api/portal/students/[id]/billing`). */

export const BILLING_ROLES: Role[] = ["ADMIN", "MANAGER", "REPRESENTATIVE"];

export const MANUAL_PAYMENT_METHODS = ["BANK_TRANSFER", "CREDIT_CARD", "BIT", "CASH", "CHECK"] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<ManualPaymentMethod, string> = {
  BANK_TRANSFER: "העברה בנקאית",
  CREDIT_CARD: "כרטיס אשראי",
  BIT: "ביט",
  CASH: "מזומן",
  CHECK: "צ׳ק",
};

/** `Payment.packageType` of a manual payment: `MANUAL_{method}`. */
export const MANUAL_PACKAGE_PREFIX = "MANUAL_";
export const MANUAL_TRANSACTION_PREFIX = "manual-payment-";
export const MANUAL_PAYMENT_AUDIT_ACTION = "MANUAL_PAYMENT_AND_CREDITS_ADDED";

/** `Payment.amountPaid` is a whole-shekel integer. */
export const MANUAL_AMOUNT_MAX = 100_000;
export const MANUAL_CREDITS_MAX = 200;
export const MANUAL_NOTES_MAX = 500;

const ONLINE_PACKAGE_LABELS: Record<string, string> = {
  SINGLE: "שיעור בודד",
  TRIO: "חבילת 3 שיעורים",
  MULTI: "חבילת 5 שיעורים",
  TEN: "חבילת 10 שיעורים",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  COMPLETED: "שולם",
  PENDING: "ממתין",
  REFUNDED: "הוחזר",
};

export const LEDGER_ENTRY_LABELS: Record<string, string> = {
  CHARGE: "תשלום",
  REFUND: "החזר",
  ADJUSTMENT: "התאמה",
  PENALTY: "קנס",
  COMPENSATION: "פיצוי",
  PLATFORM_COMPENSATION: "פיצוי מהפלטפורמה",
  PLATFORM_FEE: "עמלת פלטפורמה",
  PAYOUT: "תשלום למורה",
};

export type ManualPaymentInput = {
  amount: number;
  paymentMethod: ManualPaymentMethod;
  creditsToAdd: number;
  notes: string | null;
  /** Client-generated per form; a resubmission with the same id is refused instead of charging twice. */
  requestId: string | null;
};

export type BillingPaymentRow = {
  id: string;
  createdAt: string;
  amount: number;
  methodLabel: string;
  packageLabel: string;
  creditsAdded: number;
  status: string;
  statusLabel: string;
  isManual: boolean;
};

export type BillingLedgerRow = {
  id: string;
  createdAt: string;
  entryType: string;
  entryLabel: string;
  amount: number;
  description: string | null;
};

export type StudentBillingData = {
  lessonCredits: number;
  totalPaidIls: number;
  payments: BillingPaymentRow[];
  ledger: BillingLedgerRow[];
};

export type BillingResponse = { success: true; data: StudentBillingData } | { success: false; error: string };

export type ManualPaymentResponse =
  | { success: true; payment: BillingPaymentRow; lessonCredits: number; ledgerEntryId: string }
  | { success: false; error: string };

type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function isMethod(value: unknown): value is ManualPaymentMethod {
  return typeof value === "string" && (MANUAL_PAYMENT_METHODS as readonly string[]).includes(value);
}

function wholeNumber(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) ? parsed : null;
}

export function parseManualPaymentInput(body: unknown): ParseResult<ManualPaymentInput> {
  const source = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const errors: string[] = [];

  const amount = wholeNumber(source.amount);
  if (amount === null || amount < 1 || amount > MANUAL_AMOUNT_MAX) {
    errors.push(`יש להזין סכום בשקלים שלמים בין 1 ל-${MANUAL_AMOUNT_MAX.toLocaleString("he-IL")}`);
  }

  if (!isMethod(source.paymentMethod)) errors.push("יש לבחור אמצעי תשלום");

  const credits = source.creditsToAdd === undefined ? 0 : wholeNumber(source.creditsToAdd);
  if (credits === null || credits < 0 || credits > MANUAL_CREDITS_MAX) {
    errors.push(`כמות השיעורים להוספה צריכה להיות מספר שלם בין 0 ל-${MANUAL_CREDITS_MAX}`);
  }

  let notes: string | null = null;
  if (source.notes !== undefined && source.notes !== null) {
    if (typeof source.notes !== "string") errors.push("ההערות אינן תקינות");
    else if (source.notes.trim().length > MANUAL_NOTES_MAX) errors.push(`ההערות ארוכות מ-${MANUAL_NOTES_MAX} תווים`);
    else notes = source.notes.trim() || null;
  }

  let requestId: string | null = null;
  if (source.requestId !== undefined && source.requestId !== null) {
    if (typeof source.requestId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(source.requestId)) {
      errors.push("מזהה הבקשה אינו תקין");
    } else requestId = source.requestId;
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: {
      amount: amount as number,
      paymentMethod: source.paymentMethod as ManualPaymentMethod,
      creditsToAdd: credits as number,
      notes,
      requestId,
    },
  };
}

export function manualPackageType(method: ManualPaymentMethod): string {
  return `${MANUAL_PACKAGE_PREFIX}${method}`;
}

/** Method and package labels of any `Payment` row: manual entries, Stripe checkout or the dev mock. */
export function describePayment(packageType: string, transactionId: string): {
  methodLabel: string;
  packageLabel: string;
  isManual: boolean;
} {
  if (packageType.startsWith(MANUAL_PACKAGE_PREFIX)) {
    const method = packageType.slice(MANUAL_PACKAGE_PREFIX.length);
    return {
      methodLabel: isMethod(method) ? PAYMENT_METHOD_LABELS[method] : "תשלום ידני",
      packageLabel: "תשלום ידני",
      isManual: true,
    };
  }
  return {
    methodLabel: transactionId.startsWith("mock_") ? "תשלום ניסיון (סביבת פיתוח)" : "כרטיס אשראי באתר",
    packageLabel: ONLINE_PACKAGE_LABELS[packageType] ?? packageType,
    isManual: false,
  };
}

export function billingEndpoint(studentId: string): string {
  return `/api/portal/students/${encodeURIComponent(studentId)}/billing`;
}

export async function submitManualPayment(
  studentId: string,
  input: ManualPaymentInput,
  fetchImpl: typeof fetch = fetch
): Promise<Extract<ManualPaymentResponse, { success: true }>> {
  const response = await fetchImpl(billingEndpoint(studentId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as ManualPaymentResponse | { error?: string } | null;
  if (!response.ok || !body || !("success" in body) || !body.success) {
    throw new Error((body && "error" in body && body.error) || "שמירת התשלום נכשלה");
  }
  return body;
}
