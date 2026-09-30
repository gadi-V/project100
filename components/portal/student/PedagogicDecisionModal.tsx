"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  EXTRA_PRIVATE_LESSON_OPTIONS,
  PARENT_TYPES,
  RECURRING_WEEKS,
  SLOTS_PER_SUBSCRIPTION,
  SUBSCRIPTION_TYPE_LABELS,
  WEEKDAY_LABELS,
  WEEKLY_TIME_OPTIONS,
  type ExtraPrivateLessons,
  type ParentType,
  type PedagogicDecisionResult,
  type PedagogicOverview,
  type SubscriptionType,
  type WeeklySlot,
} from "../../../lib/pedagogic-decision";
import { DEFAULT_MEETING_SUBJECT, formatIsraelDay, israelDateKey } from "../../../lib/student-portal-shared";
import { fieldClass, primaryCta, secondaryCta } from "../../../lib/ui";

type PedagogicDecisionModalProps = {
  studentId: string;
  onClose: () => void;
  onSaved: (result: PedagogicDecisionResult, whatsappDispatched: boolean) => void;
};

type OverviewResponse = { success: boolean; data?: PedagogicOverview; error?: string };
type DecisionResponse = {
  success: boolean;
  data?: PedagogicDecisionResult;
  whatsappDispatched?: boolean;
  error?: string;
};

const SUBSCRIPTION_TYPES: SubscriptionType[] = ["WEEKLY", "TWICE_WEEKLY"];
/** Sunday–Friday; Saturday is not offered for fixed lessons. */
const WEEKDAY_OPTIONS = WEEKDAY_LABELS.slice(0, 6).map((label, weekday) => ({ weekday, label }));
const DEFAULT_SLOTS: WeeklySlot[] = [
  { weekday: 1, time: "17:00" },
  { weekday: 3, time: "17:00" },
];

function pillClass(selected: boolean): string {
  const base = "flex-1 rounded-full px-4 py-2 text-sm font-medium transition-colors";
  return selected ? `${base} bg-neutral-900 text-white` : `${base} text-neutral-600 hover:bg-white/70`;
}

type PillGroupProps<T extends string | number | boolean> = {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
};

