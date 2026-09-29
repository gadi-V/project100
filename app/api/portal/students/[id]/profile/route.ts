import { NextResponse } from "next/server";
import { prisma } from "../../../../../../lib/prisma";
import { requireAuth } from "../../../../../../lib/api-auth";
import { writeAuditLog } from "../../../../../../lib/audit";
import { INTAKE_RECORDER_ROLES } from "../../../../../../lib/auth/staff-roles";
import { resolveStudentAccess } from "../../../../../../lib/student-portal";
import {
  parseStudentProfileFields,
  parseStudentStatuses,
  type StudentProfileFields,
  type StudentStatusCode,
} from "../../../../../../lib/student-portal-shared";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Updates the student's CRM card: status checkboxes (`studentStatus`) and/or profile fields (`fields`).
 * REPRESENTATIVE / ADMIN / MANAGER only.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const auth = await requireAuth(INTAKE_RECORDER_ROLES);
  if (auth.error) return auth.error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "גוף הבקשה אינו JSON תקין" }, { status: 400 });
  }
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  const errors: string[] = [];
  let statuses: StudentStatusCode[] | undefined;
  let fields: Partial<StudentProfileFields> = {};

  if ("studentStatus" in record) {
    const parsed = parseStudentStatuses(record.studentStatus);
    if (parsed.ok) statuses = parsed.data;
    else errors.push(...parsed.errors);
  }
  if ("fields" in record) {
    const parsed = parseStudentProfileFields(record.fields);
    if (parsed.ok) fields = parsed.data;
    else errors.push(...parsed.errors);
  }
  if (errors.length === 0 && statuses === undefined && Object.keys(fields).length === 0) {
    errors.push("אין מה לעדכן");
  }
  if (errors.length > 0) {
    return NextResponse.json({ success: false, error: `הפרופיל לא נשמר: ${errors.join(" · ")}` }, { status: 400 });
  }

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) {
      return NextResponse.json({ success: false, error: "התלמיד לא נמצא" }, { status: 404 });
    }

    const { birthDate, ...textFields } = fields;
    const data = {
      ...textFields,
      ...(birthDate !== undefined ? { birthDate: birthDate ? new Date(`${birthDate}T00:00:00Z`) : null } : {}),
      ...(statuses !== undefined
        ? { studentStatus: statuses, statusUpdatedAt: new Date(), statusUpdatedById: auth.user.id }
        : {}),
    };

    const profile = await prisma.studentProfile.upsert({
      where: { userId: id },
      create: { userId: id, ...data },
      update: data,
    });

    await writeAuditLog({
      actorId: auth.user.id,
      action: "STUDENT_PROFILE_UPDATED",
      entityType: "StudentProfile",
      entityId: profile.id,
      metadata: {
        studentId: id,
        updatedFields: Object.keys(fields),
        ...(statuses !== undefined ? { studentStatus: statuses } : {}),
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        studentStatus: profile.studentStatus,
        statusUpdatedAt: profile.statusUpdatedAt?.toISOString() ?? null,
      },
    });
  } catch (error: unknown) {
    console.error("Student profile update error:", error);
    return NextResponse.json({ success: false, error: "שמירת הפרופיל נכשלה" }, { status: 500 });
  }
}
