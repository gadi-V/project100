import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { requireAuthOrMonitor } from "../../../../lib/api-auth";
import { writeAuditLog } from "../../../../lib/audit";
import { uploadLessonPdf } from "../../../../lib/storage";
import { sendLessonSummaryNotification } from "../../../../lib/whatsapp";
import { schedulePayoutInTransaction } from "../../../../lib/services/PayoutService";
import { writeLedgerEntryInTransaction } from "../../../../lib/services/LedgerService";

// ─── Financial split (ILS) — mirrors the single-credit price of 180 ₪ ───
/** Gross value credited to a completed lesson (SINGLE package = 200 ILS). */
const LESSON_VALUE_ILS = 200;
/** SaaS commission retained by the platform on each completed lesson. */
const PLATFORM_FEE_PERCENT = 0.3;
/** Net payout to the tutor after the platform share. */
const TUTOR_PAYOUT_PERCENT = 1 - PLATFORM_FEE_PERCENT;

function appBaseUrl(): string {
  return (
    process.env.APP_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    "https://app.project8.co.il"
  );
}

/** Strip contact fields so phones/emails are never returned to callers. */
function publicUser<T extends { phone?: string; email?: string | null }>(
  user: T
): Omit<T, "phone" | "email"> {
  const { phone: _phone, email: _email, ...safe } = user;
  return safe;
}

/** Server-side, locale-stable date render for summary copy (never client clocks). */
function formatLessonDate(date: Date): string {
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  }).format(date);
}

type CompletePayload = {
  lessonId: string;
  feedback: string | null;
  masteredTopics: string[];
  pdfFile: File | null;
  pdfUrlFromClient: string | null;
};

/**
 * Accept both FastMCP `application/json` and browser `multipart/form-data`.
 * Parses lessonId, feedback, masteredTopics consistently across content types.
 */
