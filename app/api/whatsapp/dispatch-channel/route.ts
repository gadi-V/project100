import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { requireAuthOrMonitor } from "../../../../lib/api-auth";
import {
  buildConversionMessage,
  createWhatsAppQuadGroup,
  determinePackageForGapDepth,
  sendQuadGroupInvite,
  sendWhatsAppText,
  type PackageSize,
} from "../../../../lib/whatsapp";
import { writeAuditLog } from "../../../../lib/audit";

/**
 * WhatsApp Dispatch Channel — בידול ערוצי WhatsApp (1 מול 4).
 *
 * ・ SINGLE (שיעור בודד): only transactional SMS/WhatsApp (reminder, link, PDF
 *    summary). No group is opened.
 * ・ TRIO / MULTI (3+ שיעורים): auto-open a dedicated Quad WhatsApp group
 *    (מנהל פדגוגי + מורה מומחה + תלמיד + הורה) and invite the parent.
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
              packageType === "SINGLE"
                ? "הודעות טרנזקציוניות בלבד — ללא פתיחת קבוצה"
                : "נפתחה קבוצת WhatsApp מרובעת ייעודית (מנהל פדגוגי + מורה + תלמיד + הורה)",
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

    if (packageType === "SINGLE") {
      // Single: transactional 1-on-1 only — never open a group.
      await sendWhatsAppText(studentPhone, conversionMessage);
    } else {
      // TRIO/MULTI (3+ lessons): auto-open dedicated Quad WhatsApp group
      // (Admin + Teacher + Student + Parent).
      if (!quadGroupUrl) {
        const manager = await prisma.user.findFirst({
          where: { role: { in: ["MANAGER", "ADMIN"] } },
          select: { name: true, phone: true },
          orderBy: { role: "desc" },
        });

        const created = await createWhatsAppQuadGroup({
          studentId: student.id,
          studentName,
          subject: "המקצוע שזוהה באבחון",
          teacherName: "מורה מומחה (ישובץ בהמשך)",
          members: [
            {
              role: "ADMIN",
              phone: manager?.phone || process.env.WHATSAPP_ADMIN_PHONE || "0000000000",
              name: manager?.name || "מנהל פדגוגי",
            },
            {
              role: "TEACHER",
              phone: process.env.WHATSAPP_TEACHER_PLACEHOLDER_PHONE || "0000000001",
              name: "מורה מומחה (ישובץ בהמשך)",
            },
            {
              role: "STUDENT",
              phone: studentPhone,
              name: studentName,
            },
            {
              role: "PARENT",
              phone: student.parentPhone || studentPhone,
              name: student.parentName || studentName,
            },
          ],
        });

        quadGroupUrl = created.inviteUrl;
        await prisma.user.update({
          where: { id: student.id },
          data: { quadGroupUrl },
        });
        isGroupOpened = true;
      }

      const recipientPhone = student.parentPhone || studentPhone;
      await sendQuadGroupInvite({
        recipientPhone,
        recipientName: student.parentName || studentName,
        studentName,
        teacherName: "מורה מומחה (ישובץ בהמשך)",
        groupUrl: quadGroupUrl,
      });
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
        recommendedPackage: recommendation.packageType,
        via: auth.via,
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        channel: packageType === "SINGLE" ? "TRANSACTIONAL_SINGLE" : "QUAD_GROUP",
        modeLabel:
          packageType === "SINGLE"
            ? "הודעות טרנזקציוניות בלבד — ללא פתיחת קבוצה"
            : "נפתחה קבוצת WhatsApp מרובעת ייעודית (מנהל פדגוגי + מורה + תלמיד + הורה)",
        isGroupOpened,
        quadGroupUrl,
        recommendedPackage: recommendation,
        messagePreview: conversionMessage.split("\n")[0],
      },
    });
  } catch (error: unknown) {
    console.error("[dispatch-channel] error:", error);
    return NextResponse.json(
      { success: false, error: "שגיאה בניתוב ערוץ ה-WhatsApp" },
      { status: 500 }
    );
  }
}
