"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  DEFAULT_MEETING_SUBJECT,
  israelDateKey,
  israelLocalToIso,
  LESSON_TYPE_LABELS,
  MAPPING_LESSON_MINUTES,
  REGULAR_DURATION_OPTIONS,
  REGULAR_LESSON_MINUTES,
  type LessonType,
  type ScheduleMeetingResult,
  type TeacherOption,
} from "../../../lib/student-portal-shared";
import { fieldClass, primaryCta, secondaryCta } from "../../../lib/ui";

type ScheduleMeetingModalProps = {
  studentId: string;
  onClose: () => void;
  onScheduled: (result: ScheduleMeetingResult) => void;
};

type TeachersResponse = {
  success: boolean;
  data?: { teachers: TeacherOption[] };
  error?: string;
};

type ScheduleResponse = {
  success: boolean;
  data?: ScheduleMeetingResult;
  error?: string;
};

const DEFAULT_TIME = "17:00";

const TIME_OPTIONS: string[] = Array.from({ length: (22 - 8) * 4 + 1 }, (_, i) => {
  const minutes = 8 * 60 + i * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

const LESSON_TYPES: LessonType[] = ["MAPPING", "REGULAR"];

function typeButtonClass(selected: boolean): string {
  const base = "flex-1 rounded-full px-4 py-2 text-sm font-medium transition-colors";
  return selected ? `${base} bg-neutral-900 text-white` : `${base} text-neutral-600 hover:bg-white/70`;
}

export default function ScheduleMeetingModal({ studentId, onClose, onScheduled }: ScheduleMeetingModalProps) {
  const [lessonType, setLessonType] = useState<LessonType>("MAPPING");
  const [teachers, setTeachers] = useState<TeacherOption[] | null>(null);
  const [teachersError, setTeachersError] = useState<string | null>(null);
  const [teacherId, setTeacherId] = useState("");
  const [subject, setSubject] = useState(DEFAULT_MEETING_SUBJECT);
  const [date, setDate] = useState(() => israelDateKey(new Date(), 1));
  const [time, setTime] = useState(DEFAULT_TIME);
  const [regularDuration, setRegularDuration] = useState<number>(REGULAR_LESSON_MINUTES);
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
        if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "טעינת המורים נכשלה");
        if (!cancelled) setTeachers(json.data.teachers);
      } catch (loadError: unknown) {
        if (!cancelled) setTeachersError(loadError instanceof Error ? loadError.message : "טעינת המורים נכשלה");
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

  const durationMinutes = lessonType === "MAPPING" ? MAPPING_LESSON_MINUTES : regularDuration;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!teacherId) {
      setError("יש לבחור מורה");
      return;
    }
    const scheduledAt = israelLocalToIso(date, time);
    if (!scheduledAt || new Date(scheduledAt) <= new Date()) {
      setError("יש לבחור מועד עתידי");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/meetings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teacherId, subject, scheduledAt, durationMinutes, lessonType }),
      });
      const json = (await res.json().catch(() => ({ success: false }))) as ScheduleResponse;
      if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "קביעת המפגש נכשלה");
      onScheduled(json.data);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "קביעת המפגש נכשלה");
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
        aria-labelledby="schedule-meeting-title"
        className="liquid-glass rounded-3xl bg-white/90 w-full max-w-lg p-6"
      >
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-1">
            <h2 id="schedule-meeting-title" className="text-lg font-semibold text-neutral-900">
              קביעת מפגש
            </h2>
            <p className="text-sm text-neutral-500">
              {lessonType === "MAPPING"
                ? "אחרי השמירה נפתחת קבוצת וואטסאפ עם התלמיד, המורה, ההורה והצוות."
                : "המפגש יתווסף לטבלת המפגשים של התלמיד."}
            </p>
          </div>

          <div role="radiogroup" aria-label="סוג שיעור" className="flex gap-1 rounded-full bg-neutral-100/80 p-1">
            {LESSON_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={lessonType === type}
                className={typeButtonClass(lessonType === type)}
                disabled={submitting}
                onClick={() => setLessonType(type)}
              >
                {LESSON_TYPE_LABELS[type]}
              </button>
            ))}
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-600">מורה</span>
            <select
              className={fieldClass}
              value={teacherId}
              onChange={(event) => setTeacherId(event.target.value)}
              disabled={submitting || teachers === null}
              required
              autoFocus
            >
              <option value="">
                {teachers === null ? (teachersError ? "המורים לא נטענו" : "טוענים מורים...") : "בחירת מורה"}
              </option>
              {teachers?.map((teacher) => (
                <option key={teacher.id} value={teacher.id}>
                  {teacher.name}
                </option>
              ))}
            </select>
            {teachersError && <span className="block text-xs text-red-700">{teachersError}</span>}
            {teachers?.length === 0 && (
              <span className="block text-xs text-neutral-500">אין עדיין מורים מאושרים במערכת.</span>
            )}
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-600">מקצוע</span>
            <input
              className={fieldClass}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              maxLength={80}
              disabled={submitting}
              required
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-neutral-600">תאריך</span>
              <input
                type="date"
                className={fieldClass}
                value={date}
                min={israelDateKey(new Date())}
                onChange={(event) => setDate(event.target.value)}
                disabled={submitting}
                required
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-neutral-600">שעה</span>
              <select
                className={fieldClass}
                value={time}
                onChange={(event) => setTime(event.target.value)}
                disabled={submitting}
              >
                {TIME_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-neutral-600">משך</span>
            {lessonType === "MAPPING" ? (
              <p className="text-sm text-neutral-800">{MAPPING_LESSON_MINUTES} דקות</p>
            ) : (
              <select
                className={fieldClass}
                value={regularDuration}
                onChange={(event) => setRegularDuration(Number(event.target.value))}
                disabled={submitting}
                aria-label="משך"
              >
                {REGULAR_DURATION_OPTIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes} דקות
                  </option>
                ))}
              </select>
            )}
          </div>

          {error && (
            <p role="alert" className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-800">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className={`${secondaryCta} py-2`} onClick={onClose} disabled={submitting}>
              ביטול
            </button>
            <button
              type="submit"
              className={`${primaryCta} py-2 inline-flex items-center gap-2`}
              disabled={submitting || !teachers?.length}
            >
              {submitting && (
                <span
                  className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin"
                  aria-hidden="true"
                />
              )}
              {submitting
                ? lessonType === "MAPPING"
                  ? "מתאם שיעור ופותח קבוצת וואטסאפ..."
                  : "שומרים את המפגש..."
                : "קביעת מפגש"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
