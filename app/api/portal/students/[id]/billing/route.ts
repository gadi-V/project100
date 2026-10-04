import { NextResponse } from "next/server";
import { requireAuth } from "../../../../../../lib/api-auth";
import { resolveStudentAccess } from "../../../../../../lib/student-portal";
import { loadStudentBilling, recordManualPayment } from "../../../../../../lib/student-billing";
import {
  BILLING_ROLES,
  parseManualPaymentInput,
  type BillingResponse,
  type ManualPaymentResponse,
} from "../../../../../../lib/student-billing-shared";

type RouteContext = { params: Promise<{ id: string }> };

const ACCESS_ERRORS = { 403: "אין לך גישה לתלמיד הזה", 404: "התלמיד לא נמצא" } as const;
const NO_STORE = { "Cache-Control": "no-store" };

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/** Payments and ledger rows of one student, newest first, with the current lesson balance. */
export async function GET(_request: Request, { params }: RouteContext) {
  const auth = await requireAuth(BILLING_ROLES);
  if (auth.error) return auth.error;
  const { id } = await params;

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) {
      return NextResponse.json<BillingResponse>({ success: false, error: ACCESS_ERRORS[access.status] }, { status: access.status });
    }
    const data = await loadStudentBilling(id);
    return NextResponse.json<BillingResponse>({ success: true, data }, { headers: NO_STORE });
  } catch (error: unknown) {
    console.error("Student billing list error:", error);
    return NextResponse.json<BillingResponse>({ success: false, error: "טעינת היסטוריית התשלומים נכשלה" }, { status: 500 });
  }
}

/**
 * Manual payment and package top-up: `{ amount, paymentMethod, creditsToAdd, notes?, requestId? }`.
 * ADMIN / MANAGER / REPRESENTATIVE only. Writes Payment + CHARGE ledger row + credits + AuditLog
 * `MANUAL_PAYMENT_AND_CREDITS_ADDED` in one transaction; a replayed `requestId` answers `409`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await requireAuth(BILLING_ROLES);
  if (auth.error) return auth.error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ManualPaymentResponse>({ success: false, error: "גוף הבקשה אינו JSON תקין" }, { status: 400 });
  }

  const parsed = parseManualPaymentInput(body);
  if (!parsed.ok) {
    return NextResponse.json<ManualPaymentResponse>(
      { success: false, error: `התשלום לא נשמר: ${parsed.errors.join(" · ")}` },
      { status: 400 }
    );
  }

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) {
      return NextResponse.json<ManualPaymentResponse>(
        { success: false, error: ACCESS_ERRORS[access.status] },
        { status: access.status }
      );
    }
    const result = await recordManualPayment(access.student, parsed.data, auth.user);
    return NextResponse.json<ManualPaymentResponse>({ success: true, ...result }, { status: 201 });
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return NextResponse.json<ManualPaymentResponse>(
        { success: false, error: "התשלום הזה כבר נרשם. רעננו את הרשימה לפני הזנה נוספת" },
        { status: 409 }
      );
    }
    console.error("Manual payment error:", error);
    return NextResponse.json<ManualPaymentResponse>({ success: false, error: "שמירת התשלום נכשלה" }, { status: 500 });
  }
}