async function parseCompletePayload(request: Request): Promise<CompletePayload | { error: string }> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as {
      lessonId?: unknown;
      feedback?: unknown;
      masteredTopics?: unknown;
      pdfUrl?: unknown;
    };
    const lessonId = typeof body.lessonId === "string" ? body.lessonId.trim() : "";
    if (!lessonId) return { error: "lessonId is required" };

    const feedback =
      typeof body.feedback === "string" && body.feedback.trim()
        ? body.feedback.trim()
        : null;
    const masteredTopics = Array.isArray(body.masteredTopics)
      ? body.masteredTopics.filter((t): t is string => typeof t === "string" && t.trim() !== "")
      : [];
    const pdfUrlFromClient =
      typeof body.pdfUrl === "string" && body.pdfUrl.trim() ? body.pdfUrl.trim() : null;

    return { lessonId, feedback, masteredTopics, pdfFile: null, pdfUrlFromClient };
  }

  // Default / browser: multipart form-data (and legacy urlencoded).
  const formData = await request.formData();
  const lessonId = String(formData.get("lessonId") ?? "").trim();
  if (!lessonId) return { error: "lessonId is required" };

  const feedbackRaw = formData.get("feedback");
  const feedback =
    typeof feedbackRaw === "string" && feedbackRaw.trim() ? feedbackRaw.trim() : null;

  const masteredRaw = formData.get("masteredTopics");
  let masteredTopics: string[] = [];
  if (typeof masteredRaw === "string" && masteredRaw.trim()) {
    try {
      const parsed = JSON.parse(masteredRaw) as unknown;
      if (Array.isArray(parsed)) {
        masteredTopics = parsed.filter((t): t is string => typeof t === "string" && t.trim() !== "");
      } else {
        masteredTopics = masteredRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } catch {
      masteredTopics = masteredRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const pdfFile = formData.get("pdfFile");
  const pdfUrlRaw = formData.get("pdfUrl");
  return {
    lessonId,
    feedback,
    masteredTopics,
    pdfFile: pdfFile instanceof File ? pdfFile : null,
    pdfUrlFromClient:
      typeof pdfUrlRaw === "string" && pdfUrlRaw.trim() ? pdfUrlRaw.trim() : null,
  };
}

export async function POST(request: Request) {
  try {
    const auth = await requireAuthOrMonitor(request, ["TEACHER", "MANAGER", "ADMIN"]);
    if (auth.error) return auth.error;

    const parsed = await parseCompletePayload(request);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { lessonId, feedback, masteredTopics, pdfFile, pdfUrlFromClient } = parsed;

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: {
        id: true,
        teacherId: true,
        studentId: true,
        packageId: true,
        status: true,
        scheduledAt: true,
        durationMinutes: true,
      },
    });

    if (!lesson) {
      // FastMCP connectivity probes use reserved dry-run ids — auth/path OK, no DB writes.
      if (
        auth.via === "m2m" &&
        (lessonId.startsWith("dry-run") || lessonId === "connectivity-probe")
      ) {
        return NextResponse.json({
          success: true,
          dryRun: true,
          data: {
            message: "M2M connectivity OK — lesson complete endpoint reachable (no settle)",
            lessonId,
          },
        });
      }
      return NextResponse.json({ error: "השיעור לא נמצא" }, { status: 404 });
    }

    const isPrivileged =
      auth.via === "m2m" ||
      auth.user.role === "MANAGER" ||
      auth.user.role === "ADMIN";
    const isLessonTeacher =
      auth.user.role === "TEACHER" && lesson.teacherId === auth.user.id;

    if (!isPrivileged && !isLessonTeacher) {
      return NextResponse.json(
        { error: "אין לך הרשאה לסיים שיעור זה" },
        { status: 403 }
      );
    }

    // Idempotent: already completed — return success without re-sending
    // notifications or duplicating payouts.
    if (lesson.status === "COMPLETED") {
      const existing = await prisma.lesson.findUnique({
        where: { id: lessonId },
        include: { student: true, teacher: true },
      });
      if (!existing) {
        return NextResponse.json({ error: "השיעור לא נמצא" }, { status: 404 });
      }
      return NextResponse.json({
        success: true,
        data: {
          alreadyCompleted: true,
          message: "השיעור כבר סומן כהושלם.",
          lesson: {
            ...existing,
            student: publicUser(existing.student),
            teacher: publicUser(existing.teacher),
          },
        },
      });
    }

    // ── PDF resolution (isolated — never fails the financial transaction) ───────
    // Priority: pre-stored URL from export API → blob upload → null (no board).
    let uploadedPdfUrl: string | null = null;
    let pdfBuffer: Buffer | null = null;

    if (pdfUrlFromClient && pdfUrlFromClient.startsWith("http")) {
      // PDF was already uploaded to storage by /api/excalidraw/export — use URL directly.
      uploadedPdfUrl = pdfUrlFromClient;
    } else if (pdfFile) {
      pdfBuffer = Buffer.from(await pdfFile.arrayBuffer());
      try {
        uploadedPdfUrl = await uploadLessonPdf(lessonId, pdfBuffer);
      } catch (uploadError) {
        console.error("[complete] Board PDF upload failed (non-fatal):", uploadError);
        uploadedPdfUrl = null;
      }
    }

    // ── Financial constants ────────────────────────────────────────────────────
    const idempotencyKey = `lesson-payout-${lessonId}`;
    const platformFee = Math.round(LESSON_VALUE_ILS * PLATFORM_FEE_PERCENT);
    const tutorPayout = Math.round(LESSON_VALUE_ILS * TUTOR_PAYOUT_PERCENT);
    const completedAt = new Date();
    const periodStart = lesson.scheduledAt;
    const periodEnd = new Date(
      lesson.scheduledAt.getTime() + (lesson.durationMinutes ?? 60) * 60 * 1000
    );

    // ── Atomic transaction: status → COMPLETED + payout + platform fee ─────────
    // NOTE: schedulePayoutInTransaction already writes a PAYOUT BillingLedger
    // entry internally (transactionId = idempotencyKey). We only write the
    // separate PLATFORM_FEE entry here to avoid a unique-constraint collision.
    let finalized: { lessonId: string; payoutId: string; payoutAmount: number };
    try {
      finalized = await prisma.$transaction(async (tx) => {
        await tx.lesson.update({
          where: { id: lessonId },
          data: {
            status: "COMPLETED",
            endTime: completedAt,
            ...(uploadedPdfUrl ? { excalidrawPdfUrl: uploadedPdfUrl } : {}),
            ...(feedback ? { pedagogicalBrief: feedback } : {}),
          },
        });

        // masteredTopics → remove matched gaps from the package diagnostic (Hive / teacher).
        if (masteredTopics.length > 0 && lesson.packageId) {
          const quizzes = await tx.diagnosticQuiz.findMany({
            where: { packageId: lesson.packageId },
            select: { id: true, identifiedGaps: true },
          });
          for (const quiz of quizzes) {
            if (!quiz.identifiedGaps?.length) continue;
            const updatedGaps = quiz.identifiedGaps.filter(
              (gap) => !masteredTopics.includes(gap)
            );
            if (updatedGaps.length !== quiz.identifiedGaps.length) {
              await tx.diagnosticQuiz.update({
                where: { id: quiz.id },
                data: { identifiedGaps: updatedGaps },
              });
            }
          }
        }

        const payout = await schedulePayoutInTransaction(tx, {
          teacherId: lesson.teacherId,
          amount: tutorPayout,
          periodStart,
          periodEnd,
          idempotencyKey,
          lessonId,
          metadata: {
            type: "LESSON_COMPLETION",
            completedAt: completedAt.toISOString(),
            completedById: auth.actorId ?? auth.user.id,
            via: auth.via,
            feeSplit: { lessonValue: LESSON_VALUE_ILS, platformFee, tutorPayout },
            masteredTopics,
          },
        });

        // Platform fee — uses a distinct transactionId so it never collides with
        // the PAYOUT entry that PayoutService already wrote above.
        await writeLedgerEntryInTransaction(tx, {
          userId: lesson.teacherId,
          entryType: "PLATFORM_FEE",
          amount: platformFee,
          description: `עמלת פלטפורמה עבור השיעור ${lessonId}`,
          relatedId: payout.id,
          transactionId: `${idempotencyKey}-fee`,
          metadata: { lessonId, completedAt: completedAt.toISOString() },
        });

        await tx.auditLog.create({
          data: {
            actorId: auth.actorId,
            action: "LESSON_COMPLETED",
            entityType: "Lesson",
            entityId: lessonId,
            metadata: {
              pdfStored: Boolean(uploadedPdfUrl),
              payoutId: payout.id,
              payoutAmount: tutorPayout,
              platformFee,
              completedAt: completedAt.toISOString(),
              via: auth.via,
              masteredTopics,
              hasFeedback: Boolean(feedback),
            },
          },
        });

        return { lessonId, payoutId: payout.id, payoutAmount: tutorPayout };
      });
    } catch (txError: unknown) {
      console.error(
        "[complete] Financial transaction failed:",
        txError instanceof Error
          ? { message: txError.message, stack: txError.stack }
          : txError
      );
      return NextResponse.json(
        { error: "שגיאה בעדכון הנתונים הפיננסיים — השיעור לא סומן כהושלם" },
        { status: 500 }
      );
    }

    // ── Best-effort audit outside transaction (non-blocking) ──────────────────
    void writeAuditLog({
      actorId: auth.actorId,
      action: "LESSON_COMPLETED_POST",
      entityType: "Lesson",
      entityId: lessonId,
      metadata: { payoutId: finalized.payoutId, via: auth.via },
    }).catch((e: unknown) => console.error("[complete] Audit log failed:", e));

    const completedLesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { student: true, teacher: true },
    });

    if (!completedLesson) {
      return NextResponse.json({ error: "השיעור לא נמצא" }, { status: 404 });
    }

    const videoStreamingUrl = `${appBaseUrl()}/dashboard/lessons/${lessonId}/recording`;
    const pdfSecureUrl = uploadedPdfUrl ?? null;

    const lessonSummaryDetail: string =
      [
        `מקצוע: ${completedLesson.title ? completedLesson.title.trim() : "שיעור פרטי"}`,
        `מורה: ${completedLesson.teacher.name}`,
        `תלמיד/ה: ${completedLesson.student.name}`,
        `תאריך: ${formatLessonDate(completedLesson.scheduledAt)}`,
        `משך: ${completedLesson.durationMinutes ?? 60} דקות`,
      ].join("\n");

    const summaryRecipients = [
      { phone: completedLesson.student.phone, userName: completedLesson.student.name },
      { phone: completedLesson.teacher.phone, userName: completedLesson.teacher.name },
    ];

    /**
     * Fire-and-forget: lesson completion must never be blocked (or rolled back)
     * by a failing third-party notification channel.
     */
    void (async () => {
      const results = await Promise.allSettled(
        summaryRecipients.map((r) =>
          sendLessonSummaryNotification({
            phone: r.phone,
            userName: r.userName,
            pdfBuffer,
            pdfSecureUrl,
            videoStreamingUrl,
            lessonSummary: lessonSummaryDetail,
          })
        )
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        console.error(
          `[complete] WhatsApp summary: ${failed}/${results.length} notifications failed`
        );
      }
    })().catch((e) => console.error("[complete] WhatsApp dispatch error:", e));

    return NextResponse.json({
      success: true,
      data: {
        message: "השיעור הסתיים, הנתונים נשמרו והודעות הווטסאפ נשלחו.",
        lesson: {
          ...completedLesson,
          student: publicUser(completedLesson.student),
          teacher: publicUser(completedLesson.teacher),
        },
        payout: {
          id: finalized.payoutId,
          amount: finalized.payoutAmount,
          status: "SCHEDULED",
        },
      },
    });
  } catch (error: unknown) {
    console.error(
      "[complete] Unhandled error:",
      error instanceof Error ? { message: error.message, stack: error.stack } : error
    );
    return NextResponse.json({ error: "שגיאה פנימית בסיום השיעור" }, { status: 500 });
  }
}
