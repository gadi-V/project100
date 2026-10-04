import type { Role } from "@prisma/client";
import { RECURRING_WEEKS, SUBSCRIPTION_TYPE_LABELS, type SubscriptionRow } from "./pedagogic-decision";
import { israelDateKey, type CardLookup, type StandingOrderData } from "./student-portal-shared";

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

export type RecurringStatus = "ACTIVE" | "PENDING" | "CANCELLED" | "NOT_SET";

export const RECURRING_STATUS_LABELS: Record<RecurringStatus, string> = {
  ACTIVE: "פעיל",
  PENDING: "ממתין",
  CANCELLED: "בוטל",
  NOT_SET: "לא הוגדר",
};

export const NO_WEEKLY_PLAN_LABEL = "ללא מנוי שבועי";

export type SubscriptionSummary = {
  /** "חד שבועי" / "דו שבועי" / "ללא מנוי שבועי". */
  planLabel: string;
  subject: string | null;
  teacherName: string | null;
  /** YYYY-MM-DD (Israel): start of the next four-week batch; null without an active plan. */
  nextChargeDate: string | null;
  recurringStatus: RecurringStatus;
  cardLabel: string;
};

export function describeCard(card: CardLookup | null): string {
  switch (card?.state) {
    case "FOUND":
      return `${card.brand.toUpperCase()} •••• ${card.last4}`;
    case "NOT_CONFIGURED":
      return "החיבור לסליקה לא הוגדר";
    case "UNAVAILABLE":
      return "לא הצלחנו לטעון את פרטי הכרטיס";
    default:
      return "אין כרטיס מקושר";
  }
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** First four-week batch boundary of a plan that is today or later. */
export function nextBatchDate(startDate: string, now: Date = new Date()): string {
  const today = israelDateKey(now);
  if (startDate >= today) return startDate;
  const cycleDays = RECURRING_WEEKS * 7;
  const elapsed = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
  return addDaysToDateKey(startDate, Math.ceil(elapsed / cycleDays) * cycleDays);
}

/**
 * Header of the כספים tab. The latest pedagogic decision is the weekly plan (`subscriptions` come newest first).
 * The standing order is active when a plan has a card on file, pending when the plan has no card yet, and
 * cancelled when the student carries the "ביטול מנוי" status.
 */
export function summarizeSubscription(
  standingOrders: StandingOrderData | null,
  subscriptions: readonly SubscriptionRow[],
  now: Date = new Date()
): SubscriptionSummary {
  const plan = subscriptions[0] ?? null;
  const cancelled = standingOrders?.status === "CANCELLED";
  let recurringStatus: RecurringStatus = "NOT_SET";
  if (cancelled) recurringStatus = "CANCELLED";
  else if (plan) recurringStatus = standingOrders?.card.state === "FOUND" ? "ACTIVE" : "PENDING";

  return {
    planLabel: plan ? SUBSCRIPTION_TYPE_LABELS[plan.subscriptionType] : NO_WEEKLY_PLAN_LABEL,
    subject: plan?.subject ?? null,
    teacherName: plan?.teacherName ?? null,
    nextChargeDate: plan && !cancelled ? nextBatchDate(plan.startDate, now) : null,
    recurringStatus,
    cardLabel: describeCard(standingOrders?.card ?? null),
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
