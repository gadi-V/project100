import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "../../../../../lib/api-auth";
import { getNotebookAccess } from "../../../../../lib/notebooks";
import { loadNotebookPages } from "../../../../../lib/notebooks/page-snapshots";

function readBound(value: string | null): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) return null;
  return parsed;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  const { id } = await Promise.resolve(context.params);
  const notebook = await getNotebookAccess(auth.user, id);
  if (!notebook) {
    return NextResponse.json({ success: false, error: "המחברת לא נמצאה" }, { status: 404 });
  }

  const from = readBound(request.nextUrl.searchParams.get("from"));
  const to = readBound(request.nextUrl.searchParams.get("to"));
  if (from == null || to == null || to < from || to - from > 200) {
    return NextResponse.json({ success: false, error: "טווח העמודים לא תקין" }, { status: 400 });
  }

  const pages = await loadNotebookPages(notebook.id, from, to);
  return NextResponse.json({ success: true, data: { pages } });
}
