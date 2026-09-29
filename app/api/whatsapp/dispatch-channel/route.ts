import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { requireAuthOrMonitor } from "../../../../lib/api-auth";
import {
  buildConversionMessage,
  createWhatsAppQuadGroup,
  determinePackageForGapDepth,
  sendWhatsAppText,
  type PackageSize,
  type QuadGroupErrorCode,
} from "../../../../lib/whatsapp";
import { writeAuditLog } from "../../../../lib/audit";

/**
 * WhatsApp Dispatch Channel — בידול ערוצי WhatsApp (1 מול 4).
 *
 * ・ SINGLE (שיעור בודד): only transactional SMS/WhatsApp (reminder, link, PDF
 *    summary). No group is opened.
 * ・ TRIO / MULTI (3+ שיעורים): open a live Quad WhatsApp group (student +
 *    teacher + parent when known + WHATSAPP_ADMIN_PHONE) once the student has a
 *    scheduled lesson with an assigned teacher, post the welcome message, and
 *    store the group chat id on `User.whatsappGroupId`. Until then the group
 *    is reported as pending; an existing group is never opened twice.
 *
 * Also generates the automatic conversion message from the diagnosis depth:
 * ・ פער קל (1–2 נושאים)  → TRIO.
 * ・ פער עמוק (3+ נושאים) → MULTI.
 *
 * Auth: session cookie (ADMIN/MANAGER/STUDENT) OR
 * `Authorization: Bearer HIVE_MONITOR_SECRET` (FastMCP M2M).
 *
 * Reaction-surface only: never returns student/teacher phone numbers.
 */
type GroupStatus = "NOT_APPLICABLE" | "EXISTING" | "OPENED" | "PENDING_TEACHER_ASSIGNMENT" | "FAILED";

const GROUP_MODE_LABELS: Record<GroupStatus, string> = {
  NOT_APPLICABLE: "הודעות טרנזקציוניות בלבד — ללא פתיחת קבוצה",
  EXISTING: "קבוצת הוואטסאפ כבר פתוחה",
  OPENED: "קבוצת הוואטסאפ נפתחה",
  PENDING_TEACHER_ASSIGNMENT: "קבוצת הוואטסאפ תיפתח לאחר שיבוץ מורה ושיעור ראשון",
  FAILED: "פתיחת קבוצת הוואטסאפ נכשלה",
};

