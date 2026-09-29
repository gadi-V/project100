import { NextResponse } from "next/server";
import { prisma } from "../../../../../../lib/prisma";
import { requireAuth } from "../../../../../../lib/api-auth";
import { writeAuditLog } from "../../../../../../lib/audit";
import { isIntakeRecorderRole } from "../../../../../../lib/auth/staff-roles";
import { isCancelledLessonStatus, resolveStudentAccess } from "../../../../../../lib/student-portal";
import { parseAttendanceInput } from "../../../../../../lib/student-portal-shared";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Marks a started, non-cancelled lesson as PRESENT / ABSENT. Only the lesson's teacher or
 * REPRESENTATIVE / ADMIN / MANAGER. Does not change `Lesson.status`, payouts or credits.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await requireAuth(["TEACHER", "REPRESENTATIVE", "ADMIN", "MANAGER"]);
  if (auth.error) return auth.error;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "גוף הבקשה אינו JSON תקין" }, { status: 400 });
  }
  const parsed = parseAttendanceInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.errors.join(" · ") }, { status: 400 });
  }
  const { lessonId, status } = parsed.data;

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) {
      return NextResponse.json({ success: false, error: "התלמיד לא נמצא" }, { status: access.status });
    }

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, studentId: true, teacherId: true, status: true, scheduledAt: true, startTime: true },
    });
    if (!lesson || lesson.studentId !== id) {
      return NextResponse.json({ success: false, error: "המפגש לא נמצא" }, { status: 404 });
    }
    if (!isIntakeRecorderRole(auth.user.role) && lesson.teacherId !== auth.user.id) {
      return NextResponse.json({ success: false, error: "רק המורה של המפגש יכול לסמן נוכחות" }, { status: 403 });
    }
    if (isCancelledLessonStatus(lesson.status)) {
      return NextResponse.json({ success: false, error: "המפגש בוטל" }, { status: 409 });
    }
    if ((lesson.startTime ?? lesson.scheduledAt) > new Date()) {
      return NextResponse.json({ success: false, error: "אפשר לסמן נוכחות רק אחרי תחילת המפגש" }, { status: 409 });
    }

    const updated = await prisma.lesson.update({
      where: { id: lessonId },
      data: { attendanceStatus: status, attendanceMarkedAt: new Date(), attendanceMarkedById: auth.user.id },
      select: { id: true, attendanceStatus: true, attendanceMarkedAt: true },
    });

    await writeAuditLog({
      actorId: auth.user.id,
      action: "LESSON_ATTENDANCE_MARKED",
      entityType: "Lesson",
      entityId: lessonId,
      metadata: { studentId: id, status },
    });

    return NextResponse.json({
      success: true,
      data: {
        lessonId: updated.id,
        attendanceStatus: updated.attendanceStatus,
        attendanceMarkedAt: updated.attendanceMarkedAt?.toISOString() ?? null,
      },
    });
  } catch (error: unknown) {
    console.error("Lesson attendance error:", error);
    return NextResponse.json({ success: false, error: "סימון הנוכחות נכשל" }, { status: 500 });
  }
}
