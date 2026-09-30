"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  QUARTER_HOUR_TIME_OPTIONS,
  type LifecycleResponse,
  type SchedulePendingResult,
} from "../../../lib/lesson-lifecycle";
import {
  israelDateKey,
  israelLocalToIso,
  type MeetingRow,
  type TeacherOption,
} from "../../../lib/student-portal-shared";
import { fieldClass, primaryCta, secondaryCta } from "../../../lib/ui";

type SchedulePendingLessonModalProps = {
  studentId: string;
  meeting: MeetingRow;
  onClose: () => void;
  onDone: (result: SchedulePendingResult, whatsappDispatched: boolean) => void;
};

type TeachersResponse = { success: boolean; data?: { teachers: TeacherOption[] }; error?: string };

const DEFAULT_TIME = "17:00";

export default function SchedulePendingLessonModal({
  studentId,
  meeting,
  onClose,
  onDone,
}: SchedulePendingLessonModalProps) {
  const [teachers, setTeachers] = useState<TeacherOption[] | null>(null);
  const [teachersError, setTeachersError] = useState<string | null>(null);
  const [teacherId, setTeacherId] = useState(meeting.teacherId);
  const [date, setDate] = useState(() => israelDateKey(new Date(), 1));
  const [time, setTime] = useState(DEFAULT_TIME);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/meetings`, { cache: "no-store" });
        const json = (await res.json().catch(() => ({ success: false }))) as TeachersResponse;
        if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "טעינת המורים נכשלה");
        if (cancelled) return;
        const loaded = json.data.teachers;
        setTeachers(loaded);
        if (!loaded.some((t) => t.id === meeting.teacherId)) setTeacherId("");
      } catch (loadError: unknown) {
        if (!cancelled) setTeachersError(loadError instanceof Error ? loadError.message : "טעינת המורים נכשלה");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId, meeting.teacherId]);

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
      const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/meetings/pending-schedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lessonId: meeting.id, teacherId, scheduledAt }),
      });
      const json = (await res.json().catch(() => ({ success: false }))) as LifecycleResponse<SchedulePendingResult>;
      if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "שיבוץ השיעור נכשל");
      onDone(json.data, json.whatsappDispatched === true);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "שיבוץ השיעור נכשל");
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
        aria-labelledby="schedule-pending-title"
        className="liquid-glass rounded-3xl bg-white/90 w-full max-w-lg p-6"
      >
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-1">
            <h2 id="schedule-pending-title" className="text-lg font-semibold text-neutral-900">
              שיבוץ שיעור פרטי · {meeting.title}
            </h2>
            <p className="text-sm text-neutral-500">בחרו מורה ומועד. אחרי השמירה יישלח עדכון לקבוצת הוואטסאפ.</p>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-600">מורה</span>
            <select
              className={fieldClass}
              value={teacherId}
              onChange={(e) => setTeacherId(e.target.value)}
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
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-neutral-600">תאריך</span>
              <input
                type="date"
                className={fieldClass}
                value={date}
                min={israelDateKey(new Date())}
                onChange={(e) => setDate(e.target.value)}
                disabled={submitting}
                required
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-neutral-600">שעה</span>
              <select className={fieldClass} value={time} onChange={(e) => setTime(e.target.value)} disabled={submitting}>
                {QUARTER_HOUR_TIME_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="text-sm text-neutral-600">משך: {meeting.durationMinutes} דקות</p>

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
                <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden="true" />
              )}
              {submitting ? "שומרים את המועד..." : "שבץ מועד"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
