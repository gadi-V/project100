import { NextRequest, NextResponse } from "next/server";
import { dispatchWhatsAppCloser } from "../../../../lib/whatsapp";
import { requireAuth } from "../../../../lib/api-auth";
import { writeAuditLog } from "../../../../lib/audit";

/**
 * WhatsApp Closer — exposición of the funnel-closing engine as an HTTP route.
 *
 * 1. Auth: STUDENT / ADMIN / MANAGER (the funnel is initiated by the student,
 *    or by staff on behalf of the student).
 * 2. Calls `dispatchWhatsAppCloser` which runs the gap analysis (spec 1.9),
 *    derives the recommended package + credits, and opens the Quad group for
 *    TRIO/MULTI (transactional-only for SINGLE).
 * 3. Returns the structured analysis + dispatch summary.
 *
 * Additive-only: does not touch the existing /api/whatsapp/dispatch-channel.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(["STUDENT", "ADMIN", "MANAGER"]);
    if (auth.error) return auth.error;

    const body = await request.json().catch(() => ({})) as {
      studentId?: unknown;
      studentName?: unknown;
      studentPhone?: unknown;
      parentPhone?: unknown;
      trackName?: unknown;
      identifiedGaps?: unknown;
      packageType?: unknown;
      teacherName?: unknown;
    };

    const studentId =
      typeof body.studentId === "string" && body.studentId.trim()
        ? body.studentId.trim()
        : auth.user.id;
    const studentName =
      typeof body.studentName === "string" && body.studentName.trim()
        ? body.studentName.trim()
        : auth.user.name;
    const studentPhone =
      typeof body.studentPhone === "string" && body.studentPhone.trim()
        ? body.studentPhone.trim()
        : null;
    const parentPhone =
      typeof body.parentPhone === "string" && body.parentPhone.trim()
        ? body.parentPhone.trim()
        : null;
    const trackName =
      typeof body.trackName === "string" && body.trackName.trim()
        ? body.trackName.trim()
        : "מתמטיקה";
    const teacherName =
      typeof body.teacherName === "string" && body.teacherName.trim()
        ? body.teacherName.trim()
        : null;

    const rawGaps = body.identifiedGaps;
    const identifiedGaps: string[] = Array.isArray(rawGaps)
      ? rawGaps.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
      : typeof rawGaps === "string" && rawGaps.trim()
        ? [rawGaps.trim()]
        : [];

    if (!studentPhone && !parentPhone) {
      return NextResponse.json(
        { error: "Missing required fields: studentPhone or parentPhone" },
        { status: 400 }
      );
    }
    if (identifiedGaps.length === 0) {
      return NextResponse.json(
        { error: "Missing required fields: identifiedGaps" },
        { status: 400 }
      );
    }

    const packageTypeRaw = body.packageType;
    const packageType =
      packageTypeRaw === "TRIO" || packageTypeRaw === "MULTI"
        ? packageTypeRaw
        : undefined;

    const result = await dispatchWhatsAppCloser({
      studentId,
      studentName,
      studentPhone,
      parentPhone,
      trackName,
      identifiedGaps,
      packageType,
      teacherName,
      recipientPhone: parentPhone || studentPhone || "",
      recipientName: studentName,
      portalUrl: `${request.nextUrl.origin}/onboarding/diagnostic`,
    });

    // Best-effort audit trail (never fails the request).
    void writeAuditLog({
      actorId: auth.user.id,
      action: "WHATSAPP_CLOSER_TRIGGERED",
      entityType: "User",
      entityId: studentId,
      metadata: {
        trackName,
        gapsCount: result.analysis.gapsCount,
        recommendedPackage: result.analysis.recommendedPackage,
        creditsCount: result.analysis.creditsCount,
        channel: result.channel,
        isGroupOpened: result.dispatch?.isGroupOpened ?? result.isGroupOpened,
        dispatchError: result.dispatchError ?? null,
      },
    });

    return NextResponse.json({
      success: true,
      analysis: result.analysis,
      dispatch: result.dispatch,
    });
  } catch (error: unknown) {
    console.error(
      "WhatsApp Closer API Error:",
      error instanceof Error ? error.message : "unknown"
    );
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}