function PillGroup<T extends string | number | boolean>({ label, options, value, onChange, disabled }: PillGroupProps<T>) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-neutral-600">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-full bg-neutral-100/80 p-1">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            className={pillClass(value === option.value)}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function OverviewCard({ title, subtitle, children }: { title: string; subtitle?: string | null; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-200/80 bg-white/70 p-4 space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
        {subtitle && <p className="text-xs text-neutral-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex gap-2 text-sm">
      <dt className="shrink-0 text-neutral-500">{label}:</dt>
      <dd className="text-neutral-800 whitespace-pre-line">{value}</dd>
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-sm text-neutral-500">{text}</p>;
}

function Overview360({ overview }: { overview: PedagogicOverview }) {
  const { intake, diagnostic, mapping, mappingLesson } = overview;
  return (
    <div className="grid gap-3 md:grid-cols-2" aria-label="תמונת מצב 360">
      <OverviewCard
        title="שיחת קליטה עם נציג/ה"
        subtitle={intake ? `${intake.representativeName ?? "נציג/ה"} · ${formatIsraelDay(intake.createdAt)}` : null}
      >
        {intake ? (
          <dl className="space-y-1">
            <Fact label="כיתה" value={intake.grade} />
            <Fact label="הקבצה" value={intake.levelUnits} />
            <Fact label="הערות הנציג/ה" value={intake.representativeNotes} />
          </dl>
        ) : (
          <EmptyNote text="עדיין לא תועדה שיחת קליטה." />
        )}
      </OverviewCard>

      <OverviewCard title="שאלון הורה">
        {intake ? (
          <dl className="space-y-1">
            <Fact label="מטרה לשנה" value={intake.parent.mainGoalYear} />
            <Fact label="ציון יעד" value={intake.parent.targetScore} />
            <Fact label="ממוצע נוכחי" value={intake.parent.averageScore} />
            <Fact label="מוטיבציה לדעת ההורה" value={intake.parent.motivationLevel} />
            <Fact label="הצלחה בעיני ההורה" value={intake.parent.successDefinition} />
            <Fact label="לקויות למידה" value={intake.parent.learningDisabilities} />
            <Fact label="קשיים רגשיים" value={intake.parent.emotionalDifficulties} />
            <Fact label="הערות" value={intake.parent.notes} />
          </dl>
        ) : (
          <EmptyNote text="אין תשובות הורה." />
        )}
      </OverviewCard>

      <OverviewCard title="שאלון תלמיד">
        {intake || diagnostic ? (
          <dl className="space-y-1">
            <Fact label="ציון אחרון" value={intake?.student.lastExamScore ?? diagnostic?.lastGrade} />
            <Fact label="מבחן קרוב" value={intake?.student.nextExamDate ? formatIsraelDay(intake.student.nextExamDate) : null} />
            <Fact label="שאיפות" value={intake?.student.mainGoals ?? diagnostic?.learningGoal} />
            <Fact label="יעד לחודש הראשון" value={intake?.student.firstMonthTarget} />
            <Fact label="נושא חזק" value={intake?.student.strongTopic} />
            <Fact label="קושי עיקרי" value={intake?.student.weakTopic ?? diagnostic?.challenge} />
            <Fact label="פערים שזוהו" value={diagnostic?.identifiedGaps.length ? diagnostic.identifiedGaps.join(", ") : null} />
            <Fact label="הערות" value={intake?.student.notes} />
          </dl>
        ) : (
          <EmptyNote text="התלמיד/ה עדיין לא מילא/ה שאלון." />
        )}
      </OverviewCard>

      <OverviewCard
        title="סיכום שיעור המיפוי"
        subtitle={mapping ? `${mapping.teacherName} · ${formatIsraelDay(mapping.createdAt)}` : null}
      >
        {mapping ? (
          <div className="space-y-2">
            {mapping.topicRanking.length > 0 && (
              <ol className="space-y-0.5 text-sm text-neutral-800">
                {mapping.topicRanking.map((topic) => (
                  <li key={topic.rank}>
                    {topic.rank}. {topic.topic}
                    {topic.score !== null && <span className="text-neutral-500"> · {topic.score}</span>}
                  </li>
                ))}
              </ol>
            )}
            <dl className="space-y-1">
              <Fact label="למידה בכיתה" value={mapping.classLearning} />
              <Fact label="למידה בבית" value={mapping.homeLearning} />
              <Fact label="מוטיבציה" value={mapping.motivation} />
              <Fact label="חיבור אישי" value={mapping.personalConnection} />
              <Fact label="התאמה לפורמט" value={mapping.formatFit} />
              <Fact label="המלצת המורה" value={mapping.subscriptionRecommendation} />
              <Fact label="הערות" value={mapping.additionalNotes} />
            </dl>
          </div>
        ) : (
          <EmptyNote
            text={
              mappingLesson
                ? `שיעור המיפוי עם ${mappingLesson.teacherName} עדיין לא סוכם.`
                : "עדיין לא התקיים שיעור מיפוי."
            }
          />
        )}
      </OverviewCard>
    </div>
  );
}

export default function PedagogicDecisionModal({ studentId, onClose, onSaved }: PedagogicDecisionModalProps) {
  const [overview, setOverview] = useState<PedagogicOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [background, setBackground] = useState("");
  const [personalNotes, setPersonalNotes] = useState("");
  const [learningNotes, setLearningNotes] = useState("");
  const [mainGoal, setMainGoal] = useState("");
  const [parentType, setParentType] = useState<ParentType>("מעורב");
  const [subscriptionType, setSubscriptionType] = useState<SubscriptionType>("WEEKLY");
  const [extraPrivateLessons, setExtraPrivateLessons] = useState<ExtraPrivateLessons>(0);
  const [managerInvolved, setManagerInvolved] = useState(false);
  const [teacherId, setTeacherId] = useState("");
  const [subject, setSubject] = useState(DEFAULT_MEETING_SUBJECT);
  const [slots, setSlots] = useState<WeeklySlot[]>(DEFAULT_SLOTS);
  const [startDate, setStartDate] = useState(() => israelDateKey(new Date(), 1));

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/pedagogic-decision`, {
          cache: "no-store",
        });
        const json = (await res.json().catch(() => ({ success: false }))) as OverviewResponse;
        if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "טעינת תמונת המצב נכשלה");
        if (cancelled) return;
        const data = json.data;
        setOverview(data);
        if (data.mapping?.mainGoal) setMainGoal(data.mapping.mainGoal);
        if (data.mapping?.subscriptionRecommendation === SUBSCRIPTION_TYPE_LABELS.TWICE_WEEKLY) {
          setSubscriptionType("TWICE_WEEKLY");
        }
        const mappingTeacher = data.mappingLesson?.teacherId;
        if (mappingTeacher && data.teachers.some((t) => t.id === mappingTeacher)) setTeacherId(mappingTeacher);
        const defaultSubject = data.mappingLesson?.subject || data.diagnostic?.subject;
        if (defaultSubject) setSubject(defaultSubject);
      } catch (loadFailure: unknown) {
        if (!cancelled) setLoadError(loadFailure instanceof Error ? loadFailure.message : "טעינת תמונת המצב נכשלה");
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

  const slotCount = SLOTS_PER_SUBSCRIPTION[subscriptionType];
  const activeSlots = slots.slice(0, slotCount);
  const lessonsInBatch = slotCount * RECURRING_WEEKS;

  const updateSlot = (index: number, patch: Partial<WeeklySlot>) => {
    setSlots((prev) => prev.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!mainGoal.trim()) {
      setError("יש לציין מטרה מרכזית");
      return;
    }
    if (!teacherId) {
      setError("יש לבחור מורה קבוע");
      return;
    }
    if (slotCount === 2 && activeSlots[0].weekday === activeSlots[1].weekday) {
      setError("שני המועדים צריכים להיות בימים שונים");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/pedagogic-decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          background,
          personalNotes,
          learningNotes,
          mainGoal,
          parentType,
          subscriptionType,
          extraPrivateLessons,
          professionalManagerInvolved: managerInvolved,
          teacherId,
          subject,
          slots: activeSlots,
          startDate,
        }),
      });
      const json = (await res.json().catch(() => ({ success: false }))) as DecisionResponse;
      if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "שמירת ההכרעה נכשלה");
      onSaved(json.data, json.whatsappDispatched === true);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "שמירת ההכרעה נכשלה");
      setSubmitting(false);
    }
  };

  const teachers = overview?.teachers ?? null;

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
        aria-labelledby="pedagogic-decision-title"
        className="liquid-glass rounded-3xl bg-white/90 w-full max-w-5xl max-h-[90vh] overflow-y-auto p-6"
      >
        <form onSubmit={submit} className="space-y-6">
          <div className="space-y-1">
            <h2 id="pedagogic-decision-title" className="text-lg font-semibold text-neutral-900">
              הכרעה פדגוגית ומנוי קבוע{overview ? ` · ${overview.studentName}` : ""}
            </h2>
            <p className="text-sm text-neutral-500">
              עברו על תמונת המצב, קבעו את תוכנית הלמידה, והשיעורים לחודש הקרוב ישובצו אוטומטית.
            </p>
          </div>

          {overview ? (
            <Overview360 overview={overview} />
          ) : loadError ? (
            <p role="alert" className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-800">
              {loadError}
            </p>
          ) : (
            <p className="text-sm text-neutral-500">טוענים את תמונת המצב...</p>
          )}

          <fieldset className="space-y-4 border-t border-neutral-100 pt-5" disabled={submitting || !overview}>
            <legend className="text-sm font-semibold text-neutral-900">סיכום שיחה לאחר מיפוי</legend>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-neutral-600">רקע</span>
                <textarea className={fieldClass} rows={2} maxLength={1000} value={background} onChange={(e) => setBackground(e.target.value)} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-neutral-600">דגשים אישיים</span>
                <textarea className={fieldClass} rows={2} maxLength={1000} value={personalNotes} onChange={(e) => setPersonalNotes(e.target.value)} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-neutral-600">דגשים לימודיים</span>
                <textarea className={fieldClass} rows={2} maxLength={1000} value={learningNotes} onChange={(e) => setLearningNotes(e.target.value)} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-neutral-600">מטרה מרכזית</span>
                <textarea className={fieldClass} rows={2} maxLength={1000} value={mainGoal} onChange={(e) => setMainGoal(e.target.value)} required />
              </label>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <PillGroup
                label="סוג הורה"
                options={PARENT_TYPES.map((type) => ({ value: type, label: type }))}
                value={parentType}
                onChange={setParentType}
                disabled={submitting}
              />
              <PillGroup
                label="סוג המנוי"
                options={SUBSCRIPTION_TYPES.map((type) => ({ value: type, label: SUBSCRIPTION_TYPE_LABELS[type] }))}
                value={subscriptionType}
                onChange={setSubscriptionType}
                disabled={submitting}
              />
              <PillGroup
                label="תוספת ש.פ"
                options={EXTRA_PRIVATE_LESSON_OPTIONS.map((n) => ({ value: n, label: n === 0 ? "אין" : String(n) }))}
                value={extraPrivateLessons}
                onChange={setExtraPrivateLessons}
                disabled={submitting}
              />
              <PillGroup
                label="מעורבות מנהל מקצועי"
                options={[
                  { value: true, label: "כן" },
                  { value: false, label: "לא" },
                ]}
                value={managerInvolved}
                onChange={setManagerInvolved}
                disabled={submitting}
              />
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-neutral-600">מורה קבוע</span>
                <select className={fieldClass} value={teacherId} onChange={(e) => setTeacherId(e.target.value)} required>
                  <option value="">{teachers === null ? "טוענים מורים..." : "בחירת מורה"}</option>
                  {teachers?.map((teacher) => (
                    <option key={teacher.id} value={teacher.id}>
                      {teacher.name}
                    </option>
                  ))}
                </select>
                {teachers?.length === 0 && (
                  <span className="block text-xs text-neutral-500">אין עדיין מורים מאושרים במערכת.</span>
                )}
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-neutral-600">מקצוע</span>
                <input className={fieldClass} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={80} required />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-neutral-600">תחילת הלימודים</span>
                <input
                  type="date"
                  className={fieldClass}
                  value={startDate}
                  min={israelDateKey(new Date())}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
              </label>
            </div>

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-neutral-600">
                {slotCount === 1 ? "מועד שבועי קבוע" : "שני מועדים שבועיים קבועים"}
              </span>
              <div className="grid gap-3 md:grid-cols-2">
                {activeSlots.map((slot, index) => (
                  <div key={index} className="grid grid-cols-2 gap-2">
                    <select
                      className={fieldClass}
                      aria-label={`יום ${index + 1}`}
                      value={slot.weekday}
                      onChange={(e) => updateSlot(index, { weekday: Number(e.target.value) })}
                    >
                      {WEEKDAY_OPTIONS.map((option) => (
                        <option key={option.weekday} value={option.weekday}>
                          יום {option.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className={fieldClass}
                      aria-label={`שעה ${index + 1}`}
                      value={slot.time}
                      onChange={(e) => updateSlot(index, { time: e.target.value })}
                    >
                      {WEEKLY_TIME_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <p className="text-xs text-neutral-500">
                ישובצו {lessonsInBatch} שיעורים ל-{RECURRING_WEEKS} השבועות הקרובים
                {extraPrivateLessons > 0 ? `, ועוד ${extraPrivateLessons} שיעורים פרטיים שממתינים לשיבוץ` : ""}.
              </p>
            </div>
          </fieldset>

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
              disabled={submitting || !overview || !teachers?.length}
            >
              {submitting && (
                <span
                  className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin"
                  aria-hidden="true"
                />
              )}
              {submitting ? "שומרים את ההכרעה ומשבצים שיעורים..." : "שמירת ההכרעה"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