function statusForGroupError(code: QuadGroupErrorCode): number {
  if (code === "NOT_CONFIGURED") return 503;
  if (code === "MISSING_REQUIRED_PARTICIPANT") return 422;
  return 502;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthOrMonitor(request, ["ADMIN", "MANAGER", "STUDENT"]);
    if (auth.error) return auth.error;

    const body = (await request.json()) as {
      packageType?: unknown;
      studentPhone?: unknown;
      studentName?: unknown;
      gapTopicsCount?: unknown;
      gapTopicsNames?: unknown;
      purpose?: unknown;
      studentId?: unknown;
    };

    const packageType = (body.packageType ?? "").toString().toUpperCase() as PackageSize;
    if (!["SINGLE", "TRIO", "MULTI", "TEN"].includes(packageType)) {
      return NextResponse.json(
        { success: false, error: "packageType חייב להיות SINGLE, TRIO, MULTI או TEN" },
        { status: 400 }
      );
    }

    const gapCount =
      typeof body.gapTopicsCount === "number"
        ? body.gapTopicsCount
        : typeof body.gapTopicsCount === "string" && body.gapTopicsCount !== ""
          ? Number(body.gapTopicsCount)
          : 0;

    const bodyPhone =
      typeof body.studentPhone === "string" && body.studentPhone.trim()
        ? body.studentPhone.trim()
        : "";
    const bodyStudentId =
      typeof body.studentId === "string" && body.studentId.trim()
        ? body.studentId.trim()
        : "";

    // Session: act on the authenticated user. M2M: resolve student by phone/id from body.
    let student: {
      id: string;
      name: string;
      phone: string;
      parentName: string | null;
      parentPhone: string | null;
      quadGroupUrl: string | null;
      whatsappGroupId: string | null;
      role: string;
    } | null = null;

    if (auth.via === "m2m") {
      if (bodyStudentId) {
        student = await prisma.user.findUnique({
          where: { id: bodyStudentId },
          select: {
            id: true,
            name: true,
            phone: true,
            parentName: true,
            parentPhone: true,
            quadGroupUrl: true,
            whatsappGroupId: true,
            role: true,
          },
        });
      } else if (bodyPhone) {
        student = await prisma.user.findFirst({
          where: { phone: bodyPhone },
          select: {
            id: true,
            name: true,
            phone: true,
            parentName: true,
            parentPhone: true,
            quadGroupUrl: true,
            whatsappGroupId: true,
            role: true,
          },
        });
      }

      // Hive conversion probe with no matching student: analysis-only dry-run (no send).
      if (!student) {
        const recommendation = determinePackageForGapDepth(gapCount);
        const studentName =
          typeof body.studentName === "string" && body.studentName.trim()
            ? body.studentName.trim()
            : "תלמיד";
        const conversionMessage = buildConversionMessage({
          studentName,
          subject: "המקצוע שזוהה באבחון",
          gapTopicsCount: gapCount,
          gapTopicsNames: Array.isArray(body.gapTopicsNames)
            ? (body.gapTopicsNames as string[]).filter((n): n is string => typeof n === "string")
            : [],
          estimatedScore: null,
        });
        return NextResponse.json({
          success: true,
          dryRun: true,
          data: {
            channel: packageType === "SINGLE" ? "TRANSACTIONAL_SINGLE" : "QUAD_GROUP",
            modeLabel:
              GROUP_MODE_LABELS[
                packageType === "SINGLE" ? "NOT_APPLICABLE" : "PENDING_TEACHER_ASSIGNMENT"
              ],
            isGroupOpened: false,
            quadGroupUrl: null,
            recommendedPackage: recommendation,
            messagePreview: conversionMessage.split("\n")[0],
          },
        });
      }
    } else {
      student = await prisma.user.findUnique({
        where: { id: auth.user.id },
        select: {
          id: true,
          name: true,
          phone: true,
          parentName: true,
          parentPhone: true,
          quadGroupUrl: true,
          whatsappGroupId: true,
          role: true,
        },
      });
    }

    if (!student) {
      return NextResponse.json({ success: false, error: "משתמש לא נמצא" }, { status: 404 });
    }

    const studentName =
      typeof body.studentName === "string" && body.studentName.trim()
        ? body.studentName.trim()
        : student.name;
    const studentPhone = bodyPhone || student.phone;

    // 1) Conversion message from gap depth (recommended package + call to action).
    const recommendation = determinePackageForGapDepth(gapCount);
    const conversionMessage = buildConversionMessage({
      studentName,
      subject: "המקצוע שזוהה באבחון",
      gapTopicsCount: gapCount,
      gapTopicsNames:
        Array.isArray(body.gapTopicsNames)
          ? (body.gapTopicsNames as string[]).filter((n): n is string => typeof n === "string")
          : [],
      estimatedScore: null,
    });

    // 2) Single ⇄ Quad routing decision.
    let quadGroupUrl = student.quadGroupUrl ?? null;
    let isGroupOpened = false;
    let groupStatus: GroupStatus = "NOT_APPLICABLE";
    let groupErrorCode: QuadGroupErrorCode | null = null;

    if (packageType === "SINGLE") {
      // Single: transactional 1-on-1 only — never open a group.
      await sendWhatsAppText(studentPhone, conversionMessage);
    } else if (student.whatsappGroupId) {
      groupStatus = "EXISTING";
    } else {
      const lesson = await prisma.lesson.findFirst({
        where: { studentId: student.id, status: "SCHEDULED", scheduledAt: { gte: new Date() } },
        orderBy: { scheduledAt: "asc" },
        select: {
          id: true,
          title: true,
          scheduledAt: true,
          durationMinutes: true,
          teacher: { select: { id: true, name: true, phone: true } },
        },
      });

      if (!lesson) {
        groupStatus = "PENDING_TEACHER_ASSIGNMENT";
      } else {
        const latestDiagnostic = await prisma.diagnosticQuiz.findFirst({
          where: { studentId: student.id },
          orderBy: { createdAt: "desc" },
          select: { subject: true },
        });

        // Members come from the DB only — body-supplied phones never join a group.
        const created = await createWhatsAppQuadGroup({
          student: { name: student.name, phone: student.phone },
          teacher: { name: lesson.teacher.name, phone: lesson.teacher.phone },
          parent: student.parentPhone
            ? { name: student.parentName ?? undefined, phone: student.parentPhone }
            : undefined,
          lesson: {
            scheduledAt: lesson.scheduledAt,
            durationMinutes: lesson.durationMinutes ?? 60,
            subject: latestDiagnostic?.subject || lesson.title || undefined,
          },
        });

        if (created.ok) {
          // A gateway without invite links yields null, which also clears stale placeholder links.
          quadGroupUrl = created.inviteUrl;
          await prisma.user.update({
            where: { id: student.id },
            data: { whatsappGroupId: created.chatId, quadGroupUrl },
          });
          isGroupOpened = true;
          groupStatus = "OPENED";

          await writeAuditLog({
            actorId: auth.actorId,
            action: "WHATSAPP_QUAD_GROUP_CREATED",
            entityType: "User",
            entityId: student.id,
            metadata: {
              chatId: created.chatId,
              groupName: created.groupName,
              lessonId: lesson.id,
              teacherId: lesson.teacher.id,
              roles: created.participants.map((p) => p.role),
              droppedRoles: created.droppedRoles,
              welcomeSent: created.welcome.sent,
              welcomeMessageId: created.welcome.sent ? created.welcome.messageId : null,
              welcomeError: created.welcome.sent ? null : created.welcome.error,
              via: auth.via,
            },
          });
        } else {
          groupStatus = "FAILED";
          groupErrorCode = created.error.code;
          console.error(
            `[dispatch-channel] quad group for ${student.id} failed (${created.error.code}): ${created.error.message}`
          );
        }
      }
    }

    await writeAuditLog({
      actorId: auth.actorId,
      action: "WHATSAPP_DISPATCH_CHANNEL",
      entityType: "User",
      entityId: student.id,
      metadata: {
        packageType,
        gapTopicsCount: gapCount,
        mode: packageType === "SINGLE" ? "TRANSACTIONAL_SINGLE" : "QUAD_GROUP",
        isGroupOpened,
        groupStatus,
        groupErrorCode,
        recommendedPackage: recommendation.packageType,
        via: auth.via,
      },
    });

    const data = {
      channel: packageType === "SINGLE" ? "TRANSACTIONAL_SINGLE" : "QUAD_GROUP",
      modeLabel: GROUP_MODE_LABELS[groupStatus],
      isGroupOpened,
      groupStatus,
      quadGroupUrl,
      recommendedPackage: recommendation,
      messagePreview: conversionMessage.split("\n")[0],
    };

    if (groupErrorCode) {
      return NextResponse.json(
        { success: false, error: GROUP_MODE_LABELS.FAILED, data: { ...data, errorCode: groupErrorCode } },
        { status: statusForGroupError(groupErrorCode) }
      );
    }

    return NextResponse.json({ success: true, data });
  } catch (error: unknown) {
    console.error("[dispatch-channel] error:", error);
    return NextResponse.json(
      { success: false, error: "שגיאה בניתוב ערוץ ה-WhatsApp" },
      { status: 500 }
    );
  }
}
