"use client";

import { useEffect, useState, type FormEvent } from "react";
import { REASON_MAX, type CancelResult, type LifecycleResponse } from "../../../lib/lesson-lifecycle";
import { formatIsraelDateTime, type MeetingRow } from "../../../lib/student-portal-shared";
import { dangerCta, fieldClass, secondaryCta } from "../../../lib/ui";

type CancelLessonModalProps = {
  studentId: string;
  meeting: MeetingRow;
  /** The student is on the direct package track, so a credit may be returned. */
  canRestoreCredit: boolean;
  onClose: () => void;
  onDone: (result: CancelResult, whatsappDispatched: boolean) => void;
};

export default function CancelLessonModal({
  studentId,
  meeting,
  canRestoreCredit,
  onClose,
  onDone,
}: CancelLessonModalProps) {
  const [reason, setReason] = useState("");
  const [restoreCredit, setRestoreCredit] = useState(false);
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
    if (!reason.trim()) {
      setError("יש לציין סיבת ביטול");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/portal/students/${encodeURIComponent(studentId)}/meetings/${encodeURIComponent(meeting.id)}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cancellationReason: reason.trim(), restoreCredit: canRestoreCredit && restoreCredit }),
        }
      );
      const json = (await res.json().catch(() => ({ success: false }))) as LifecycleResponse<CancelResult>;
      if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "ביטול השיעור נכשל");
      onDone(json.data, json.whatsappDispatched === true);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "ביטול השיעור נכשל");
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
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cancel-lesson-title"
        className="liquid-glass rounded-3xl bg-white/90 w-full max-w-lg p-6"
      >
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-1">
            <h2 id="cancel-lesson-title" className="text-lg font-semibold text-neutral-900">
              ביטול שיעור · {meeting.title}
            </h2>
            <p className="text-sm text-neutral-500">
              {formatIsraelDateTime(meeting.scheduledAt)}. הקבוצה בוואטסאפ תקבל הודעת ביטול, הסיבה נשמרת רק אצל הצוות.
            </p>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-600">סיבת הביטול</span>
            <textarea
              className={fieldClass}
              rows={3}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              required
              autoFocus
            />
          </label>

          {canRestoreCredit ? (
            <label className="flex items-center gap-2 text-sm text-neutral-800">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-300"
                checked={restoreCredit}
                onChange={(e) => setRestoreCredit(e.target.checked)}
                disabled={submitting}
              />
              להחזיר שיעור אחד ליתרת החבילה
            </label>
          ) : (
            <p className="text-xs text-neutral-500">החזרת שיעור ליתרה זמינה רק לתלמידים עם חבילת שעות ישירה.</p>
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
            <button type="submit" className={`${dangerCta} py-2 inline-flex items-center gap-2`} disabled={submitting}>
              {submitting && (
                <span className="h-4 w-4 rounded-full border-2 border-red-200 border-t-red-700 animate-spin" aria-hidden="true" />
              )}
              {submitting ? "מבטלים את השיעור..." : "ביטול השיעור"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
