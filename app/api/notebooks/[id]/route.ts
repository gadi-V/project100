import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/api-auth";
import { getNotebookAccess } from "../../../../lib/notebooks";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const { id } = await Promise.resolve(context.params);
  const notebook = await getNotebookAccess(auth.user, id);
  if (!notebook) {
    return NextResponse.json({ success: false, error: "המחברת לא נמצאה" }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    data: {
      id: notebook.id,
      studentId: notebook.studentId,
      studentName: notebook.student.name,
      createdAt: notebook.createdAt.toISOString(),
      pages: notebook.pages.map((page) => ({
        id: page.id,
        pageIndex: page.pageIndex,
        paperStyle: page.paperStyle,
        snapshotPath: page.snapshotPath,
        snapshotVersion: page.snapshotVersion,
      })),
    },
  });
}
