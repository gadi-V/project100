import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../../../lib/session";
import { isIntakeRecorderRole } from "../../../lib/auth/staff-roles";
import {
  countPendingIntakes,
  getPendingIntakeCandidates,
  getRecentIntakes,
  type IntakeCandidate,
} from "../../../lib/intake-queue";
import { formatIsraelDate, INTAKE_KIND_LABELS } from "../../../lib/intake-form";
import {
  badgeNeutral,
  dataRow,
  emptyState,
  eyebrow,
  frostCard,
  frostPanel,
  pageCanvas,
  primaryCta,
  secondaryCta,
} from "../../../lib/ui";
import PortalHeader from "../../../components/portal/PortalHeader";
import TeacherDashboard from "../../../components/portal/teacher/TeacherDashboard";

export const dynamic = "force-dynamic";

const PENDING_PREVIEW = 5;

type SearchParams = Record<string, string | string[] | undefined>;

function intakeHref(candidate: IntakeCandidate): string {
  const param = candidate.kind === "STUDENT" ? "studentId" : "leadId";
  return `/portal/intake?${param}=${encodeURIComponent(candidate.id)}`;
}

function firstParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() || null;
}

/**
 * Staff dashboard. Approved teachers get their cockpit (lessons, missing summaries, monthly pay);
 * teachers still in onboarding stay on `/dashboard`. Representatives and admins get the mapping-call
 * queue, and ADMIN / MANAGER can switch to any teacher's cockpit with `?view=teacher&teacherId=`.
 * Every other role is sent back to the staff gate.
 */
export default async function StaffDashboardPage({ searchParams }: { searchParams?: Promise<SearchParams> } = {}) {
  const user = await getCurrentUser();
  if (!user) redirect("/portal/login");

  if (user.role === "TEACHER") {
    if (!user.isApproved) redirect("/dashboard");
    return (
      <>
        <PortalHeader userName={user.name} role={user.role} />
        <main className={`${pageCanvas} relative z-10 py-10 px-6`} dir="rtl">
          <TeacherDashboard viewerRole={user.role} viewerName={user.name} />
        </main>
      </>
    );
  }
  if (!isIntakeRecorderRole(user.role)) redirect("/portal/login");

  const isAdmin = user.role === "ADMIN" || user.role === "MANAGER";
  const params: SearchParams = (await searchParams) ?? {};
  if (isAdmin && firstParam(params.view) === "teacher") {
    return (
      <>
        <PortalHeader userName={user.name} role={user.role} />
        <main className={`${pageCanvas} relative z-10 py-10 px-6`} dir="rtl">
          <TeacherDashboard viewerRole={user.role} viewerName={user.name} initialTeacherId={firstParam(params.teacherId)} />
        </main>
      </>
    );
  }

  const [counts, pending, recent] = await Promise.all([
    countPendingIntakes(),
    getPendingIntakeCandidates(),
    getRecentIntakes(),
  ]);

  return (
    <>
      <PortalHeader userName={user.name} role={user.role} />
      <main className={`${pageCanvas} relative z-10 py-10 px-6`} dir="rtl">
        <div className="max-w-6xl mx-auto space-y-8">
          <section className={`${frostCard} p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4`}>
            <div>
              <span className={`${eyebrow} block mb-1`}>
                {isAdmin ? "ניהול שיחות מיפוי" : "שיחות מיפוי"}
              </span>
              <h1 className="text-2xl font-semibold text-neutral-900">שלום, {user.name}</h1>
            </div>
            <div className="flex items-center gap-3">
              {isAdmin && (
                <>
                  <Link href="/portal/dashboard?view=teacher" className={secondaryCta}>
                    תצוגת מורה
                  </Link>
                  <Link href="/admin" className={secondaryCta}>
                    לוח ניהול
                  </Link>
                </>
              )}
              <Link href="/portal/intake" className={primaryCta}>
                התחל שיחת מיפוי חדשה
              </Link>
            </div>
          </section>

          <section className={`${frostCard} p-6 space-y-1`} aria-labelledby="pending-count">
            <span className={`${eyebrow} block`}>ממתינים לשיחת מיפוי</span>
            <p id="pending-count" className="text-5xl font-semibold text-neutral-900 tabular-nums">
              {counts.total}
            </p>
            <p className="text-sm text-neutral-500">
              {counts.leads} לידים מהאתר · {counts.students} תלמידים חדשים
            </p>
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className={`${frostPanel} overflow-hidden`} aria-labelledby="pending-title">
              <h2 id="pending-title" className="px-5 py-4 text-sm font-semibold text-neutral-900 border-b border-neutral-100">
                הבאים בתור
              </h2>
              {pending.length === 0 ? (
                <div className={`${emptyState} m-5`}>
                  <p className="text-sm text-neutral-600">אין כרגע לידים שממתינים לשיחה.</p>
                </div>
              ) : (
                <ul>
                  {pending.slice(0, PENDING_PREVIEW).map((candidate) => (
                    <li key={`${candidate.kind}:${candidate.id}`} className={dataRow}>
                      <Link href={intakeHref(candidate)} className="flex items-center justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-neutral-900 truncate">
                            {candidate.name}
                          </span>
                          <span className="block text-xs text-neutral-500" dir="ltr">
                            {candidate.phone}
                          </span>
                        </span>
                        <span className="flex flex-col items-end gap-1 shrink-0">
                          <span className={badgeNeutral}>{INTAKE_KIND_LABELS[candidate.kind]}</span>
                          <span className="text-xs text-neutral-400">{formatIsraelDate(candidate.createdAt)}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={`${frostPanel} overflow-hidden`} aria-labelledby="recent-title">
              <h2 id="recent-title" className="px-5 py-4 text-sm font-semibold text-neutral-900 border-b border-neutral-100">
                שאלונים אחרונים
              </h2>
              {recent.length === 0 ? (
                <div className={`${emptyState} m-5`}>
                  <p className="text-sm text-neutral-600">עדיין לא נשמרו שאלוני מיפוי.</p>
                </div>
              ) : (
                <ul>
                  {recent.map((intake) => (
                    <li key={intake.id} className={`${dataRow} flex items-center justify-between gap-3`}>
                      <span className="min-w-0">
                        {intake.studentId ? (
                          <Link
                            href={`/portal/students/${encodeURIComponent(intake.studentId)}`}
                            className="block text-sm font-medium text-neutral-900 truncate hover:underline underline-offset-4"
                          >
                            {intake.personName}
                          </Link>
                        ) : (
                          <span className="block text-sm font-medium text-neutral-900 truncate">
                            {intake.personName}
                          </span>
                        )}
                        <span className="block text-xs text-neutral-500 truncate">
                          כיתה {intake.grade} · נושא חלש: {intake.weakTopic}
                        </span>
                      </span>
                      <span className="flex flex-col items-end gap-1 shrink-0 text-xs text-neutral-400">
                        <span>{formatIsraelDate(intake.createdAt)}</span>
                        {intake.representativeName && <span>{intake.representativeName}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
