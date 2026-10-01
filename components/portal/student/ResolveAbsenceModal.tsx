"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  ABSENCE_NOTES_MAX,
  ABSENCE_REASON_MAX,
  ABSENCE_RESOLUTION_LABELS,
  ABSENCE_RESOLUTION_TYPES,
  submitAbsenceResolution,
  type AbsenceResolutionType,
  type ResolveAbsenceSuccess,
} from "../../../lib/absence-resolution";
import { formatIsraelDateTime, type MeetingRow } from "../../../lib/student-portal-shared";
import { fieldClass, primaryCta, secondaryCta } from "../../../lib/ui";

type ResolveAbsenceModalProps = {
  studentId: string;
  /** Latest lesson marked absent; a make-up is opened with its teacher. */
  absentLesson: Pick<MeetingRow, "id" | "title" | "scheduledAt" | "teacherName"> | null;
  onClose: () => void;
  onDone: (result: ResolveAbsenceSuccess) => void;
};

const RESOLUTION_STYLES: Record<AbsenceResolutionType, { dot: string; selected: string }> = {
  EXCUSED_MAKEUP: { dot: "bg-emerald-500", selected: "border-emerald-400 bg-emerald-50 ring-2 ring-emerald-200" },
  EXCUSED_NO_MAKEUP: { dot: "bg-sky-500", selected: "border-sky-400 bg-sky-50 ring-2 ring-sky-200" },
  UNEXCUSED_CLOSED: { dot: "bg-amber-500", selected: "border-amber-400 bg-amber-50 ring-2 ring-amber-200" },
};

const RESOLUTION_NOTES: Record<AbsenceResolutionType, string> = {
  EXCUSED_MAKEUP:
    "ייפתח שיעור השלמה עם אותו מורה בסטטוס ממתין לשיבוץ, ותוכלו לקבוע לו מועד בלשונית המפגשים. שיעור ההשלמה לא ירד מיתרת החבילה",
  EXCUSED_NO_MAKEUP: "החיסור יתועד כמוצדק ולא ייפתח שיעור השלמה",
  UNEXCUSED_CLOSED: "החיסור נשאר לא מוצדק ולא ייפתח שיעור השלמה, והטיפול בו נסגר",
};

export default function ResolveAbsenceModal({ studentId, absentLesson, onClose, onDone }: ResolveAbsenceModalProps) {
  const [resolution, setResolution] = useState<AbsenceResolutionType | null>(null);
  const [reason, setReason] = useState("");
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
    if (!resolution) {
      setError("יש לבחור את אופן הטיפול בחיסור");
      return;
    }
    if (!reason.trim()) {
      setError("יש לכתוב את סיכום השיחה ואת סיבת החיסור");
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitAbsenceResolution({
        studentId,
        resolutionType: resolution,
        reason: reason.trim(),
        notes: notes.trim() || null,
        lessonId: absentLesson?.id ?? null,
      });
      onDone(result);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "שמירת הטיפול בחיסור נכשלה");
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
        aria-labelledby="resolve-absence-title"
        className="liquid-glass rounded-3xl bg-white/90 w-full max-w-lg p-6"
      >
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-1">
            <h2 id="resolve-absence-title" className="text-lg font-semibold text-neutral-900">
              טיפול בחיסור
            </h2>
            <p className="text-sm text-neutral-500">
              {absentLesson
                ? `${absentLesson.title} · ${formatIsraelDateTime(absentLesson.scheduledAt)}${
                    absentLesson.teacherName ? ` · ${absentLesson.teacherName}` : ""
                  }`
                : "לא נמצא בלשונית שיעור שסומן כחיסור, אפשר לסגור את הטיפול בלי שיעור השלמה"}
            </p>
          </div>

          <fieldset className="space-y-2" disabled={submitting}>
            <legend className="mb-2 text-xs font-medium text-neutral-600">מה הוחלט אחרי השיחה?</legend>
            {ABSENCE_RESOLUTION_TYPES.map((option) => {
              const selected = resolution === option;
              const unavailable = option === "EXCUSED_MAKEUP" && !absentLesson;
              return (
                <label
                  key={option}
                  className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-neutral-400 ${
                    unavailable
                      ? "cursor-not-allowed border-neutral-200 bg-neutral-50 opacity-50"
                      : selected
                        ? `cursor-pointer ${RESOLUTION_STYLES[option].selected}`
                        : "cursor-pointer border-neutral-200 bg-white/70 hover:bg-white"
                  }`}
                >
                  <input
                    type="radio"
                    name="absence-resolution"
                    value={option}
                    checked={selected}
                    disabled={unavailable}
                    onChange={() => setResolution(option)}
                    className="sr-only"
                  />
                  <span className={`h-3 w-3 shrink-0 rounded-full ${RESOLUTION_STYLES[option].dot}`} aria-hidden="true" />
                  <span className="font-medium text-neutral-900">{ABSENCE_RESOLUTION_LABELS[option]}</span>
                </label>
              );
            })}
          </fieldset>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-600">סיכום השיחה עם ההורה וסיבת החיסור</span>
            <textarea
              className={fieldClass}
              rows={3}
              maxLength={ABSENCE_REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="לדוגמה: התלמיד היה חולה, ההורה עדכן באיחור"
              disabled={submitting}
              required
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-600">הערות פנימיות לתיק (לא חובה)</span>
            <textarea
              className={fieldClass}
              rows={2}
              maxLength={ABSENCE_NOTES_MAX}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={submitting}
            />
          </label>

          {resolution && (
            <p className="rounded-xl bg-neutral-50 px-4 py-2.5 text-sm text-neutral-700">
              {RESOLUTION_NOTES[resolution]}. התגית &quot;חיסור לא מוצדק&quot; תוסר מהתיק והשיחה תתועד בלשונית התקשורת.
            </p>
          )}

          {error && (
            <p role="alert" className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-800">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className={`${secondaryCta} py-2`} onClick={onClose} disabled={submitting}>
              חזרה
            </button>
            <button
              type="submit"
              className={`${primaryCta} py-2 inline-flex items-center gap-2`}
              disabled={submitting || !resolution}
            >
              {submitting && (
                <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden="true" />
              )}
              {submitting ? "שומרים את הטיפול..." : "אישור וסגירת הטיפול"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
