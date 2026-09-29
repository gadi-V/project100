"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  DIRECTORY_STATUS_FILTERS,
  GRADE_OPTIONS,
  studentStatusLabel,
  type GradeOption,
  type StudentDirectoryPage,
} from "../../lib/student-directory-shared";
import { formatIsraelDateTime, type StudentStatusCode } from "../../lib/student-portal-shared";
import { badgeNeutral, emptyState, frostCard, frostPanel, secondaryCta, skeletonShimmer } from "../../lib/ui";
import { useDebouncedValue } from "./useDebouncedValue";

type StudentDirectoryProps = {
  initialSearch: string;
  initialStatus: StudentStatusCode | null;
  initialGrade: GradeOption | null;
  initialPage: number;
  /** Teachers only ever receive their own students from the API. */
  isTeacher: boolean;
};

type LoadState = {
  loading: boolean;
  /** Last page received; kept on screen while the next one loads. */
  data: StudentDirectoryPage | null;
  error: string | null;
};

const SKELETON_ROWS = 6;

function chipClass(active: boolean): string {
  return active
    ? "bg-neutral-900 border-neutral-900 text-white"
    : "bg-white/70 border-neutral-200 text-neutral-700 hover:border-neutral-400";
}

function pageWindow(page: number, totalPages: number): number[] {
  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  const end = Math.min(totalPages, start + 4);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function directoryQuery(search: string, status: StudentStatusCode | null, grade: GradeOption | null, page: number) {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  if (grade) params.set("grade", grade);
  if (page > 1) params.set("page", String(page));
  return params;
}

function LessonCell({ nextLessonAt, lastLessonAt }: { nextLessonAt: string | null; lastLessonAt: string | null }) {
  if (nextLessonAt) {
    return (
      <span className="flex flex-col">
        <span className="text-[14px] text-neutral-500">הבא</span>
        <span className="text-neutral-900">{formatIsraelDateTime(nextLessonAt)}</span>
      </span>
    );
  }
  if (lastLessonAt) {
    return (
      <span className="flex flex-col">
        <span className="text-[14px] text-neutral-500">אחרון</span>
        <span className="text-neutral-700">{formatIsraelDateTime(lastLessonAt)}</span>
      </span>
    );
  }
  return <span className="text-neutral-400">אין שיעורים</span>;
}

export default function StudentDirectory({
  initialSearch,
  initialStatus,
  initialGrade,
  initialPage,
  isTeacher,
}: StudentDirectoryProps) {
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [status, setStatus] = useState<StudentStatusCode | null>(initialStatus);
  const [grade, setGrade] = useState<GradeOption | null>(initialGrade);
  const [page, setPage] = useState(initialPage);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<LoadState>({ loading: true, data: null, error: null });
  const search = useDebouncedValue(searchInput.trim());

  const [appliedSearch, setAppliedSearch] = useState(search);
  if (search !== appliedSearch) {
    setAppliedSearch(search);
    setPage(1);
  }

  useEffect(() => {
    const params = directoryQuery(search, status, grade, page);
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `/portal/students?${qs}` : "/portal/students");

    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fetch(`/api/portal/students?${qs}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as { success?: boolean; data?: StudentDirectoryPage; error?: string };
        if (!response.ok || !body.success || !body.data) {
          throw new Error(body.error || "טעינת הרשימה נכשלה");
        }
        const received = body.data;
        setState({ loading: false, data: received, error: null });
        if (received.page !== page) setPage(received.page);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error.message : "טעינת הרשימה נכשלה",
        }));
      });
    return () => controller.abort();
  }, [search, status, grade, page, reloadKey]);

  const selectStatus = (next: StudentStatusCode | null) => {
    setStatus(next);
    setPage(1);
  };

  const selectGrade = (next: GradeOption | null) => {
    setGrade(next);
    setPage(1);
  };

  const resetFilters = useCallback(() => {
    setSearchInput("");
    setAppliedSearch("");
    setStatus(null);
    setGrade(null);
    setPage(1);
  }, []);

  const hasFilters = Boolean(searchInput.trim() || status || grade);
  const { data, loading, error } = state;

  return (
    <div className="space-y-6">
      <section className={`${frostCard} p-6 space-y-4`}>
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-neutral-900">{isTeacher ? "התלמידים שלי" : "לקוחות"}</h1>
            <p className="text-sm text-neutral-500 mt-1">
              {data ? `נמצאו ${data.totalCount.toLocaleString("he-IL")} תוצאות` : "טוענים את הרשימה..."}
            </p>
          </div>
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="חיפוש לפי שם, טלפון, אימייל או עיר"
            aria-label="חיפוש לפי שם, טלפון, אימייל או עיר"
            className="w-full sm:max-w-sm bg-neutral-50/90 border border-neutral-200 rounded-xl px-4 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/[0.08] focus-visible:border-neutral-800"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="סינון לפי סטטוס">
          <span className="text-xs font-medium text-neutral-500 me-1">סטטוס:</span>
          <button
            type="button"
            onClick={() => selectStatus(null)}
            aria-pressed={status === null}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${chipClass(status === null)}`}
          >
            הכל
          </button>
          {DIRECTORY_STATUS_FILTERS.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => selectStatus(code)}
              aria-pressed={status === code}
              className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${chipClass(status === code)}`}
            >
              {studentStatusLabel(code)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="סינון לפי כיתה">
          <span className="text-xs font-medium text-neutral-500 me-1">כיתה:</span>
          <button
            type="button"
            onClick={() => selectGrade(null)}
            aria-pressed={grade === null}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${chipClass(grade === null)}`}
          >
            כל הכיתות
          </button>
          {GRADE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => selectGrade(option)}
              aria-pressed={grade === option}
              className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${chipClass(grade === option)}`}
            >
              {option}
            </button>
          ))}
        </div>
      </section>

      <section className={`${frostPanel} overflow-x-auto`} aria-busy={loading}>
        {error ? (
          <div className={`${emptyState} m-5`}>
            <p className="text-sm font-medium text-neutral-900">{error}</p>
            <button type="button" onClick={() => setReloadKey((key) => key + 1)} className={secondaryCta}>
              נסו שוב
            </button>
          </div>
        ) : data && data.students.length === 0 && !loading ? (
          <div className={`${emptyState} m-5`}>
            <p className="text-sm font-medium text-neutral-900">
              {hasFilters ? "לא נמצאו תלמידים שמתאימים לסינון" : "עדיין אין תלמידים ברשימה"}
            </p>
            {hasFilters && (
              <button type="button" onClick={resetFilters} className={secondaryCta}>
                איפוס סינונים
              </button>
            )}
          </div>
        ) : (
          <table className="w-full text-sm text-start">
            <thead>
              <tr className="border-b border-neutral-100 text-xs text-neutral-500">
                <th scope="col" className="px-5 py-3 font-medium text-start">שם התלמיד</th>
                <th scope="col" className="px-5 py-3 font-medium text-start">טלפון</th>
                <th scope="col" className="px-5 py-3 font-medium text-start">כיתה והקבצה</th>
                <th scope="col" className="px-5 py-3 font-medium text-start">סטטוס לקוח</th>
                <th scope="col" className="px-5 py-3 font-medium text-start">שיעור קרוב / אחרון</th>
                <th scope="col" className="px-5 py-3 font-medium text-start">מורה אחראי</th>
                <th scope="col" className="px-5 py-3">
                  <span className="sr-only">פעולות</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {!data || (loading && data.students.length === 0)
                ? Array.from({ length: SKELETON_ROWS }, (_, row) => (
                    <tr key={row} className="border-b border-neutral-100 last:border-b-0">
                      {Array.from({ length: 7 }, (_, cell) => (
                        <td key={cell} className="px-5 py-4">
                          <div className={`${skeletonShimmer} h-4 w-full max-w-[9rem]`} />
                        </td>
                      ))}
                    </tr>
                  ))
                : data.students.map((student) => (
                    <tr
                      key={student.id}
                      className={`border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50/80 transition-colors ${
                        loading ? "opacity-60" : ""
                      }`}
                    >
                      <td className="px-5 py-3">
                        <span className="block font-medium text-neutral-900">{student.fullName}</span>
                        {student.city && <span className="block text-xs text-neutral-500">{student.city}</span>}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        <span className="flex items-center gap-2">
                          <span dir="ltr" className="text-neutral-800">{student.phone}</span>
                          {student.whatsappUrl && (
                            <a
                              href={student.whatsappUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[14px] font-medium text-emerald-700 hover:underline underline-offset-4"
                            >
                              WhatsApp
                            </a>
                          )}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-neutral-700">
                        {[student.grade, student.studyGroup].filter(Boolean).join(" · ") || "—"}
                      </td>
                      <td className="px-5 py-3">
                        {student.statuses.length === 0 ? (
                          <span className="text-neutral-400">—</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {student.statuses.map((code) => (
                              <span key={code} className={badgeNeutral}>
                                {studentStatusLabel(code)}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        <LessonCell nextLessonAt={student.nextLessonAt} lastLessonAt={student.lastLessonAt} />
                      </td>
                      <td className="px-5 py-3 text-neutral-700">{student.teacherName ?? "—"}</td>
                      <td className="px-5 py-3 text-end">
                        <Link
                          href={`/portal/students/${encodeURIComponent(student.id)}`}
                          className="inline-flex whitespace-nowrap rounded-full bg-neutral-900 text-white text-xs font-medium px-4 py-1.5 hover:bg-neutral-800 transition-colors"
                        >
                          פתח תיק תלמיד
                        </Link>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        )}
      </section>

      {data && data.totalPages > 1 && (
        <nav className="flex flex-wrap items-center justify-between gap-3" aria-label="דפדוף">
          <p className="text-xs text-neutral-500">
            עמוד {data.page} מתוך {data.totalPages}
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={data.page <= 1 || loading}
              onClick={() => setPage(data.page - 1)}
              className="text-xs font-medium px-3 py-1.5 rounded-full border border-neutral-200 bg-white/70 text-neutral-700 disabled:opacity-40"
            >
              הקודם
            </button>
            {pageWindow(data.page, data.totalPages).map((number) => (
              <button
                key={number}
                type="button"
                onClick={() => setPage(number)}
                aria-current={number === data.page ? "page" : undefined}
                className={`text-xs font-medium w-8 h-8 rounded-full border transition-colors ${chipClass(number === data.page)}`}
              >
                {number}
              </button>
            ))}
            <button
              type="button"
              disabled={data.page >= data.totalPages || loading}
              onClick={() => setPage(data.page + 1)}
              className="text-xs font-medium px-3 py-1.5 rounded-full border border-neutral-200 bg-white/70 text-neutral-700 disabled:opacity-40"
            >
              הבא
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}
