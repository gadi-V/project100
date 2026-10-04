"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  MANUAL_CREDITS_MAX,
  MANUAL_NOTES_MAX,
  MANUAL_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  submitManualPayment,
  type ManualPaymentMethod,
  type ManualPaymentResponse,
} from "../../../lib/student-billing-shared";
import { fieldClass, primaryCta, secondaryCta } from "../../../lib/ui";

type ManualPaymentModalProps = {
  studentId: string;
  onClose: () => void;
  onRecorded: (result: Extract<ManualPaymentResponse, { success: true }>) => void;
};

function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export default function ManualPaymentModal({ studentId, onClose, onRecorded }: ManualPaymentModalProps) {
  const [requestId] = useState(newRequestId);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<ManualPaymentMethod>("BANK_TRANSFER");
  const [credits, setCredits] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const amountValue = Number(amount);
    const creditsValue = credits.trim() ? Number(credits) : 0;
    if (!Number.isInteger(amountValue) || amountValue < 1) {
      setError("יש להזין סכום בשקלים שלמים");
      return;
    }
    if (!Number.isInteger(creditsValue) || creditsValue < 0 || creditsValue > MANUAL_CREDITS_MAX) {
      setError(`כמות השיעורים צריכה להיות בין 0 ל-${MANUAL_CREDITS_MAX}`);
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitManualPayment(studentId, {
        amount: amountValue,
        paymentMethod: method,
        creditsToAdd: creditsValue,
        notes: notes.trim() || null,
        requestId,
      });
      onRecorded(result);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "שמירת התשלום נכשלה");
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/30 backdrop-blur-sm p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-payment-title"
        className="liquid-glass rounded-3xl bg-white/90 w-full max-w-lg p-6"
      >
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-1">
            <h2 id="manual-payment-title" className="text-lg font-semibold text-neutral-900">
              הזנת תשלום והטענת חבילה
            </h2>
            <p className="text-sm text-neutral-500">
              התשלום יירשם בהיסטוריה ובספר החשבונות, והשיעורים יתווספו מיד ליתרת התלמיד.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-neutral-600">סכום ששולם (₪)</span>
              <input
                className={fieldClass}
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="1000"
                disabled={submitting}
                required
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-neutral-600">שיעורים להוספה</span>
              <input
                className={fieldClass}
                inputMode="numeric"
                value={credits}
                onChange={(e) => setCredits(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="5"
                disabled={submitting}
              />
            </label>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-600">אמצעי תשלום</span>
            <select
              className={fieldClass}
              value={method}
              onChange={(e) => setMethod(e.target.value as ManualPaymentMethod)}
              disabled={submitting}
            >
              {MANUAL_PAYMENT_METHODS.map((code) => (
                <option key={code} value={code}>
                  {PAYMENT_METHOD_LABELS[code]}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-600">הערות (לא חובה)</span>
            <textarea
              className={`${fieldClass} min-h-20`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={MANUAL_NOTES_MAX}
              placeholder="למשל: אסמכתא 4471, חבילת סמסטר"
              disabled={submitting}
            />
          </label>

          {error && (
            <p role="alert" className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-800">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className={`${secondaryCta} py-2`} onClick={onClose} disabled={submitting}>
              ביטול
            </button>
            <button type="submit" className={`${primaryCta} py-2 inline-flex items-center gap-2`} disabled={submitting}>
              {submitting && (
                <span
                  className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin"
                  aria-hidden="true"
                />
              )}
              {submitting ? "שומרים את התשלום..." : "שמירת התשלום"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
