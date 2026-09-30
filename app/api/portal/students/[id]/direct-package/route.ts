import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../../../lib/prisma";
import { requireAuth } from "../../../../../../lib/api-auth";
import { writeAuditLog } from "../../../../../../lib/audit";
import { ENROLLMENT_DECISION_ROLES } from "../../../../../../lib/auth/staff-roles";
import { toCommunicationAuthorRole } from "../../../../../../lib/communication-templates";
import { markStudentActive, resolveStudentAccess } from "../../../../../../lib/student-portal";
import {
  findDirectPackage,
  parseDirectPackageInput,
  type DirectPackageResult,
  type DirectPackageStructuredData,
} from "../../../../../../lib/pedagogic-decision";

type RouteContext = { params: Promise<{ id: string }> };

const ACCESS_ERRORS = { 403: "אין לך גישה לתלמיד הזה", 404: "התלמיד לא נמצא" } as const;

/**
 * Direct package track for independent students: adds the package's lessons to `lessonCredits`, sets the
 * active "תלמיד" status and records the package on the communication log, with no mapping lesson required.
 * MANAGER / ADMIN / REPRESENTATIVE only. Writes no Payment or ledger row; billing is handled separately.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await requireAuth(ENROLLMENT_DECISION_ROLES);
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
  const parsed = parseDirectPackageInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { success: false, error: `החבילה לא שויכה: ${parsed.errors.join(" · ")}` },
      { status: 400 }
    );
  }
  const input = parsed.data;
  const pkg = findDirectPackage(input.packageCode);
  if (!pkg) {
    return NextResponse.json({ success: false, error: "החבילה לא נמצאה" }, { status: 400 });
  }

  try {
    const access = await resolveStudentAccess(auth.user, id);
    if (!access.ok) {
      return NextResponse.json({ success: false, error: ACCESS_ERRORS[access.status] }, { status: access.status });
    }

    let preferredTeacher: { id: string; name: string } | null = null;
    if (input.preferredTeacherId) {
      const teacher = await prisma.user.findUnique({
        where: { id: input.preferredTeacherId },
        select: { id: true, name: true, role: true, isApproved: true },
      });
      if (!teacher || teacher.role !== "TEACHER" || !teacher.isApproved) {
        return NextResponse.json({ success: false, error: "המורה המועדף לא נמצא או שאינו פעיל" }, { status: 404 });
      }
      preferredTeacher = { id: teacher.id, name: teacher.name };
    }

    const structuredData: DirectPackageStructuredData = {
      source: "DIRECT_PACKAGE",
      package: {
        packageCode: pkg.code,
        packageName: pkg.name,
        credits: pkg.credits,
        subject: input.subject,
        preferredTeacherName: preferredTeacher?.name ?? null,
      },
    };
    const content = [
      `שויכה ${pkg.name} (${pkg.credits} שיעורים)`,
      `מקצוע: ${input.subject}`,
      ...(preferredTeacher ? [`מורה מועדף: ${preferredTeacher.name}`] : []),
    ].join("\n");

    const saved = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { lessonCredits: { increment: pkg.credits } },
        select: { lessonCredits: true },
      });
      const log = await tx.studentCommunicationLog.create({
        data: {
          studentId: id,
          authorId: auth.user.id,
          authorName: auth.user.name,
          authorRole,
          type: "GENERAL",
          courseContext: input.subject,
          content,
          structuredData: structuredData as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      const studentStatus = await markStudentActive(tx, id, auth.user.id);
      return { logId: log.id, lessonCredits: updated.lessonCredits, studentStatus };
    });

    await writeAuditLog({
      actorId: auth.user.id,
      action: "DIRECT_PACKAGE_ASSIGNED",
      entityType: "User",
      entityId: id,
      metadata: {
        packageCode: pkg.code,
        packageName: pkg.name,
        creditsAdded: pkg.credits,
        lessonCredits: saved.lessonCredits,
        subject: input.subject,
        preferredTeacherId: preferredTeacher?.id ?? null,
        logId: saved.logId,
        studentStatus: saved.studentStatus,
      },
    });

    const data: DirectPackageResult = {
      logId: saved.logId,
      packageName: pkg.name,
      creditsAdded: pkg.credits,
      lessonCredits: saved.lessonCredits,
      studentStatus: saved.studentStatus,
    };
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error: unknown) {
    console.error("Direct package assignment error:", error);
    return NextResponse.json({ success: false, error: "שיוך החבילה נכשל" }, { status: 500 });
  }
}
