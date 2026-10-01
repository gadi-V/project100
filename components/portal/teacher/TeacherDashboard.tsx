"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CalendarClock, Clock, FileText, Wallet } from "lucide-react";
import CompleteLessonModal from "../student/CompleteLessonModal";
import { portalAfterCompletionHref, type CompleteLessonResponse } from "../../../lib/lesson-completion";
import { formatIls, formatIsraelDay, lessonRoomHref, type TeacherOption } from "../../../lib/student-portal-shared";
import {
  teacherDashboardEndpoint,
  type CockpitLesson,
  type TeacherDashboardData,
  type TeacherDashboardResponse,
} from "../../../lib/teacher-dashboard-shared";
import { badgeNeutral, badgeWarning, emptyState, eyebrow, fieldClass, frostCard, frostPanel, primaryCta, secondaryCta } from "../../../lib/ui";

type TeacherDashboardProps = {
  /** TEACHER sees their own cockpit; ADMIN / MANAGER pick a teacher. */
  viewerRole: string;
  viewerName: string;
  initialTeacherId?: string | null;
  /** Server-provided first payload; the component fetches it itself when absent. */
  initialData?: TeacherDashboardData | null;
  initialTeachers?: TeacherOption[] | null;
};

const lessonTime = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false });
const lessonDay = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long", day: "numeric", month: "numeric" });

function lessonWhen(lesson: CockpitLesson): string {
  const start = new Date(lesson.scheduledAt);
  const range = `${lessonTime.format(start)}–${lessonTime.format(new Date(lesson.endsAt))}`;
  return lesson.isToday ? `היום · ${range}` : `${lessonDay.format(start)} · ${range}`;
}

function lessonBadge(lesson: CockpitLesson): string | null {
  if (lesson.status === "IN_PROGRESS") return "השיעור מתקיים עכשיו";
  if (lesson.canComplete) return "השיעור התחיל";
  return null;
}

function formatHours(hours: number): string {
  return hours.toLocaleString("he-IL", { maximumFractionDigits: 1 });
}

function KpiCard({
  label,
  value,
  hint,
  icon,
  warning = false,
}: {
  label: string;
  value: string;
  hint: string;
  icon: ReactNode;
  warning?: boolean;
}) {
  return (
    <section
      className={`${frostCard} p-5 space-y-2 ${warning ? "ring-2 ring-amber-300 bg-amber-50/80" : ""}`}
      data-kpi={label}
      data-warning={warning ? "true" : "false"}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`${eyebrow} block`}>{label}</span>
        <span className={warning ? "text-amber-600" : "text-neutral-400"}>{icon}</span>
      </div>
      <p className={`text-3xl font-semibold tabular-nums ${warning ? "text-amber-700" : "text-neutral-900"}`}>{value}</p>
      <p className="text-xs text-neutral-500">{hint}</p>
    </section>
  );
}

