"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  ATTENDANCE_OUTCOME_LABELS,
  ATTENDANCE_OUTCOMES,
  INTERNAL_NOTES_MAX,
  submitLessonCompletion,
  type AttendanceOutcome,
  type CompleteLessonResponse,
} from "../../../lib/lesson-completion";
import { formatIsraelDateTime, type MeetingRow } from "../../../lib/student-portal-shared";
import { fieldClass, primaryCta, secondaryCta } from "../../../lib/ui";

type CompleteLessonModalProps = {
  studentId: string;
  meeting: Pick<MeetingRow, "id" | "title" | "scheduledAt" | "teacherName">;
  /** "room": opened from the Daily classroom, which closes the call and moves on to the portal. */
  context?: "portal" | "room";
  onClose: () => void;
  onDone: (result: CompleteLessonResponse) => void;
};

const OUTCOME_STYLES: Record<AttendanceOutcome, { dot: string; selected: string }> = {
  ATTENDED: { dot: "bg-emerald-500", selected: "border-emerald-400 bg-emerald-50 ring-2 ring-emerald-200" },
  STUDENT_NO_SHOW: { dot: "bg-amber-400", selected: "border-amber-400 bg-amber-50 ring-2 ring-amber-200" },
  TEACHER_CANCELLED: { dot: "bg-red-500", selected: "border-red-400 bg-red-50 ring-2 ring-red-200" },
};

const OUTCOME_NOTES: Record<AttendanceOutcome, string> = {
  ATTENDED: "עם אישור סיום השיעור, שכר המורה יועבר לרישום והמערכת תפתח את טופס סיכום השיעור לוואטסאפ",
  STUDENT_NO_SHOW: "עם אישור סיום השיעור, שכר המורה יועבר לרישום והשיעור ייספר כשיעור שהתקיים לצורך יתרת החבילה",
  TEACHER_CANCELLED: "השיעור יסומן כבוטל, המורה לא יתוגמל עליו והשיעור לא ירד מיתרת התלמיד",
};

const ROOM_OUTCOME_NOTES: Record<AttendanceOutcome, string> = {
  ATTENDED: "עם אישור סיום השיעור, שכר המורה יועבר לרישום, השיחה תסתיים ותעברו לטופס סיכום השיעור לוואטסאפ",
  STUDENT_NO_SHOW:
    "עם אישור סיום השיעור, שכר המורה יועבר לרישום, החיסור יסומן בתיק התלמיד וקבוצת הוואטסאפ תעודכן. השיחה תסתיים",
  TEACHER_CANCELLED: "השיעור יסומן כבוטל, המורה לא יתוגמל עליו והשיעור לא ירד מיתרת התלמיד. השיחה תסתיים",
};

export default function CompleteLessonModal({
  studentId,
  meeting,
  context = "portal",
  onClose,
  onDone,
}: CompleteLessonModalProps) {
  const notesByOutcome = context === "room" ? ROOM_OUTCOME_NOTES : OUTCOME_NOTES;
  const [outcome, setOutcome] = useState<AttendanceOutcome | null>(null);
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
    if (!outcome) {
      setError("יש לבחור מה קרה בשיעור");
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitLessonCompletion({
        studentId,
        lessonId: meeting.id,
        attendanceStatus: outcome,
        internalNotes: notes.trim() || null,
      });
      onDone(result);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "סיום השיעור נכשל");
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
        aria-labelledby="complete-lesson-title"
        className="liquid-glass rounded-3xl bg-white/90 w-full max-w-lg p-6"
      >
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-1">
            <h2 id="complete-lesson-title" className="text-lg font-semibold text-neutral-900">
              סיום שיעור ודיווח נוכחות · {meeting.title}
            </h2>
            <p className="text-sm text-neutral-500">
              {formatIsraelDateTime(meeting.scheduledAt)}
              {meeting.teacherName ? ` · ${meeting.teacherName}` : ""}
            </p>
          </div>

          <fieldset className="space-y-2" disabled={submitting}>
            <legend className="mb-2 text-xs font-medium text-neutral-600">מה קרה בשיעור?</legend>
            {ATTENDANCE_OUTCOMES.map((option) => {
              const selected = outcome === option;
              return (
                <label
                  key={option}
                  className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 text-sm transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-neutral-400 ${
                    selected ? OUTCOME_STYLES[option].selected : "border-neutral-200 bg-white/70 hover:bg-white"
                  }`}
                >
                  <input
                    type="radio"
                    name="attendance-outcome"
                    value={option}
                    checked={selected}
                    onChange={() => setOutcome(option)}
                    className="sr-only"
                  />
                  <span className={`h-3 w-3 shrink-0 rounded-full ${OUTCOME_STYLES[option].dot}`} aria-hidden="true" />
                  <span className="font-medium text-neutral-900">{ATTENDANCE_OUTCOME_LABELS[option]}</span>
                </label>
              );
            })}
          </fieldset>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-600">הערות פנימיות לצוות (לא חובה)</span>
            <textarea
              className={fieldClass}
              rows={3}
              maxLength={INTERNAL_NOTES_MAX}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={submitting}
            />
          </label>

          <p className="rounded-xl bg-neutral-50 px-4 py-2.5 text-sm text-neutral-700">
            {notesByOutcome[outcome ?? "ATTENDED"]}
          </p>

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
              disabled={submitting || !outcome}
            >
              {submitting && (
                <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden="true" />
              )}
              {submitting ? "שומרים את סיום השיעור..." : "אישור סיום השיעור"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
