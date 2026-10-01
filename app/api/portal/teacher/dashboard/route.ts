import { NextResponse } from "next/server";
import { requireAuth } from "../../../../../lib/api-auth";
import { listTeacherOptions } from "../../../../../lib/student-portal";
import { findDashboardTeacher, loadTeacherDashboard } from "../../../../../lib/teacher-dashboard";
import {
  TEACHER_DASHBOARD_ROLES,
  type TeacherDashboardResponse,
} from "../../../../../lib/teacher-dashboard-shared";

const NO_STORE = { "Cache-Control": "no-store" };

function failure(error: string, status: number) {
  return NextResponse.json<TeacherDashboardResponse>({ success: false, error }, { status, headers: NO_STORE });
}

/**
 * Teacher cockpit data: upcoming lessons (7 days), completed lessons still missing a summary (14 days)
 * and the current Israel calendar month (lessons, hours, accrued PAYOUT ledger total).
 * A TEACHER always gets their own cockpit; `teacherId` is ignored for them. ADMIN / MANAGER pick a teacher
 * with `?teacherId=` and also receive the teacher list.
 */
export async function GET(request: Request) {
  const auth = await requireAuth(TEACHER_DASHBOARD_ROLES);
  if (auth.error) return auth.error;
  const viewer = auth.user;

  try {
    if (viewer.role === "TEACHER") {
      const data = await loadTeacherDashboard({ id: viewer.id, name: viewer.name }, viewer);
      return NextResponse.json<TeacherDashboardResponse>({ success: true, data, teachers: null }, { headers: NO_STORE });
    }

    const teachers = await listTeacherOptions();
    const teacherId = new URL(request.url).searchParams.get("teacherId")?.trim();
    if (!teacherId) {
      return NextResponse.json<TeacherDashboardResponse>({ success: true, data: null, teachers }, { headers: NO_STORE });
    }

    const teacher = await findDashboardTeacher(teacherId);
    if (!teacher) return failure("המורה לא נמצא", 404);
    const data = await loadTeacherDashboard(teacher, viewer);
    return NextResponse.json<TeacherDashboardResponse>({ success: true, data, teachers }, { headers: NO_STORE });
  } catch (error: unknown) {
    console.error("Teacher dashboard error:", error);
    return failure("טעינת מרחב המורה נכשלה", 500);
  }
}