export default function TeacherDashboard({
  viewerRole,
  viewerName,
  initialTeacherId = null,
  initialData = null,
  initialTeachers = null,
}: TeacherDashboardProps) {
  const router = useRouter();
  const isTeacher = viewerRole === "TEACHER";
  const [teacherId, setTeacherId] = useState<string | null>(isTeacher ? null : initialTeacherId);
  const [data, setData] = useState<TeacherDashboardData | null>(initialData);
  const [teachers, setTeachers] = useState<TeacherOption[] | null>(initialTeachers);
  const [loading, setLoading] = useState(initialData === null);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState<CockpitLesson | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (id: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(teacherDashboardEndpoint(id), { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as TeacherDashboardResponse | null;
      if (!response.ok || !body || !body.success) {
        setError(body && !body.success ? body.error : "טעינת מרחב המורה נכשלה");
        return;
      }
      setData(body.data);
      setTeachers(body.teachers);
    } catch {
      setError("טעינת מרחב המורה נכשלה. בדקו את החיבור ונסו שוב");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialData === null) void load(isTeacher ? null : initialTeacherId);
  }, [initialData, initialTeacherId, isTeacher, load]);

  const pickTeacher = (id: string) => {
    const next = id || null;
    setTeacherId(next);
    setData(null);
    window.history.replaceState(
      null,
      "",
      next ? `/portal/dashboard?view=teacher&teacherId=${encodeURIComponent(next)}` : "/portal/dashboard?view=teacher"
    );
    void load(next);
  };

  const onCompleted = (lesson: CockpitLesson, result: CompleteLessonResponse) => {
    setCompleting(null);
    if (result.promptSummary) {
      router.push(portalAfterCompletionHref(lesson.studentId, lesson.id, result));
      return;
    }
    setNotice(
      result.status === "CANCELLED"
        ? `השיעור של ${lesson.studentName} סומן כבוטל ולא ירד מיתרת התלמיד`
        : `השיעור של ${lesson.studentName} נסגר. החיסור נרשם בתיק התלמיד`
    );
    void load(teacherId);
  };

  const pending = data?.pendingSummaries ?? [];
  const earnings = data?.earnings;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <section className={`${frostCard} p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4`}>
        <div>
          <span className={`${eyebrow} block mb-1`}>{isTeacher ? "מרחב המורה" : "תצוגת מורה"}</span>
          <h1 className="text-2xl font-semibold text-neutral-900">
            {isTeacher ? `שלום, ${viewerName}` : data ? `מרחב העבודה של ${data.teacher.name}` : "בחירת מורה"}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!isTeacher && (
            <label className="flex items-center gap-2 text-sm text-neutral-600">
              <span>מורה</span>
              <select
                className={`${fieldClass} min-w-48`}
                value={teacherId ?? ""}
                onChange={(event) => pickTeacher(event.target.value)}
                aria-label="בחירת מורה"
              >
                <option value="">בחרו מורה</option>
                {(teachers ?? []).map((teacher) => (
                  <option key={teacher.id} value={teacher.id}>
                    {teacher.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Link href="/portal/students" className={secondaryCta}>
            {isTeacher ? "התלמידים שלי" : "לקוחות"}
          </Link>
          {isTeacher ? (
            <Link href="/dashboard" className={secondaryCta}>
              יומן וזמינות
            </Link>
          ) : (
            <Link href="/portal/dashboard" className={secondaryCta}>
              חזרה ללוח הנציגים
            </Link>
          )}
        </div>
      </section>

      {error && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" className={secondaryCta} onClick={() => void load(teacherId)}>
            נסו שוב
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      {!data ? (
        <div className={emptyState}>
          <p className="text-sm text-neutral-600">
            {loading ? "טוען את מרחב המורה…" : !isTeacher && !teacherId ? "בחרו מורה כדי לראות את השיעורים, הסיכומים והשכר שלו" : "אין נתונים להצגה"}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              label="שיעורים להיום / השבוע"
              value={`${data.todayCount} / ${data.weekCount}`}
              hint="שיעורים פתוחים מהיום ועד שבעה ימים קדימה"
              icon={<CalendarClock className="h-5 w-5" aria-hidden />}
            />
            <KpiCard
              label="סיכומים ממתינים להזנה"
              value={String(pending.length)}
              hint={pending.length > 0 ? "שיעורים מהשבועיים האחרונים שעדיין אין להם סיכום" : "כל הסיכומים מהשבועיים האחרונים הוזנו"}
              icon={<AlertTriangle className="h-5 w-5" aria-hidden />}
              warning={pending.length > 0}
            />
            <KpiCard
              label="שעות שבוצעו החודש"
              value={formatHours(earnings?.hoursTaught ?? 0)}
              hint={`${earnings?.completedLessons ?? 0} שיעורים שהושלמו ב${earnings?.monthLabel ?? "חודש הנוכחי"}${earnings?.noShowLessons ? `, מתוכם ${earnings.noShowLessons} שהתלמיד לא הגיע אליהם` : ""}`}
              icon={<Clock className="h-5 w-5" aria-hidden />}
            />
            <KpiCard
              label="צפי שכר חודשי צבור (₪)"
              value={formatIls(earnings?.accruedPayoutIls ?? 0)}
              hint="סכום התשלומים שנרשמו למורה בחודש הנוכחי, לפני העברה בפועל"
              icon={<Wallet className="h-5 w-5" aria-hidden />}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <section className={`${frostPanel} overflow-hidden lg:col-span-2`} aria-labelledby="upcoming-title">
              <h2 id="upcoming-title" className="px-5 py-4 text-sm font-semibold text-neutral-900 border-b border-neutral-100">
                השיעורים הקרובים
              </h2>
              {data.upcoming.length === 0 ? (
                <div className={`${emptyState} m-5`}>
                  <p className="text-sm text-neutral-600">אין שיעורים בשבעת הימים הקרובים.</p>
                </div>
              ) : (
                <ul>
                  {data.upcoming.map((lesson) => {
                    const badge = lessonBadge(lesson);
                    return (
                      <li key={lesson.id} className="px-5 py-4 border-b border-neutral-100 last:border-b-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3" data-lesson-id={lesson.id}>
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link
                              href={`/portal/students/${encodeURIComponent(lesson.studentId)}`}
                              className="text-sm font-medium text-neutral-900 hover:underline underline-offset-4"
                            >
                              {lesson.studentName}
                            </Link>
                            {badge && <span className={badgeWarning}>{badge}</span>}
                            {lesson.isMakeup && <span className={badgeNeutral}>שיעור השלמה</span>}
                            {lesson.lessonType === "MAPPING" && <span className={badgeNeutral}>שיעור מיפוי</span>}
                          </div>
                          <p className="text-xs text-neutral-500 truncate">
                            {lesson.grade ? `כיתה ${lesson.grade} · ` : ""}
                            {lesson.subject}
                          </p>
                          <p className="text-xs text-neutral-500 tabular-nums">{lessonWhen(lesson)}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          {lesson.canEnterRoom && (
                            <Link href={lessonRoomHref(lesson.id)} className={secondaryCta}>
                              היכנס לשיעור
                            </Link>
                          )}
                          {lesson.canComplete && (
                            <button type="button" className={primaryCta} onClick={() => setCompleting(lesson)}>
                              סיום שיעור ונוכחות
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className={`${frostPanel} overflow-hidden`} aria-labelledby="tasks-title">
              <h2 id="tasks-title" className="px-5 py-4 text-sm font-semibold text-neutral-900 border-b border-neutral-100 flex items-center justify-between gap-2">
                <span>משימות לטיפול מהיר</span>
                {pending.length > 0 && <span className={badgeWarning}>{pending.length}</span>}
              </h2>
              {pending.length === 0 ? (
                <div className={`${emptyState} m-5`}>
                  <p className="text-sm text-neutral-600">אין סיכומי שיעור שממתינים להזנה.</p>
                </div>
              ) : (
                <ul>
                  {pending.map((task) => (
                    <li key={task.lessonId} className="px-5 py-4 border-b border-neutral-100 last:border-b-0 space-y-2" data-pending-lesson={task.lessonId}>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-neutral-900 truncate">{task.studentName}</p>
                        <p className="text-xs text-neutral-500 truncate">
                          {task.subject} · {formatIsraelDay(task.scheduledAt)}
                        </p>
                      </div>
                      <Link href={task.summaryHref} className={`${secondaryCta} inline-flex items-center gap-1.5`}>
                        <FileText className="h-4 w-4" aria-hidden />
                        {task.summaryType === "MAPPING_SUMMARY" ? "הזן סיכום מיפוי" : "הזן סיכום שיעור"}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}

      {completing && (
        <CompleteLessonModal
          studentId={completing.studentId}
          meeting={{
            id: completing.id,
            title: completing.subject,
            scheduledAt: completing.scheduledAt,
            teacherName: data?.teacher.name ?? null,
          }}
          onClose={() => setCompleting(null)}
          onDone={(result) => onCompleted(completing, result)}
        />
      )}
    </div>
  );
}
