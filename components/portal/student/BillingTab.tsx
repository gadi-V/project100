"use client";

import { useCallback, useEffect, useState } from "react";
import ManualPaymentModal from "./ManualPaymentModal";
import { billingEndpoint, type BillingResponse, type StudentBillingData } from "../../../lib/student-billing-shared";
import { formatIls, formatIsraelDay } from "../../../lib/student-portal-shared";
import { badgeNeutral, badgeSuccess, badgeWarning, emptyState, eyebrow, frostPanel, primaryCta, secondaryCta } from "../../../lib/ui";

type BillingTabProps = {
  studentId: string;
  /** ADMIN / MANAGER / REPRESENTATIVE; teachers see a notice instead. */
  canViewBilling: boolean;
  /** Server-provided first payload; the tab fetches it itself when absent. */
  initialData?: StudentBillingData | null;
};

function statusBadge(status: string): string {
  if (status === "COMPLETED") return badgeSuccess;
  if (status === "PENDING") return badgeWarning;
  return badgeNeutral;
}

function signedIls(amount: number): string {
  return amount < 0 ? `−${formatIls(Math.abs(amount))}` : formatIls(amount);
}

export default function BillingTab({ studentId, canViewBilling, initialData = null }: BillingTabProps) {
  const [data, setData] = useState<StudentBillingData | null>(initialData);
  const [loading, setLoading] = useState(canViewBilling && initialData === null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(billingEndpoint(studentId), { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as BillingResponse | null;
      if (!response.ok || !body || !body.success) {
        setError(body && !body.success ? body.error : "טעינת היסטוריית התשלומים נכשלה");
        return;
      }
      setData(body.data);
    } catch {
      setError("טעינת היסטוריית התשלומים נכשלה. בדקו את החיבור ונסו שוב");
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    if (canViewBilling && initialData === null) void load();
  }, [canViewBilling, initialData, load]);

  if (!canViewBilling) {
    return (
      <div className={emptyState}>
        <p className="text-sm text-neutral-600">פרטי הכספים זמינים לנציגים ולהנהלה בלבד.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="grid grid-cols-2 gap-4 sm:w-auto">
          <section className={`${frostPanel} p-5 space-y-1 min-w-40`}>
            <h2 className={eyebrow}>יתרת שיעורים</h2>
            <p className="text-2xl font-semibold text-neutral-900 tabular-nums" data-testid="billing-credits">
              {data ? data.lessonCredits : "—"}
            </p>
          </section>
          <section className={`${frostPanel} p-5 space-y-1 min-w-40`}>
            <h2 className={eyebrow}>סה״כ שולם</h2>
            <p className="text-2xl font-semibold text-neutral-900 tabular-nums">{data ? formatIls(data.totalPaidIls) : "—"}</p>
          </section>
        </div>
        <button type="button" className={primaryCta} onClick={() => setModalOpen(true)}>
          + הזן תשלום והטען חבילה
        </button>
      </div>

      {notice && (
        <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" className={secondaryCta} onClick={() => void load()}>
            נסו שוב
          </button>
        </div>
      )}

      <section className={`${frostPanel} overflow-x-auto`} aria-labelledby="billing-payments-title" aria-busy={loading}>
        <h2 id="billing-payments-title" className="px-5 py-4 text-sm font-semibold text-neutral-900 border-b border-neutral-100">
          היסטוריית תשלומים
        </h2>
        {!data ? (
          <div className={`${emptyState} m-5`}>
            <p className="text-sm text-neutral-600">{loading ? "טוענים את היסטוריית התשלומים..." : "אין נתונים להצגה"}</p>
          </div>
        ) : data.payments.length === 0 ? (
          <div className={`${emptyState} m-5`}>
            <p className="text-sm text-neutral-600">עדיין לא נרשמו תשלומים לתלמיד הזה.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-neutral-500 border-b border-neutral-100">
              <tr>
                <th scope="col" className="px-5 py-3 text-start font-medium">תאריך</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">סכום</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">אמצעי תשלום</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">חבילה</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">שיעורים</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">סטטוס</th>
              </tr>
            </thead>
            <tbody>
              {data.payments.map((payment) => (
                <tr key={payment.id} className="border-b border-neutral-100 last:border-b-0" data-payment-id={payment.id}>
                  <td className="px-5 py-3 text-neutral-800">{formatIsraelDay(payment.createdAt)}</td>
                  <td className="px-5 py-3 text-neutral-900 font-medium tabular-nums">{formatIls(payment.amount)}</td>
                  <td className="px-5 py-3 text-neutral-800">{payment.methodLabel}</td>
                  <td className="px-5 py-3 text-neutral-700">{payment.packageLabel}</td>
                  <td className="px-5 py-3 text-neutral-800 tabular-nums">{payment.creditsAdded}</td>
                  <td className="px-5 py-3">
                    <span className={statusBadge(payment.status)}>{payment.statusLabel}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {data && data.ledger.length > 0 && (
        <section className={`${frostPanel} overflow-x-auto`} aria-labelledby="billing-ledger-title">
          <h2 id="billing-ledger-title" className="px-5 py-4 text-sm font-semibold text-neutral-900 border-b border-neutral-100">
            ספר חשבונות
          </h2>
          <table className="w-full text-sm">
            <thead className="text-xs text-neutral-500 border-b border-neutral-100">
              <tr>
                <th scope="col" className="px-5 py-3 text-start font-medium">תאריך</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">סוג</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">סכום</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">פירוט</th>
              </tr>
            </thead>
            <tbody>
              {data.ledger.map((entry) => (
                <tr key={entry.id} className="border-b border-neutral-100 last:border-b-0">
                  <td className="px-5 py-3 text-neutral-800">{formatIsraelDay(entry.createdAt)}</td>
                  <td className="px-5 py-3 text-neutral-800">{entry.entryLabel}</td>
                  <td className="px-5 py-3 text-neutral-900 tabular-nums">{signedIls(entry.amount)}</td>
                  <td className="px-5 py-3 text-neutral-600">{entry.description ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {modalOpen && (
        <ManualPaymentModal
          studentId={studentId}
          onClose={() => setModalOpen(false)}
          onRecorded={(result) => {
            setModalOpen(false);
            setNotice(
              `התשלום על סך ${formatIls(result.payment.amount)} נרשם. נוספו ${result.payment.creditsAdded} שיעורים, היתרה עכשיו ${result.lessonCredits}`
            );
            void load();
          }}
        />
      )}
    </div>
  );
}
