"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { formatIls, formatIsraelDay } from "../../lib/student-portal-shared";
import {
  submitSettlePayout,
  type TeacherBalanceRow,
  type TeacherBalancesSummary,
} from "../../lib/teacher-payouts-shared";
import { badgeSuccess, badgeWarning, emptyState, eyebrow, frostCard, primaryCta, secondaryCta } from "../../lib/ui";

type TeacherPayoutsBoardProps = {
  /** Server-provided first payload; the board fetches `GET /api/admin/payouts` itself when absent. */
  initialData?: TeacherBalancesSummary | null;
};

function summarize(teachers: TeacherBalanceRow[]): TeacherBalancesSummary {
  const open = teachers.filter((row) => row.balanceIls > 0);
  return {
    teachers,
    totalOpenIls: Math.round(open.reduce((sum, row) => sum + row.balanceIls, 0) * 100) / 100,
    teachersWithBalance: open.length,
  };
}

function exportBankCsv(rows: TeacherBalanceRow[]) {
  const header = ["שם מורה", "טלפון", "בנק", "סניף", "חשבון", "שם בעל החשבון", "סכום לתשלום (₪)"].join(",");
  const lines = rows.map((row) =>
    [
      row.name,
      row.phone,
      row.bank?.bankName ?? "",
      row.bank?.bankBranch ?? "",
      row.bank?.accountNumber ?? "",
      row.bank?.accountHolderName ?? "",
      row.balanceIls.toFixed(2),
    ]
      .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
      .join(",")
  );
  const blob = new Blob([`\uFEFF${header}\n${lines.join("\n")}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `teacher-payouts-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function TeacherPayoutsBoard({ initialData = null }: TeacherPayoutsBoardProps) {
  const [data, setData] = useState<TeacherBalancesSummary | null>(initialData);
  const [loading, setLoading] = useState(initialData === null);
  const [error, setError] = useState<string | null>(null);
  const [settlingId, setSettlingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/payouts", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as (TeacherBalancesSummary & { error?: string }) | null;
      if (!response.ok || !body || !Array.isArray(body.teachers)) {
        setError(body?.error ?? "טעינת יתרות המורים נכשלה");
        return;
      }
      setData({ teachers: body.teachers, totalOpenIls: body.totalOpenIls, teachersWithBalance: body.teachersWithBalance });
    } catch {
      setError("טעינת יתרות המורים נכשלה. בדקו את החיבור ונסו שוב");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialData === null) void load();
  }, [initialData, load]);

  const markPaid = async (row: TeacherBalanceRow) => {
    if (!window.confirm(`לסמן שהועבר ל${row.name} תשלום של ${formatIls(row.balanceIls)}?`)) return;
    setSettlingId(row.teacherId);
    try {
      const result = await submitSettlePayout({ teacherId: row.teacherId, amount: row.balanceIls, note: null });
      setData((current) =>
        current
          ? summarize(
              current.teachers.map((teacher) =>
                teacher.teacherId === row.teacherId
                  ? {
                      ...teacher,
                      paidIls: Math.round((teacher.paidIls + result.amountPaid) * 100) / 100,
                      balanceIls: result.balanceAfter,
                      lastPaidAt: new Date().toISOString(),
                    }
                  : teacher
              )
            )
          : current
      );
      toast.success(`התשלום ל${row.name} נרשם. היתרה התאפסה`);
    } catch (settleError: unknown) {
      toast.error(settleError instanceof Error ? settleError.message : "סימון התשלום נכשל");
      void load();
    } finally {
      setSettlingId(null);
    }
  };

  const teachers = data?.teachers ?? [];
  const payable = teachers.filter((row) => row.balanceIls > 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className={`${frostCard} flex flex-wrap items-center justify-between gap-4 p-6`}>
        <div className="space-y-1">
          <p className={eyebrow}>שכר מורים · Ledger</p>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">תשלומי מורים</h1>
          <p className="text-sm text-neutral-500" data-testid="payouts-summary">
            {data
              ? `${data.teachersWithBalance} מורים ממתינים לתשלום · סה״כ ${formatIls(data.totalOpenIls)}`
              : "טוענים את יתרות המורים..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => exportBankCsv(payable)} disabled={payable.length === 0} className={primaryCta}>
            ייצוא קובץ להעברות (CSV)
          </button>
          <Link href="/admin" className={secondaryCta}>
            חזרה לדשבורד
          </Link>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" className={secondaryCta} onClick={() => void load()}>
            נסו שוב
          </button>
        </div>
      )}

      <div className={`${frostCard} overflow-x-auto`} aria-busy={loading}>
        <table className="w-full min-w-[880px] text-sm text-start">
          <thead>
            <tr className="border-b border-neutral-100 bg-neutral-50/80 text-xs font-medium text-neutral-500">
              <th scope="col" className="px-5 py-4 text-start">מורה</th>
              <th scope="col" className="px-5 py-4 text-start">פרטי בנק</th>
              <th scope="col" className="px-5 py-4 text-start">שיעורים שהושלמו</th>
              <th scope="col" className="px-5 py-4 text-start">נצבר</th>
              <th scope="col" className="px-5 py-4 text-start">שולם</th>
              <th scope="col" className="px-5 py-4 text-start">יתרה לתשלום</th>
              <th scope="col" className="px-5 py-4 text-start">פעולה</th>
            </tr>
          </thead>
          <tbody>
            {teachers.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-6">
                  <div className={emptyState}>
                    <p className="text-sm text-neutral-600">
                      {loading ? "טוענים את יתרות המורים..." : "עדיין לא נרשם שכר למורים"}
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              teachers.map((row) => (
                <tr
                  key={row.teacherId}
                  data-teacher-id={row.teacherId}
                  className="border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/80 transition-colors"
                >
                  <td className="px-5 py-4">
                    <p className="font-medium text-neutral-900">{row.name}</p>
                    <p className="text-xs text-neutral-500" dir="ltr">
                      {row.phone}
                    </p>
                  </td>
                  <td className="px-5 py-4 text-xs text-neutral-600">
                    {row.bank?.bankName ? (
                      <>
                        <p className="font-medium text-neutral-800">{row.bank.bankName}</p>
                        <p>
                          סניף {row.bank.bankBranch ?? "—"} · <span className="font-mono">{row.bank.accountNumber ?? "—"}</span>
                        </p>
                        <p>{row.bank.accountHolderName ?? ""}</p>
                      </>
                    ) : (
                      <span className={badgeWarning}>לא הוזנו פרטי בנק</span>
                    )}
                  </td>
                  <td className="px-5 py-4 tabular-nums text-neutral-800">{row.completedLessons}</td>
                  <td className="px-5 py-4 tabular-nums text-neutral-800">{formatIls(row.earnedIls)}</td>
                  <td className="px-5 py-4 tabular-nums text-neutral-600">
                    {formatIls(row.paidIls)}
                    {row.lastPaidAt && <span className="block text-xs text-neutral-400">לאחרונה {formatIsraelDay(row.lastPaidAt)}</span>}
                  </td>
                  <td className="px-5 py-4 font-semibold tabular-nums text-neutral-900" data-balance={row.balanceIls}>
                    {formatIls(row.balanceIls)}
                  </td>
                  <td className="px-5 py-4">
                    {row.balanceIls > 0 ? (
                      <button
                        type="button"
                        disabled={settlingId === row.teacherId}
                        onClick={() => void markPaid(row)}
                        className="rounded-full bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {settlingId === row.teacherId ? "מעדכן..." : "סמן תשלום כבוצע"}
                      </button>
                    ) : (
                      <span className={badgeSuccess}>שולם במלואו</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-500">
        היתרה מחושבת מספר החשבונות: כל השכר שנרשם למורה פחות התשלומים שכבר סומנו כמבוצעים. סימון תשלום מאפס את היתרה
        ומסמן את פריטי השכר הפתוחים של המורה כשולמו.
      </p>
    </div>
  );
}
