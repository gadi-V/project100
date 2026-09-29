import { NextResponse } from "next/server";
import { prisma } from "../../../../../../lib/prisma";
import { requireAuth } from "../../../../../../lib/api-auth";
import { writeAuditLog } from "../../../../../../lib/audit";
import {
  canWriteCommunicationType,
  COMMUNICATION_AUTHOR_ROLES,
  COMMUNICATION_TYPE_LABELS,
  parseCommunicationInput,
  toCommunicationAuthorRole,
} from "../../../../../../lib/communication-templates";
import { listCommunicationEntries, resolveStudentAccess } from "../../../../../../lib/student-portal";

type RouteContext = { params: Promise<{ id: string }> };

const ACCESS_ERRORS = { 403: "אין לך גישה לתלמיד הזה", 404: "התלמיד לא נמצא" } as const;

/** Communication history of one student, newest first. */
export async function GET(_request: Request, { params }: RouteContext) {
  const auth = await requireAuth(COMMUNICATION_AUTHOR_ROLES);
  if (auth.error) return auth.error;
  const { id } = await params;

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) {
      return NextResponse.json({ success: false, error: ACCESS_ERRORS[access.status] }, { status: access.status });
    }
    const entries = await listCommunicationEntries(id);
    return NextResponse.json({ success: true, data: entries });
  } catch (error: unknown) {
    console.error("Student communication list error:", error);
    return NextResponse.json({ success: false, error: "טעינת ההיסטוריה נכשלה" }, { status: 500 });
  }
}

/**
 * Saves a summary / message. TEACHER, REPRESENTATIVE, ADMIN, MANAGER only; each summary type has
 * its own role list (`COMMUNICATION_TYPE_ROLES`). Author fields come from the session.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await requireAuth(COMMUNICATION_AUTHOR_ROLES);
  if (auth.error) return auth.error;
  const { id } = await params;

  const authorRole = toCommunicationAuthorRole(auth.user.role);
  if (!authorRole) {
    return NextResponse.json({ success: false, error: "אין לך הרשאה לפעולה זו" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "גוף הבקשה אינו JSON תקין" }, { status: 400 });
  }

  const parsed = parseCommunicationInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { success: false, error: `הסיכום לא נשמר: ${parsed.errors.join(" · ")}` },
      { status: 400 }
    );
  }
  const { type, content, courseContext, structuredData } = parsed.data;

  if (!canWriteCommunicationType(auth.user.role, type)) {
    return NextResponse.json(
      { success: false, error: `אין לך הרשאה לשמור ${COMMUNICATION_TYPE_LABELS[type]}` },
      { status: 403 }
    );
  }

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) {
      return NextResponse.json({ success: false, error: ACCESS_ERRORS[access.status] }, { status: access.status });
    }

    const log = await prisma.studentCommunicationLog.create({
      data: {
        studentId: id,
        authorId: auth.user.id,
        authorName: auth.user.name,
        authorRole,
        type,
        courseContext,
        content,
        structuredData: structuredData ?? undefined,
      },
    });

    await writeAuditLog({
      actorId: auth.user.id,
      action: "STUDENT_COMMUNICATION_LOGGED",
      entityType: "StudentCommunicationLog",
      entityId: log.id,
      metadata: { studentId: id, type, authorRole, courseContext },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          id: log.id,
          createdAt: log.createdAt.toISOString(),
          type,
          courseContext: log.courseContext,
          authorName: log.authorName,
          authorRole,
          content: log.content,
        },
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error("Student communication save error:", error);
    return NextResponse.json({ success: false, error: "שמירת הסיכום נכשלה" }, { status: 500 });
  }
}
