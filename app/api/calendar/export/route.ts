import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { requireAuth } from "../../../../lib/api-auth";
import { buildIcsCalendar, type IcsLessonEvent } from "../../../../lib/ics";

/**
 * Authenticated iCalendar feed of the caller's upcoming / active lessons.
 * Used for Apple Calendar (webcal / .ics download) and Google Calendar import.
 */
export async function GET() {
  try {
    const auth = await requireAuth(["STUDENT", "TEACHER", "ADMIN", "MANAGER"]);
    if (auth.error) return auth.error;

    const where =
      auth.user.role === "TEACHER"
        ? { teacherId: auth.user.id }
        : auth.user.role === "STUDENT"
          ? { studentId: auth.user.id }
          : {
              OR: [{ teacherId: auth.user.id }, { studentId: auth.user.id }],
            };

    const lessons = await prisma.lesson.findMany({
      where: {
        ...where,
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
        scheduledAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      include: {
        teacher: { select: { name: true } },
        student: { select: { name: true } },
      },
      orderBy: { scheduledAt: "asc" },
      take: 200,
    });

    const events: IcsLessonEvent[] = lessons.map((lesson) => ({
      id: lesson.id,
      title: lesson.title,
      scheduledAt: lesson.scheduledAt,
      durationMinutes: lesson.durationMinutes ?? 50,
      description: `מורה: ${lesson.teacher.name} · תלמיד: ${lesson.student.name}`,
      location: lesson.dailyRoomUrl ?? undefined,
    }));

    const ics = buildIcsCalendar(events, "PROJECT100 — שיעורים");

    return new NextResponse(ics, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="project100-lessons.ics"',
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("Calendar export error:", error);
    return NextResponse.json(
      { success: false, error: "שגיאה בייצוא היומן" },
      { status: 500 }
    );
  }
}
