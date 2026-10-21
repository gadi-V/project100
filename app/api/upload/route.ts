import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getNotebookAccess } from "../../../lib/notebooks";
import { checkUserRateLimit } from "../../../lib/security/rate-limit";
import { prisma } from "../../../lib/prisma";
import { getCurrentUser } from "../../../lib/session";
import {
  STORAGE_UPLOAD_CLIENT_ERROR,
  boardImageObjectPath,
  uploadBoardImage,
} from "../../../lib/storage";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "נדרשת התחברות" }, { status: 401 });
    }

    const formData = await request.formData();
    const notebookId = formData.get("notebookId");
    const file = formData.get("file");
    if (typeof notebookId !== "string" || notebookId.trim().length === 0) {
      return NextResponse.json({ error: "חסר מזהה מחברת" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "קובץ חסר" }, { status: 400 });
    }

    const notebook = await getNotebookAccess(user, notebookId.trim());
    if (!notebook) {
      return NextResponse.json({ error: "אין הרשאה למחברת הזו" }, { status: 403 });
    }

    if (!ALLOWED.has(file.type)) {
      return NextResponse.json({ error: "סוג קובץ לא נתמך" }, { status: 400 });
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "הקובץ גדול מדי (מקס 5MB)" }, { status: 400 });
    }

    const limit = await checkUserRateLimit(user.id, "boardUpload");
    if (!limit.success) {
      const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
      return NextResponse.json(
        { error: "אפשר להעלות עד 10 תמונות בדקה" },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const imageId = nanoid(12);
    const path = boardImageObjectPath(imageId, file.type);
    await uploadBoardImage(imageId, buffer, file.type);
    await prisma.boardImage.create({
      data: {
        id: imageId,
        notebookId: notebook.id,
        uploaderId: user.id,
        path,
        contentType: file.type,
        bytes: buffer.length,
      },
    });

    return NextResponse.json({ id: imageId });
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    console.error("[upload] failed", { reason });
    return NextResponse.json({ error: STORAGE_UPLOAD_CLIENT_ERROR }, { status: 500 });
  }
}
