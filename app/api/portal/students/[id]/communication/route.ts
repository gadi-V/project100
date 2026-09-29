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
  type CommunicationStructuredData,
  type CommunicationType,
} from "../../../../../../lib/communication-templates";
import { listCommunicationEntries, resolveStudentAccess } from "../../../../../../lib/student-portal";
import {
  sendQuadGroupCommunicationSummary,
  type QuadCommunicationSummaryInput,
} from "../../../../../../lib/whatsapp";

type RouteContext = { params: Promise<{ id: string }> };

const ACCESS_ERRORS = { 403: "אין לך גישה לתלמיד הזה", 404: "התלמיד לא נמצא" } as const;

/** Summary types posted to the student's quad WhatsApp group. */
const GROUP_SUMMARY_TYPES = new Set<CommunicationType>(["LESSON_SUMMARY", "MAPPING_SUMMARY"]);

/** `sendToWhatsApp` is optional and defaults to true; anything but a boolean is rejected. */
function readSendToWhatsApp(body: unknown): boolean | null {
  const value = (body as Record<string, unknown>).sendToWhatsApp;
  if (value === undefined) return true;
  return typeof value === "boolean" ? value : null;
}

function textField(structuredData: CommunicationStructuredData | null, key: string): string | null {
  const value = structuredData?.fields[key];
  return typeof value === "string" ? value : null;
}

function groupSummaryInput(
  type: CommunicationType,
  studentName: string,
  structuredData: CommunicationStructuredData | null
): QuadCommunicationSummaryInput | null {
  if (type === "MAPPING_SUMMARY") return { type, studentName };
  const workedOn = textField(structuredData, "workedOn");
  if (type !== "LESSON_SUMMARY" || !workedOn) return null;
  return {
    type,
    workedOn,
    homework: textField(structuredData, "homework"),
    nextLesson: textField(structuredData, "nextLesson"),
  };
}

/** Posts the saved summary to the student's quad group. Failures are logged, never thrown. */
async function dispatchSummaryToGroup(
  studentId: string,
  input: QuadCommunicationSummaryInput
): Promise<boolean> {
  try {
    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { whatsappGroupId: true },
    });
    const groupId = student?.whatsappGroupId?.trim();
    if (!groupId) return false;
    const result = await sendQuadGroupCommunicationSummary(groupId, input);
    if (!result.sent) console.error("Lesson summary WhatsApp dispatch failed:", result.error);
    return result.sent;
  } catch (error: unknown) {
    console.error("Lesson summary WhatsApp dispatch error:", error);
    return false;
  }
}

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
 * Lesson and mapping summaries are also posted to the student's quad WhatsApp group unless
 * `sendToWhatsApp: false`; a failed post is logged and reported as `whatsappDispatched: false`.
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

  const sendToWhatsApp = readSendToWhatsApp(body);
  if (sendToWhatsApp === null) {
    return NextResponse.json(
      { success: false, error: "הסיכום לא נשמר: ערך השליחה לוואטסאפ אינו תקין" },
      { status: 400 }
    );
  }

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

    const summaryInput =
      sendToWhatsApp && GROUP_SUMMARY_TYPES.has(type)
        ? groupSummaryInput(type, access.student.name, structuredData)
        : null;
    const whatsappDispatched = summaryInput ? await dispatchSummaryToGroup(id, summaryInput) : false;

    await writeAuditLog({
      actorId: auth.user.id,
      action: "STUDENT_COMMUNICATION_LOGGED",
      entityType: "StudentCommunicationLog",
      entityId: log.id,
      metadata: { studentId: id, type, authorRole, courseContext, sendToWhatsApp, whatsappDispatched },
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
        whatsappDispatched,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error("Student communication save error:", error);
    return NextResponse.json({ success: false, error: "שמירת הסיכום נכשלה" }, { status: 500 });
  }
}
