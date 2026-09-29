import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "../../../../lib/session";
import { isStaffPortalRole } from "../../../../lib/auth/staff-roles";
import { loadStudentPortal, resolveStudentAccess } from "../../../../lib/student-portal";
import { formatIsraelDay, isStudentTabKey } from "../../../../lib/student-portal-shared";
import { eyebrow, frostCard, pageCanvas } from "../../../../lib/ui";
import PortalHeader from "../../PortalHeader";
import StudentPortalTabs from "../../../../components/portal/student/StudentPortalTabs";

export const dynamic = "force-dynamic";

type StudentPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
};

/**
 * Student CRM screen shared by representatives, pedagogic managers and teachers.
 * Teachers only reach students they teach; everyone else outside the staff roles goes to the staff gate.
 */
export default async function StudentPortalPage({ params, searchParams }: StudentPageProps) {
  const user = await getCurrentUser();
  if (!user || !isStaffPortalRole(user.role)) redirect("/portal/login");

  const { id } = await params;
  const access = await resolveStudentAccess(user, id);
  if (!access.ok) notFound();

  const data = await loadStudentPortal(id, user);
  if (!data) notFound();

  const rawTab = (await searchParams).tab;
  const requestedTab = Array.isArray(rawTab) ? rawTab[0] : rawTab;
  const initialTab = isStudentTabKey(requestedTab) ? requestedTab : "profile";

  return (
    <>
      <PortalHeader userName={user.name} isAdmin={user.role === "ADMIN" || user.role === "MANAGER"} />
      <main className={`${pageCanvas} relative z-10 py-10 px-6`} dir="rtl">
        <div className="max-w-6xl mx-auto space-y-6">
          <section className={`${frostCard} p-6 flex flex-col sm:flex-row sm:items-end justify-between gap-3`}>
            <div className="min-w-0">
              <span className={`${eyebrow} block mb-1`}>תיק תלמיד</span>
              <h1 className="text-2xl font-semibold text-neutral-900 truncate">{data.header.name}</h1>
            </div>
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-500">
              <div className="flex gap-1">
                <dt>מזהה:</dt>
                <dd className="font-mono text-neutral-700" dir="ltr">
                  {data.header.id}
                </dd>
              </div>
              <div className="flex gap-1">
                <dt>הצטרף/ה:</dt>
                <dd className="text-neutral-700">{formatIsraelDay(data.header.createdAt)}</dd>
              </div>
            </dl>
          </section>

          <StudentPortalTabs data={data} initialTab={initialTab} />
        </div>
      </main>
    </>
  );
}
