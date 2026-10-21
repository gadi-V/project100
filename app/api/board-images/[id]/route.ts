import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getNotebookAccess } from "../../../../lib/notebooks";
import { prisma } from "../../../../lib/prisma";
import { getCurrentUser } from "../../../../lib/session";
import { readBoardObject } from "../../../../lib/storage";

const CACHE_CONTROL = "private, max-age=3600";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "נדרשת התחברות" }, { status: 401 });
  }

  const { id } = await Promise.resolve(context.params);
  const image = await prisma.boardImage.findUnique({ where: { id } });
  if (!image) {
    return NextResponse.json({ error: "התמונה לא נמצאה" }, { status: 404 });
  }

  const notebook = await getNotebookAccess(user, image.notebookId);
  if (!notebook) {
    return NextResponse.json({ error: "התמונה לא נמצאה" }, { status: 404 });
  }

  const bytes = await readBoardObject(image.path);
  if (!bytes) {
    return NextResponse.json({ error: "התמונה לא נמצאה" }, { status: 404 });
  }

  const etag = `"${createHash("sha1").update(bytes).digest("hex")}"`;
  const headers = {
    "Cache-Control": CACHE_CONTROL,
    ETag: etag,
    "Content-Type": image.contentType,
  };
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  return new NextResponse(new Uint8Array(bytes), { status: 200, headers });
}
