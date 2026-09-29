import { redirect } from "next/navigation";
import { getCurrentUser } from "../../../lib/session";
import { isIntakeRecorderRole } from "../../../lib/auth/staff-roles";
import {
  getIntakeCandidate,
  getPendingIntakeCandidates,
  type IntakeCandidate,
  type IntakeCandidateKind,
} from "../../../lib/intake-queue";
import { pageCanvas } from "../../../lib/ui";
import PortalHeader from "../../../components/portal/PortalHeader";
import IntakeWorkspace from "./IntakeWorkspace";

export const dynamic = "force-dynamic";

type IntakeSearchParams = {
  leadId?: string | string[];
  studentId?: string | string[];
};

function firstParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() || null;
}

async function resolveInitialCandidate(
  params: IntakeSearchParams,
  pending: IntakeCandidate[]
): Promise<IntakeCandidate | null> {
  const studentId = firstParam(params.studentId);
  const leadId = firstParam(params.leadId);
  const id = studentId ?? leadId;
  if (!id) return null;
  const kind: IntakeCandidateKind = studentId ? "STUDENT" : "LEAD";
  return pending.find((c) => c.kind === kind && c.id === id) ?? (await getIntakeCandidate(kind, id));
}

/** Mapping-call workspace. REPRESENTATIVE / ADMIN / MANAGER only; everyone else goes to the staff gate. */
export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<IntakeSearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user || !isIntakeRecorderRole(user.role)) redirect("/portal/login");

  const pending = await getPendingIntakeCandidates();
  const initial = await resolveInitialCandidate(await searchParams, pending);
  const candidates =
    initial && !pending.some((c) => c.kind === initial.kind && c.id === initial.id)
      ? [initial, ...pending]
      : pending;

  return (
    <>
      <PortalHeader userName={user.name} role={user.role} />
      <main className={`${pageCanvas} relative z-10 py-10 px-6`} dir="rtl">
        <IntakeWorkspace
          candidates={candidates}
          initialKey={initial ? `${initial.kind}:${initial.id}` : null}
        />
      </main>
    </>
  );
}
