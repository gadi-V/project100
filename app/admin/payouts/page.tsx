"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "react-hot-toast";
import {
  pageCanvas,
  frostCard,
  primaryCta,
  secondaryCta,
  badgeSuccess,
  badgeWarning,
  badgeDanger,
  emptyState,
  ledgerCard,
  eyebrow,
} from "../../../lib/ui";

/**
 * עמוד ניהול שכר וסליקה מרוכז למנהל (ADMIN/MANAGER).
 * ・ טבלת תור סליקה: SCHEDULED / PROCESSING עם פרטי המורה ובנק.
 * ・ סימון כתשלום (settle) — נעשה דרך /api/admin/payouts/settle (ledger immutable).
 * ・ ייצוא קובץ מס"ב (CSV) לכל הפריטים בתור, לפי פורמט העברות בנקאיות.
 */

type PayoutBank = {
  bankName: string | null;
  bankBranch: string | null;
  accountNumber: string | null;
  accountHolderName: string | null;
};

type PayoutItem = {
  id: string;
  amount: string;
  currency: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  lessonId: string | null;
  lesson: { id: string; title: string | null; scheduledAt: string } | null;
  teacher: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    bank: PayoutBank | null;
  };
};

type PayoutsResponse = {
  payouts: PayoutItem[];
};

export default function AdminPayoutsPage() {
  const [payouts, setPayouts] = useState<PayoutItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchPayouts = useCallback(async () => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const res = await fetch("/api/admin/payouts");
      if (!res.ok) throw new Error("Failed to load payouts");
      const data: PayoutsResponse = await res.json();
      setPayouts(data.payouts ?? []);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPayouts();
  }, [fetchPayouts]);

  const handleSettle = async (payoutId: string) => {
    setSettlingId(payoutId);
    try {
      const res = await fetch("/api/admin/payouts/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payoutId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to settle payout");
      toast.success("התשלום סומן כשולם");
      await fetchPayouts();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Settle failed");
    } finally {
      setSettlingId(null);
    }
  };

  const totalAmount = useMemo(
    () => payouts.reduce((acc, p) => acc + Number(p.amount || 0), 0),
    [payouts]
  );

  // ייצוא קובץ מס"ב (CSV) — פורמט העברות מסלקת / בנק.
  const exportMasavCsv = () => {
    if (payouts.length === 0) return;
    const rows = payouts.map((p) => {
      const bank = p.teacher.bank;
      return [
        p.teacher.name,
        p.teacher.phone,
        bank?.bankName ?? "",
        bank?.bankBranch ?? "",
        bank?.accountNumber ?? "",
        bank?.accountHolderName ?? "",
        p.amount,
        p.currency,
        p.status,
        p.createdAt,
      ]
        .map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`)
        .join(",");
    });
    const header = [
      "שם מורה",
      "טלפון",
      "בנק",
      "סניף",
      "חשבון",
      "שם בעל החשבון",
      "סכום",
      "מטבע",
      "סטטוס",
      "נוצר ב",
    ].join(",");
    const csv = `${header}\n${rows.join("\n")}`;
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payouts-masav-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className={`${pageCanvas} flex items-center justify-center`} dir="rtl">
        <div className="text-sm font-medium text-neutral-500">טוען תור סליקה...</div>
      </div>
    );
  }

  return (
    <div className={`${pageCanvas} p-4 sm:p-8`} dir="rtl">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className={`${frostCard} flex flex-wrap items-center justify-between gap-4 p-6`}>
          <div className="space-y-1">
            <p className={eyebrow}>סליקה · Ledger</p>
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
              ניהול שכר וסליקה
            </h1>
            <p className="text-sm text-neutral-500">
              {payouts.length} תשלומים בתור · סה״כ {totalAmount.toLocaleString("he-IL")} ₪
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportMasavCsv}
              disabled={payouts.length === 0}
              className={primaryCta}
            >
              ייצוא קובץ מס&quot;ב (CSV)
            </button>
            <Link href="/admin" className={secondaryCta}>
              חזרה לדשבורד
            </Link>
          </div>
        </div>

        {errorMsg && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
            {errorMsg}
          </div>
        )}

        <div className={`${frostCard} overflow-x-auto`}>
          <table className="w-full min-w-[820px] text-sm text-start">
            <thead>
              <tr className="border-b border-neutral-100 bg-neutral-50/80 text-xs font-medium text-neutral-500">
                <th className="px-5 py-4">מורה</th>
                <th className="px-5 py-4">פרטי בנק</th>
                <th className="px-5 py-4">סכום</th>
                <th className="px-5 py-4">סטטוס</th>
                <th className="px-5 py-4">פריט</th>
                <th className="px-5 py-4">פעולה</th>
              </tr>
            </thead>
            <tbody>
              {payouts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-6">
                    <div className={emptyState}>
                      <p className="text-sm text-neutral-600">
                        אין תשלומים ממתינים לסליקה כרגע
                      </p>
                      <button
                        type="button"
                        onClick={() => void fetchPayouts()}
                        className={`inline-flex ${primaryCta}`}
                      >
                        רענון תור
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                payouts.map((p) => {
                  const bank = p.teacher.bank;
                  return (
                    <tr
                      key={p.id}
                      className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/80 transition-colors"
                    >
                      <td className="px-5 py-4">
                        <p className="font-medium text-neutral-900">{p.teacher.name}</p>
                        <p className="text-xs text-neutral-500">
                          {p.teacher.phone} · {p.teacher.email ?? ""}
                        </p>
                        <p className="mt-0.5 font-mono text-[13px] text-neutral-400">{p.id}</p>
                      </td>
                      <td className="px-5 py-4 text-xs text-neutral-600">
                        {bank?.bankName ? (
                          <>
                            <p className="font-medium text-neutral-800">{bank.bankName}</p>
                            <p>
                              סניף {bank.bankBranch ?? "—"} ·{" "}
                              <span className="font-mono">{bank.accountNumber ?? "—"}</span>
                            </p>
                            <p>{bank.accountHolderName ?? ""}</p>
                          </>
                        ) : (
                          <span className={badgeWarning}>לא הוזנו פרטי בנק</span>
                        )}
                      </td>
                      <td className="px-5 py-4 font-semibold text-neutral-900">
                        {Number(p.amount).toLocaleString("he-IL")} {p.currency}
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={
                            p.status === "PAID"
                              ? badgeSuccess
                              : p.status === "FAILED"
                                ? badgeDanger
                                : badgeWarning
                          }
                        >
                          {p.status}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-xs text-neutral-600">
                        {p.lesson
                          ? `${p.lesson.title ?? "שיעור"} · ${new Date(p.lesson.scheduledAt).toLocaleDateString("he-IL")}`
                          : "—"}
                      </td>
                      <td className="px-5 py-4">
                        {p.status === "SCHEDULED" || p.status === "PROCESSING" ? (
                          <div className={`${ledgerCard} inline-block p-2`}>
                            <button
                              type="button"
                              disabled={settlingId === p.id}
                              onClick={() => handleSettle(p.id)}
                              className="rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                            >
                              {settlingId === p.id ? "מעדכן..." : "סמן כשולם"}
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs font-medium text-emerald-800">שולם</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
