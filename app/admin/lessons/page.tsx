"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "react-hot-toast";
import {
  pageCanvas,
  frostCard,
  primaryCta,
  secondaryCta,
  fieldClass,
  badgeSuccess,
  badgeWarning,
  badgeDanger,
  badgeNeutral,
  emptyState,
  ledgerCard,
} from "../../../lib/ui";

type AdminLesson = {
  id: string;
  title: string | null;
  status: string;
  scheduledAt: string;
  canceledAt: string | null;
  appealStatus: string;
  studentId: string;
  teacherId: string;
  student: { id: string; name: string | null; phone: string | null };
  teacher: { id: string; name: string | null; phone: string | null };
};

type CompensationResponse = {
  success?: boolean;
  alreadyIssued?: boolean;
  error?: string;
  data?: {
    message?: string;
    transactionId?: string | null;
    ledgerEntryId?: string;
    amountIls?: number;
    balancedAgainst?: string | null;
    entryType?: string;
    lessonCredits?: number;
  };
};

export default function AdminLessonsPage() {
  const [lessons, setLessons] = useState<AdminLesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<"comp" | "cancel" | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const selected = lessons.find((l) => l.id === selectedId) ?? null;

  const fetchLessons = useCallback(async (q?: string) => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const params = new URLSearchParams();
      if (q?.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/admin/lessons?${params.toString()}`);
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        data?: { lessons?: AdminLesson[] };
      };
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to load lessons");
      }
      const list = json.data?.lessons ?? [];
      setLessons(list);
      setSelectedId((prev) => {
        if (prev && list.some((l) => l.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "שגיאה בטעינה");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLessons();
  }, [fetchLessons]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void fetchLessons(searchQuery);
  };

  const issueCompensation = async () => {
    if (!selected) {
      toast.error("יש לבחור שיעור");
      return;
    }
    const reason = window.prompt(
      "סיבת הנפקת שיעור חלופי (פיצוי מאוזן):",
      "Admin Super-Override — שיעור פיצוי"
    );
    if (!reason?.trim()) {
      toast.error("נדרשת סיבה להנפקת הפיצוי");
      return;
    }

    setActionLoading("comp");
    const t = toast.loading("מנפיק שיעור פיצוי מאוזן...");
    try {
      const res = await fetch("/api/admin/override/compensation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonId: selected.id,
          studentId: selected.studentId,
          reason: reason.trim(),
        }),
      });
      const json = (await res.json()) as CompensationResponse;
      if (!res.ok || !json.success) {
        throw new Error(json.error || "הנפקת הפיצוי נכשלה");
      }

      const txId = json.data?.transactionId ?? "—";
      const balanced = json.data?.balancedAgainst
        ? `מאוזן מול CHARGE ${json.data.balancedAgainst}`
        : "PLATFORM_COMPENSATION נרשם (ללא CHARGE קודם)";

      toast.success(
        `${json.alreadyIssued ? "כבר הונפק היום · " : ""}${json.data?.message ?? "פיצוי הונפק"}\n` +
          `transactionId: ${txId}\n${balanced}`,
        { id: t, duration: 8000 }
      );
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהנפקת פיצוי", { id: t });
    } finally {
      setActionLoading(null);
    }
  };

  /**
   * Admin/MANAGER cancel path in `/api/lessons/[id]/cancel` skips teacher PENALTY
   * (neither teacher- nor student-acting branches fire) — "ביטול ללא קנס".
   */
  const cancelWithoutPenalty = async () => {
    if (!selected) {
      toast.error("יש לבחור שיעור");
      return;
    }
    if (selected.status === "CANCELLED" || selected.status === "CANCELLED_LATE") {
      toast.error("השיעור כבר בוטל");
      return;
    }
    if (selected.status === "COMPLETED" || selected.status === "IN_PROGRESS") {
      toast.error(`לא ניתן לבטל שיעור במצב ${selected.status}`);
      return;
    }

    const confirmed = window.confirm(
      `לבטל את השיעור ללא קנס?\nתלמיד: ${selected.student.name ?? "—"}\nמורה: ${selected.teacher.name ?? "—"}`
    );
    if (!confirmed) return;

    setActionLoading("cancel");
    const t = toast.loading("מבטל שיעור ללא קנס...");
    try {
      const res = await fetch(`/api/lessons/${selected.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        alreadyCancelled?: boolean;
        status?: string;
        message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.error || "ביטול השיעור נכשל");
      }
      toast.success(
        `ביטול ללא קנס הצליח · lessonId: ${selected.id}` +
          (json.message ? `\n${json.message}` : "") +
          (json.status ? ` · status=${json.status}` : ""),
        { id: t, duration: 6000 }
      );
      await fetchLessons(searchQuery);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בביטול", { id: t });
    } finally {
      setActionLoading(null);
    }
  };

  const statusBadge = (status: string) => {
    if (status === "SCHEDULED") return badgeSuccess;
    if (status.startsWith("CANCEL")) return badgeDanger;
    if (status === "COMPLETED") return badgeNeutral;
    return badgeWarning;
  };

  return (
    <div className={`${pageCanvas} p-6 sm:p-8`} dir="rtl">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
              ניהול שיעורים
            </h1>
            <p className="mt-1 text-xs text-neutral-500">
              פאנל ביקורת ופעולות Super-Override — ללא שינוי לוגיקת הלדג׳ר הקיימת
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/admin" className={secondaryCta}>
              לוח ניהול
            </Link>
            <Link href="/admin/teachers" className={secondaryCta}>
              משפך מורים
            </Link>
          </div>
        </div>

        {/* Fintech Super-Override ledger card */}
        <div className={`${ledgerCard} p-5`}>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-neutral-800 pb-3">
            <div>
              <p className="text-[13px] font-medium uppercase tracking-widest text-neutral-400">
                Ledger control
              </p>
              <h2 className="mt-1 text-base font-semibold text-neutral-50">
                Admin Super-Override
              </h2>
              <p className="mt-0.5 text-xs text-neutral-400">
                פעולות מנהל חריגות — פיצוי מאוזן (PLATFORM_COMPENSATION) וביטול ללא קנס מורה
              </p>
            </div>
            {selected && (
              <div className="rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-[14px] text-neutral-200">
                <p className="font-medium text-neutral-50">שיעור נבחר</p>
                <p className="font-mono text-[13px] text-neutral-400">{selected.id}</p>
                <p>
                  {selected.student.name ?? "תלמיד"} · {selected.teacher.name ?? "מורה"}
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              disabled={!selected || actionLoading !== null}
              onClick={() => void issueCompensation()}
              className="flex-1 rounded-full bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-950 hover:bg-white disabled:opacity-40"
            >
              {actionLoading === "comp"
                ? "מנפיק..."
                : "הנפק שיעור חלופי (פיצוי מאוזן)"}
            </button>
            <button
              type="button"
              disabled={!selected || actionLoading !== null}
              onClick={() => void cancelWithoutPenalty()}
              className="flex-1 rounded-full border border-red-400/60 bg-transparent px-4 py-3 text-sm font-medium text-red-300 hover:bg-red-950/40 disabled:opacity-40"
            >
              {actionLoading === "cancel" ? "מבטל..." : "ביטול שיעור ללא קנס"}
            </button>
          </div>
          <p className="mt-3 text-[14px] text-neutral-500">
            לאחר פיצוי מוצלח יוצג toast עם{" "}
            <span className="font-mono text-neutral-300">transactionId</span> מ־BillingLedger.
          </p>
        </div>

        <form onSubmit={handleSearch} className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="חיפוש לפי מזהה / שם תלמיד / מורה / כותרת..."
            className={`${fieldClass} min-w-[220px] flex-1`}
          />
          <button type="submit" className={primaryCta}>
            חפש
          </button>
        </form>

        {errorMsg && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {errorMsg}
          </div>
        )}

        <div className={`${frostCard} overflow-hidden`}>
          {loading ? (
            <div className="p-8 text-center text-sm text-neutral-500">טוען שיעורים...</div>
          ) : lessons.length === 0 ? (
            <div className={`${emptyState} m-4`}>
              <p className="text-sm text-neutral-600">לא נמצאו שיעורים</p>
              <button
                type="button"
                onClick={() => void fetchLessons()}
                className={`inline-flex ${primaryCta}`}
              >
                רענון רשימה
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-start text-sm">
                <thead className="bg-neutral-50/80 text-[14px] font-medium uppercase tracking-wide text-neutral-500">
                  <tr className="border-b border-neutral-100">
                    <th className="px-5 py-4 text-start">בחירה</th>
                    <th className="px-5 py-4 text-start">מועד</th>
                    <th className="px-5 py-4 text-start">תלמיד</th>
                    <th className="px-5 py-4 text-start">מורה</th>
                    <th className="px-5 py-4 text-start">סטטוס</th>
                    <th className="px-5 py-4 text-start">כותרת</th>
                  </tr>
                </thead>
                <tbody>
                  {lessons.map((lesson) => {
                    const isSelected = lesson.id === selectedId;
                    return (
                      <tr
                        key={lesson.id}
                        onClick={() => setSelectedId(lesson.id)}
                        className={`cursor-pointer border-b border-neutral-100 last:border-b-0 transition-colors ${
                          isSelected
                            ? "bg-neutral-100/80"
                            : "hover:bg-neutral-50/80"
                        }`}
                      >
                        <td className="px-5 py-4">
                          <input
                            type="radio"
                            name="selectedLesson"
                            checked={isSelected}
                            onChange={() => setSelectedId(lesson.id)}
                            className="accent-neutral-900"
                            aria-label={`בחר שיעור ${lesson.id}`}
                          />
                        </td>
                        <td className="px-5 py-4 whitespace-nowrap text-xs text-neutral-700">
                          {new Date(lesson.scheduledAt).toLocaleString("he-IL")}
                        </td>
                        <td className="px-5 py-4">
                          <p className="font-medium text-neutral-900">
                            {lesson.student.name || "ללא שם"}
                          </p>
                          <p className="font-mono text-[13px] text-neutral-400">
                            {lesson.studentId}
                          </p>
                        </td>
                        <td className="px-5 py-4">
                          <p className="font-medium text-neutral-900">
                            {lesson.teacher.name || "ללא שם"}
                          </p>
                          <p className="text-[13px] text-neutral-400">
                            {lesson.teacher.phone || "—"}
                          </p>
                        </td>
                        <td className="px-5 py-4">
                          <span className={statusBadge(lesson.status)}>{lesson.status}</span>
                        </td>
                        <td className="px-5 py-4 text-xs text-neutral-600">
                          {lesson.title || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
