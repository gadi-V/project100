import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import {
  parseTeacherCandidateApplication,
  TEACHER_CANDIDATE_ACTION,
  TEACHER_CANDIDATE_ENTITY,
} from "../../../../lib/teacher-candidate";

/** Re-submissions from the same phone inside this window return the original application. */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || null;
}

/**
 * Public teacher job application (`/careers`).
 * Saved as an AuditLog row for management review. No User, TeacherProfile or session is created;
 * approved candidates are onboarded separately by an admin.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "גוף הבקשה אינו JSON תקין" }, { status: 400 });
  }

  const parsed = parseTeacherCandidateApplication(body);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  }
  const candidate = parsed.data;

  try {
    const existing = await prisma.auditLog.findFirst({
      where: {
        action: TEACHER_CANDIDATE_ACTION,
        entityType: TEACHER_CANDIDATE_ENTITY,
        entityId: candidate.phone,
        createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json({
        success: true,
        data: { applicationId: existing.id, duplicate: true },
      });
    }

    const application = await prisma.auditLog.create({
      data: {
        actorId: null,
        action: TEACHER_CANDIDATE_ACTION,
        entityType: TEACHER_CANDIDATE_ENTITY,
        entityId: candidate.phone,
        metadata: { ...candidate, status: "NEW", submittedAt: new Date().toISOString() },
        ipAddress: clientIp(request),
      },
      select: { id: true },
    });

    return NextResponse.json(
      { success: true, data: { applicationId: application.id, duplicate: false } },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error("Teacher candidate application error:", error);
    return NextResponse.json(
      { success: false, error: "שמירת המועמדות נכשלה. נסו שוב בעוד כמה דקות." },
      { status: 500 }
    );
  }
}
