import { redirect } from "next/navigation";
import { getCurrentUser } from "../../../lib/session";
import { isStaffPortalRole } from "../../../lib/auth/staff-roles";
import { parseStudentDirectoryQuery } from "../../../lib/student-directory-shared";
import { pageCanvas } from "../../../lib/ui";
import PortalHeader from "../../../components/portal/PortalHeader";
import StudentDirectory from "../../../components/portal/StudentDirectory";

export const dynamic = "force-dynamic";

type StudentsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function toUrlParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, item);
  }
  return params;
}

/**
 * Customer / student directory for the staff portal. Representatives and managers see every student,
 * teachers only their own (enforced by `GET /api/portal/students`); everyone else goes to the staff gate.
 */
export default async function StudentsDirectoryPage({ searchParams }: StudentsPageProps) {
  const user = await getCurrentUser();
  if (!user || !isStaffPortalRole(user.role)) redirect("/portal/login");

  const parsed = parseStudentDirectoryQuery(toUrlParams(await searchParams));
  const initial = parsed.ok ? parsed.data : null;

  return (
    <>
      <PortalHeader userName={user.name} role={user.role} />
      <main className={`${pageCanvas} relative z-10 py-10 px-6`} dir="rtl">
        <div className="max-w-6xl mx-auto">
          <StudentDirectory
            initialSearch={initial?.search ?? ""}
            initialStatus={initial?.statuses[0] ?? null}
            initialGrade={initial?.grade ?? null}
            initialPage={initial?.page ?? 1}
            isTeacher={user.role === "TEACHER"}
          />
        </div>
      </main>
    </>
  );
}
