"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  DIRECT_PACKAGES,
  type DirectPackageCode,
  type DirectPackageResult,
} from "../../../lib/pedagogic-decision";
import { DEFAULT_MEETING_SUBJECT, type TeacherOption } from "../../../lib/student-portal-shared";
import { fieldClass, primaryCta, secondaryCta } from "../../../lib/ui";

type DirectPackageModalProps = {
  studentId: string;
  onClose: () => void;
  onAssigned: (result: DirectPackageResult) => void;
};

type TeachersResponse = { success: boolean; data?: { teachers: TeacherOption[] }; error?: string };
type AssignResponse = { success: boolean; data?: DirectPackageResult; error?: string };

function packageCardClass(selected: boolean): string {
  const base = "rounded-2xl border px-4 py-3 text-start transition-colors";
  return selected
    ? `${base} border-neutral-900 bg-neutral-900 text-white`
    : `${base} border-neutral-200 bg-white/70 text-neutral-800 hover:border-neutral-400`;
}

export default function DirectPackageModal({ studentId, onClose, onAssigned }: DirectPackageModalProps) {
  const [packageCode, setPackageCode] = useState<DirectPackageCode>(DIRECT_PACKAGES[0].code);
  const [subject, setSubject] = useState(DEFAULT_MEETING_SUBJECT);
  const [preferredTeacherId, setPreferredTeacherId] = useState("");
  const [teachers, setTeachers] = useState<TeacherOption[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/meetings`, {
          cache: "no-store",
        });
        const json = (await res.json().catch(() => ({ success: false }))) as TeachersResponse;
        if (!cancelled) setTeachers(res.ok && json.success && json.data ? json.data.teachers : []);
      } catch {
        if (!cancelled) setTeachers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId]);

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
    if (!subject.trim()) {
      setError("יש לציין מקצוע");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/direct-package`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packageCode, subject, preferredTeacherId: preferredTeacherId || null }),
      });
      const json = (await res.json().catch(() => ({ success: false }))) as AssignResponse;
      if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "שיוך החבילה נכשל");
      onAssigned(json.data);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "שיוך החבילה נכשל");
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
        aria-labelledby="direct-package-title"
        className="liquid-glass rounded-3xl bg-white/90 w-full max-w-lg p-6"
      >
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-1">
            <h2 id="direct-package-title" className="text-lg font-semibold text-neutral-900">
              שיוך חבילת שעות ישירה
            </h2>
            <p className="text-sm text-neutral-500">לסטודנטים ולתלמידים שרוכשים חבילה בלי שיעור מיפוי.</p>
          </div>

          <div role="radiogroup" aria-label="חבילה" className="grid gap-2 sm:grid-cols-3">
            {DIRECT_PACKAGES.map((pkg) => (
              <button
                key={pkg.code}
                type="button"
                role="radio"
                aria-checked={packageCode === pkg.code}
                className={packageCardClass(packageCode === pkg.code)}
                disabled={submitting}
                onClick={() => setPackageCode(pkg.code)}
              >
                <span className="block text-sm font-semibold">{pkg.name}</span>
                <span className="block text-xs opacity-75">{pkg.credits} שיעורים</span>
              </button>
            ))}
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-600">מקצוע</span>
            <input
              className={fieldClass}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={80}
              disabled={submitting}
              required
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-600">מורה מועדף (לא חובה)</span>
            <select
              className={fieldClass}
              value={preferredTeacherId}
              onChange={(e) => setPreferredTeacherId(e.target.value)}
              disabled={submitting || teachers === null}
            >
              <option value="">{teachers === null ? "טוענים מורים..." : "ללא העדפה"}</option>
              {teachers?.map((teacher) => (
                <option key={teacher.id} value={teacher.id}>
                  {teacher.name}
                </option>
              ))}
            </select>
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
              {submitting ? "שומרים את החבילה..." : "שיוך החבילה"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
