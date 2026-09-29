import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { verifyCronRequest } from "../../../../lib/auth/cron";
import { sendLessonReminderNotification } from "../../../../lib/whatsapp";

const REMINDER_LOOKAHEAD_MS = 20 * 60 * 1000;

/**
 * Cron endpoint: sends WhatsApp reminders for lessons starting within the next
 * 20 minutes that have not been reminded yet. Triggered every 5 minutes by the
 * QStash schedule on /api/cron/reminders (alias of this route).
 * Protected by Authorization: Bearer <CRON_SECRET> or a verified QStash
 * signature (lib/auth/cron.ts).
 */
export async function GET(request: Request) {
  if (!(await verifyCronRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();
    const lookaheadEnd = new Date(now.getTime() + REMINDER_LOOKAHEAD_MS);

    // Open lower bound + reminderSent flag: a late or skipped run never leaves a gap between windows.
    const upcomingLessons = await prisma.lesson.findMany({
      where: {
        scheduledAt: {
          gt: now,
          lte: lookaheadEnd,
        },
        reminderSent: false,
        status: "SCHEDULED",
      },
      select: {
        id: true,
        title: true,
        scheduledAt: true,
        student: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
        teacher: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
    });

    if (upcomingLessons.length === 0) {
      return NextResponse.json({ success: true, sent: 0 });
    }

    const results = await Promise.allSettled(
      upcomingLessons.map(async (lesson) => {
        console.log(`[Cron] Sending reminder for lesson ${lesson.id}`);

        await Promise.all([
          sendLessonReminderNotification({
            phone: lesson.student.phone,
            recipientName: lesson.student.name,
            lessonId: lesson.id,
            startTime: lesson.scheduledAt,
          }),
          sendLessonReminderNotification({
            phone: lesson.teacher.phone,
            recipientName: lesson.teacher.name,
            lessonId: lesson.id,
            startTime: lesson.scheduledAt,
          }),
        ]);

        await prisma.lesson.update({
          where: { id: lesson.id },
          data: { reminderSent: true },
        });
      })
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    results
      .filter((r) => r.status === "rejected")
      .forEach((r) => {
        console.error(
          "[Cron] Reminder failed:",
          (r as PromiseRejectedResult).reason
        );
      });

    return NextResponse.json({
      success: true,
      sent: succeeded,
      failed,
      total: upcomingLessons.length,
    });
  } catch (error) {
    console.error("[Cron] Reminder error:", error);
    return NextResponse.json(
      { error: "Processing error" },
      { status: 500 }
    );
  }
}

export const POST = GET;
