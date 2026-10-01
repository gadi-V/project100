import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../../../lib/prisma";
import { requireAuth } from "../../../../../lib/api-auth";
import { isLessonManagementRole } from "../../../../../lib/lesson-completion";
import { savePostLessonSummary } from "../../../../../lib/lesson-summary";

/**
 * Pedagogical summary + gap closure for one lesson. Signed-in users only (`401`); only the lesson's assigned
 * teacher, ADMIN or MANAGER may write it (`403` for students and other teachers). The teacher is taken from the
 * lesson, never from the request body.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  try {
    const { id: lessonId } = await Promise.resolve(params);
    if (auth.user.role !== "TEACHER" && !isLessonManagementRole(auth.user.role)) {
      return NextResponse.json({ error: "אין לך הרשאה לפעולה זו" }, { status: 403 });
    }

    const lesson = await prisma.lesson.findUnique({ where: { id: lessonId }, select: { id: true, teacherId: true } });
    if (!lesson) {
      return NextResponse.json({ error: "השיעור לא נמצא" }, { status: 404 });
    }
    if (!isLessonManagementRole(auth.user.role) && lesson.teacherId !== auth.user.id) {
      return NextResponse.json({ error: "רק המורה המשובץ לשיעור או ההנהלה יכולים לסכם אותו" }, { status: 403 });
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return NextResponse.json({ error: "גוף הבקשה אינו JSON תקין" }, { status: 400 });
    }

    const { summaryText, homeworkAssigned, resolvedGaps, remainingGaps, studentRating } = body;
    if (typeof summaryText !== "string" || !summaryText.trim()) {
      return NextResponse.json({ error: "Missing required field: summaryText is mandatory" }, { status: 400 });
    }

    const result = await savePostLessonSummary({
      lessonId: lesson.id,
      teacherId: lesson.teacherId,
      summaryText,
      homeworkAssigned: typeof homeworkAssigned === "string" ? homeworkAssigned : undefined,
      resolvedGaps: Array.isArray(resolvedGaps) ? resolvedGaps.filter((g): g is string => typeof g === "string") : [],
      remainingGaps: Array.isArray(remainingGaps) ? remainingGaps.filter((g): g is string => typeof g === "string") : [],
      studentRating: studentRating ? Number(studentRating) : undefined,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("Failed to save post-lesson summary:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
