import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "../../../../../../lib/api-auth";
import { getNotebookAccess } from "../../../../../../lib/notebooks";
import { saveNotebookPage } from "../../../../../../lib/notebooks/page-snapshots";
import { prisma } from "../../../../../../lib/prisma";
import { checkUserRateLimit } from "../../../../../../lib/security/rate-limit";

function readPageIndex(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) return null;
  return parsed;
}

function canWriteSnapshot(role: string, userId: string, teacherId: string): boolean {
  if (role === "ADMIN" || role === "MANAGER") return true;
  return role === "TEACHER" && userId === teacherId;
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string; pageIndex: string }> | { id: string; pageIndex: string } },
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const { id, pageIndex: pageParam } = await Promise.resolve(context.params);
  const pageIndex = readPageIndex(pageParam);
  if (pageIndex == null) {
    return NextResponse.json({ success: false, error: "מספר העמוד לא תקין" }, { status: 400 });
  }

  const notebook = await getNotebookAccess(auth.user, id);
  if (!notebook) {
    return NextResponse.json({ success: false, error: "המחברת לא נמצאה" }, { status: 404 });
  }

  let body: { baseVersion?: unknown; snapshot?: unknown; lessonId?: unknown };
  try {
    body = (await request.json()) as { baseVersion?: unknown; snapshot?: unknown; lessonId?: unknown };
  } catch {
    return NextResponse.json({ success: false, error: "הבקשה לא תקינה" }, { status: 400 });
  }

  const lessonId = typeof body.lessonId === "string" ? body.lessonId.trim() : "";
  const snapshot = body.snapshot;
  if (!lessonId || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return NextResponse.json({ success: false, error: "חסרים פרטי העמוד" }, { status: 400 });
  }
  const page = snapshot as { paperStyle?: unknown; elements?: unknown };

  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    select: { id: true, teacherId: true, notebookId: true },
  });
  if (!lesson || lesson.notebookId !== notebook.id) {
    return NextResponse.json({ success: false, error: "השיעור לא נמצא" }, { status: 404 });
  }
  if (!canWriteSnapshot(auth.user.role, auth.user.id, lesson.teacherId)) {
    return NextResponse.json({ success: false, error: "אין הרשאה לשמור את המחברת" }, { status: 403 });
  }

  const limit = await checkUserRateLimit(auth.user.id, "boardSnapshot");
  if (!limit.success) {
    const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
    return NextResponse.json(
      { success: false, error: "אפשר לשמור עד 20 פעמים בדקה" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  try {
    const saved = await saveNotebookPage({
      notebookId: notebook.id,
      pageIndex,
      lessonId: lesson.id,
      baseVersion: typeof body.baseVersion === "number" ? body.baseVersion : -1,
      paperStyle: page.paperStyle,
      elements: page.elements,
    });
    if (!saved.ok && saved.status === 409) {
      return NextResponse.json({ success: false, currentVersion: saved.currentVersion }, { status: 409 });
    }
    if (!saved.ok && saved.status === 413) {
      return NextResponse.json({ success: false, error: "העמוד גדול מדי" }, { status: 413 });
    }
    if (!saved.ok) {
      return NextResponse.json({ success: false, error: "הבקשה לא תקינה" }, { status: saved.status });
    }
    return NextResponse.json({
      success: true,
      data: { version: saved.version, snapshotPath: saved.snapshotPath },
    });
  } catch (error) {
    console.error("[notebook] snapshot save failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ success: false, error: "לא הצלחנו לשמור את העמוד" }, { status: 500 });
  }
}
