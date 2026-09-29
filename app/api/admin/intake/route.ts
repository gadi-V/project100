import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { requireAuth } from "../../../../lib/api-auth";
import { writeAuditLog } from "../../../../lib/audit";
import { INTAKE_RECORDER_ROLES } from "../../../../lib/auth/staff-roles";
import { parseIntakeAssessment } from "../../../../lib/intake-assessment";

const LIST_LIMIT = 20;

/**
 * Records the mapping-call questionnaire (student + parent intake).
 * REPRESENTATIVE / ADMIN / MANAGER only. The representative is always the session user.
 */
export async function POST(request: Request) {
  const auth = await requireAuth(INTAKE_RECORDER_ROLES);
  if (auth.error) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "גוף הבקשה אינו JSON תקין" }, { status: 400 });
  }

  const parsed = parseIntakeAssessment(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { success: false, error: `השאלון לא נשמר: ${parsed.errors.join(" · ")}` },
      { status: 400 }
    );
  }
  const { studentId, fallbackLeadId, fields } = parsed.data;

  try {
    if (studentId) {
      const student = await prisma.user.findUnique({
        where: { id: studentId },
        select: { id: true, role: true },
      });
      if (!student || student.role !== "STUDENT") {
        return NextResponse.json({ success: false, error: "התלמיד לא נמצא" }, { status: 404 });
      }
    }

    if (fallbackLeadId) {
      const lead = await prisma.fallbackLead.findUnique({
        where: { id: fallbackLeadId },
        select: { id: true },
      });
      if (!lead) {
        return NextResponse.json({ success: false, error: "הליד לא נמצא" }, { status: 404 });
      }
    }

    const assessment = await prisma.intakeAssessment.create({
      data: {
        ...fields,
        studentId,
        fallbackLeadId,
        representativeId: auth.user.id,
      },
    });

    await writeAuditLog({
      actorId: auth.user.id,
      action: "INTAKE_ASSESSMENT_RECORDED",
      entityType: "IntakeAssessment",
      entityId: assessment.id,
      metadata: { studentId, fallbackLeadId },
    });

    return NextResponse.json({ success: true, data: assessment }, { status: 201 });
  } catch (error: unknown) {
    console.error("Intake assessment save error:", error);
    return NextResponse.json({ success: false, error: "שמירת השאלון נכשלה" }, { status: 500 });
  }
}

/** Latest intake assessments for one student (`?studentId=`) or lead (`?leadId=`). */
export async function GET(request: Request) {
  const auth = await requireAuth(INTAKE_RECORDER_ROLES);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const studentId = searchParams.get("studentId")?.trim() || null;
  const fallbackLeadId = searchParams.get("leadId")?.trim() || null;

  if (!studentId && !fallbackLeadId) {
    return NextResponse.json(
      { success: false, error: "יש לציין studentId או leadId" },
      { status: 400 }
    );
  }

  try {
    const assessments = await prisma.intakeAssessment.findMany({
      where: {
        ...(studentId ? { studentId } : {}),
        ...(fallbackLeadId ? { fallbackLeadId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
      include: { representative: { select: { id: true, name: true } } },
    });

    return NextResponse.json({ success: true, data: assessments });
  } catch (error: unknown) {
    console.error("Intake assessment list error:", error);
    return NextResponse.json({ success: false, error: "טעינת השאלונים נכשלה" }, { status: 500 });
  }
}
