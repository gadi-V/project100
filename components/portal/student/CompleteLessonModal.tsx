"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  ATTENDANCE_OUTCOME_LABELS,
  ATTENDANCE_OUTCOMES,
  INTERNAL_NOTES_MAX,
  parseLessonSummaryPayload,
  submitLessonCompletion,
  type AttendanceOutcome,
  type CompleteLessonResponse,
  type LessonSummaryData,
} from "../../../lib/lesson-completion";
import { getCommunicationTemplate, type TemplateField } from "../../../lib/communication-templates";
import { formatIsraelDateTime, type MeetingRow } from "../../../lib/student-portal-shared";
import { fieldClass, primaryCta, secondaryCta } from "../../../lib/ui";

type LessonKind = "MAPPING" | "REGULAR";

type CompleteLessonModalProps = {
  studentId: string;
  meeting: Pick<MeetingRow, "id" | "title" | "scheduledAt" | "teacherName"> & {
    lessonType?: LessonKind;
  };
  /** "room": opened from the Daily classroom, which closes the call and moves on to the portal. */
  context?: "portal" | "room";
  /** Room-only: upload the board PDF before attendance is posted. A null result must not block completion. */
  resolveBoardPdfUrl?: () => Promise<string | null>;
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

const LONG_TEXT = new Set(["workedOn", "homework", "nextLesson", "mainGoal", "additionalNotes"]);
const EMPTY_TOPICS = [
  { topic: "", score: "" },
  { topic: "", score: "" },
  { topic: "", score: "" },
  { topic: "", score: "" },
];

function RequiredMark() {
  return (
    <span className="text-red-600" aria-hidden="true">
      {" "}
      *
    </span>
  );
}

function collectSummary(
  template: LessonSummaryData["template"],
  values: Record<string, string>,
  topics: { topic: string; score: string }[]
): unknown {
  const spec = getCommunicationTemplate(template);
  if (!spec) return null;
  const fields: Record<string, unknown> = {};
  for (const field of spec.fields) {
    if (field.kind === "list") {
      fields[field.key] = topics
        .map((row) => ({
          topic: row.topic,
          score: row.score.trim() === "" ? null : Number(row.score),
        }))
        .filter((row) => row.topic.trim() || row.score != null);
      continue;
    }
    const raw = values[field.key]?.trim() ?? "";
    if (field.kind === "score") fields[field.key] = raw === "" ? null : Number(raw);
    else fields[field.key] = raw === "" ? null : raw;
  }
  return { template, fields };
}

function SummaryQuestionnaire({
  lessonType,
  values,
  topics,
  disabled,
  onValue,
  onTopic,
}: {
  lessonType: LessonKind;
  values: Record<string, string>;
  topics: { topic: string; score: string }[];
  disabled: boolean;
  onValue: (key: string, value: string) => void;
  onTopic: (index: number, patch: { topic?: string; score?: string }) => void;
}) {
  const templateName = lessonType === "MAPPING" ? "MAPPING_SUMMARY" : "LESSON_SUMMARY";
  const template = getCommunicationTemplate(templateName);
  if (!template) return null;

  const control = (field: TemplateField) => {
    if (field.kind === "list") {
      return (
        <div key={field.key} className="space-y-2 sm:col-span-2">
          <span className="text-xs font-medium text-neutral-600">
            {field.label}
            {field.hint ? ` (${field.hint})` : ""}
          </span>
          {topics.map((row, index) => (
            <div key={index} className="grid grid-cols-[auto_1fr_6rem] items-center gap-2">
              <span className="text-xs text-neutral-500">{index + 1}.</span>
              <input
                className={fieldClass}
                value={row.topic}
                disabled={disabled}
                placeholder="נושא"
                onChange={(event) => onTopic(index, { topic: event.target.value })}
              />
              <input
                className={fieldClass}
                inputMode="numeric"
                value={row.score}
                disabled={disabled}
                placeholder="ציון"
                onChange={(event) => onTopic(index, { score: event.target.value })}
              />
            </div>
          ))}
        </div>
      );
    }
    if (field.kind === "choice") {
      return (
        <label key={field.key} className="block space-y-1.5">
          <span className="text-xs font-medium text-neutral-600">
            {field.label}
            {field.required && <RequiredMark />}
          </span>
          <select
            className={fieldClass}
            value={values[field.key] ?? ""}
            disabled={disabled}
            onChange={(event) => onValue(field.key, event.target.value)}
          >
            <option value="">בחירה</option>
            {field.options?.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      );
    }
    const long = LONG_TEXT.has(field.key);
    return (
      <label key={field.key} className={`block space-y-1.5${long ? " sm:col-span-2" : ""}`}>
        <span className="text-xs font-medium text-neutral-600">
          {field.label}
          {field.hint ? ` (${field.hint})` : ""}
          {field.required && <RequiredMark />}
        </span>
        {long ? (
          <textarea
            className={fieldClass}
            rows={2}
            value={values[field.key] ?? ""}
            disabled={disabled}
            onChange={(event) => onValue(field.key, event.target.value)}
          />
        ) : (
          <input
            className={fieldClass}
            type={field.kind === "score" ? "number" : "text"}
            min={field.kind === "score" ? 0 : undefined}
            max={field.kind === "score" ? 100 : undefined}
            value={values[field.key] ?? ""}
            disabled={disabled}
            onChange={(event) => onValue(field.key, event.target.value)}
          />
        )}
      </label>
    );
  };

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="mb-1 text-xs font-medium text-neutral-600">
        {lessonType === "MAPPING" ? "סיכום שיעור מיפוי" : "סיכום השיעור"}
      </legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{template.fields.map(control)}</div>
      <p className="text-xs text-neutral-500">
        {lessonType === "MAPPING"
          ? "הסיכום נשמר בתיק התלמיד. לקבוצת הוואטסאפ נשלחת הודעה קצרה וקישור ללוח, בלי ציונים והערות פנימיות."
          : "הסיכום נשמר בתיק התלמיד ונשלח לקבוצת הוואטסאפ יחד עם קישור ללוח."}
      </p>
    </fieldset>
  );
}

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
  resolveBoardPdfUrl,
  onClose,
  onDone,
}: CompleteLessonModalProps) {
  const notesByOutcome = context === "room" ? ROOM_OUTCOME_NOTES : OUTCOME_NOTES;
  const lessonType: LessonKind = meeting.lessonType === "MAPPING" ? "MAPPING" : "REGULAR";
  const [outcome, setOutcome] = useState<AttendanceOutcome | null>(null);
  const [notes, setNotes] = useState("");
  const [summaryValues, setSummaryValues] = useState<Record<string, string>>({});
  const [topics, setTopics] = useState(EMPTY_TOPICS);
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
    let summaryData: LessonSummaryData | undefined;
    if (outcome === "ATTENDED") {
      const template = lessonType === "MAPPING" ? "MAPPING_SUMMARY" : "LESSON_SUMMARY";
      const parsedSummary = parseLessonSummaryPayload(collectSummary(template, summaryValues, topics));
      if (!parsedSummary.ok) {
        setError(parsedSummary.errors.join(" · "));
        return;
      }
      summaryData = parsedSummary.data;
    }
    setSubmitting(true);
    try {
      let boardPdfUrl: string | null = null;
      if (resolveBoardPdfUrl) {
        try {
          boardPdfUrl = await resolveBoardPdfUrl();
        } catch (exportError: unknown) {
          console.error("[whiteboard] board export skipped:", exportError);
          boardPdfUrl = null;
        }
      }
      const result = await submitLessonCompletion({
        studentId,
        lessonId: meeting.id,
        attendanceStatus: outcome,
        internalNotes: notes.trim() || null,
        boardPdfUrl,
        summaryData,
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
        className="liquid-glass max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white/90 p-6"
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

          {outcome === "ATTENDED" && (
            <SummaryQuestionnaire
              lessonType={lessonType}
              values={summaryValues}
              topics={topics}
              disabled={submitting}
              onValue={(key, value) => setSummaryValues((current) => ({ ...current, [key]: value }))}
              onTopic={(index, patch) =>
                setTopics((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
              }
            />
          )}

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
