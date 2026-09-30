"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  israelTimeKey,
  QUARTER_HOUR_TIME_OPTIONS,
  REASON_MAX,
  type LifecycleResponse,
  type RescheduleResult,
} from "../../../lib/lesson-lifecycle";
import {
  formatIsraelDateTime,
  israelDateKey,
  israelLocalToIso,
  type MeetingRow,
} from "../../../lib/student-portal-shared";
import { fieldClass, primaryCta, secondaryCta } from "../../../lib/ui";

type RescheduleLessonModalProps = {
  studentId: string;
  meeting: MeetingRow;
  onClose: () => void;
  onDone: (result: RescheduleResult, whatsappDispatched: boolean) => void;
};

export default function RescheduleLessonModal({ studentId, meeting, onClose, onDone }: RescheduleLessonModalProps) {
  const current = new Date(meeting.scheduledAt);
  const [date, setDate] = useState(() => israelDateKey(current));
  const [time, setTime] = useState(() => israelTimeKey(current));
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timeOptions = QUARTER_HOUR_TIME_OPTIONS.includes(time) ? QUARTER_HOUR_TIME_OPTIONS : [time, ...QUARTER_HOUR_TIME_OPTIONS];

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
    const newScheduledAt = israelLocalToIso(date, time);
    if (!newScheduledAt || new Date(newScheduledAt) <= new Date()) {
      setError("יש לבחור מועד עתידי");
      return;
    }
    if (newScheduledAt === new Date(meeting.scheduledAt).toISOString()) {
      setError("המועד החדש זהה למועד הנוכחי");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/portal/students/${encodeURIComponent(studentId)}/meetings/${encodeURIComponent(meeting.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ newScheduledAt, reason: reason.trim() || null }),
        }
      );
      const json = (await res.json().catch(() => ({ success: false }))) as LifecycleResponse<RescheduleResult>;
      if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "שינוי המועד נכשל");
      onDone(json.data, json.whatsappDispatched === true);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "שינוי המועד נכשל");
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
        aria-labelledby="reschedule-lesson-title"
        className="liquid-glass rounded-3xl bg-white/90 w-full max-w-lg p-6"
      >
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-1">
            <h2 id="reschedule-lesson-title" className="text-lg font-semibold text-neutral-900">
              שינוי מועד · {meeting.title}
            </h2>
            <p className="text-sm text-neutral-500">
              המועד הנוכחי: {formatIsraelDateTime(meeting.scheduledAt)}. אחרי השמירה יישלח עדכון לקבוצת הוואטסאפ.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-neutral-600">תאריך חדש</span>
              <input
                type="date"
                className={fieldClass}
                value={date}
                min={israelDateKey(new Date())}
                onChange={(e) => setDate(e.target.value)}
                disabled={submitting}
                required
                autoFocus
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-neutral-600">שעה חדשה</span>
              <select className={fieldClass} value={time} onChange={(e) => setTime(e.target.value)} disabled={submitting}>
                {timeOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-600">סיבת הדחייה (לא חובה)</span>
            <textarea
              className={fieldClass}
              rows={2}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
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
                <span className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden="true" />
              )}
              {submitting ? "שומרים את המועד החדש..." : "שמירת המועד החדש"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
