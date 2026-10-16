import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { getCurrentUser } from "../../../../lib/session";
import { prisma } from "../../../../lib/prisma";
import { STORAGE_UPLOAD_CLIENT_ERROR, uploadLessonPdf } from "../../../../lib/storage";

/** Canonical A4 page dimensions at 96 dpi (matches ClassroomWhiteboard PAGE_W/PAGE_H). */
const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;

type ExportFramePage = {
  pageNumber: number;
  width: number;
  height: number;
  dataUrl: string;
};

type ExportRequest = {
  frames: ExportFramePage[];
  /** When provided, the PDF is stored in Supabase and the returned URL is included
   *  in the WhatsApp summary via /api/lessons/complete. */
  lessonId?: string;
};

function isExportRequest(body: unknown): body is ExportRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.frames) || b.frames.length === 0) return false;
  for (const f of b.frames) {
    if (!f || typeof f !== "object") return false;
    const frame = f as Partial<ExportFramePage>;
    if (
      typeof frame.width !== "number" ||
      typeof frame.height !== "number" ||
      typeof frame.dataUrl !== "string" ||
      !frame.dataUrl.startsWith("data:image/png;base64,")
    ) {
      return false;
    }
  }
  if ("lessonId" in b && b.lessonId !== undefined && typeof b.lessonId !== "string") {
    return false;
  }
  return true;
}

/**
 * Secure server-side multi-page A4 PDF export.
 *
 * Each pre-rendered page (high-res PNG of an A4 canvas frame) is embedded on
 * its own PDF page at the canonical A4 size (794 × 1123 px @ 96 dpi).
 * Client-supplied dimensions are ignored — the server enforces A4 to prevent
 * tampered or oversized payloads.
 *
 * If `lessonId` is supplied the PDF is also persisted to Supabase storage and
 * the signed/public URL is returned as `{ success: true, url, pdfUrl }` JSON.
 * Without `lessonId` the raw PDF binary is returned (legacy/download mode).
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  if (!isExportRequest(body)) {
    return NextResponse.json(
      { success: false, error: "Invalid export data" },
      { status: 400 }
    );
  }

  const { frames, lessonId } = body;

  if (lessonId) {
    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { teacherId: true, studentId: true },
    });

    if (!lesson) {
      return NextResponse.json(
        { success: false, error: "Lesson not found" },
        { status: 404 }
      );
    }

    const isParticipant =
      user.role === "ADMIN" ||
      user.role === "MANAGER" ||
      lesson.teacherId === user.id ||
      lesson.studentId === user.id;

    if (!isParticipant) {
      return NextResponse.json(
        { success: false, error: "Forbidden: Not a lesson participant" },
        { status: 403 }
      );
    }
  }

  try {
    const pdfDoc = await PDFDocument.create();

    for (const frame of frames) {
      const base64 = frame.dataUrl.replace(/^data:image\/png;base64,/, "");
      const image = await pdfDoc.embedPng(base64);

      // Always use canonical A4 dimensions — never trust client-supplied values.
      const page = pdfDoc.addPage([A4_WIDTH_PX, A4_HEIGHT_PX]);
      page.drawImage(image, {
        x: 0,
        y: 0,
        width: A4_WIDTH_PX,
        height: A4_HEIGHT_PX,
      });
    }

    const pdfBytes = Buffer.from(await pdfDoc.save());

    // ── Storage path: upload and return URL when lessonId is provided ──────────
    if (lessonId) {
      let pdfUrl: string | null = null;
      try {
        pdfUrl = await uploadLessonPdf(lessonId, pdfBytes, "board-summary.pdf");
      } catch (uploadErr) {
        const reason = uploadErr instanceof Error ? uploadErr.name : "unknown";
        console.error("[export] PDF upload failed", { reason });
        return NextResponse.json({ error: STORAGE_UPLOAD_CLIENT_ERROR }, { status: 500 });
      }

      if (!pdfUrl && process.env.NODE_ENV === "production") {
        console.error("[export] PDF upload returned no URL");
        return NextResponse.json({ error: STORAGE_UPLOAD_CLIENT_ERROR }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        url: pdfUrl,
        pdfUrl,
        pageCount: frames.length,
      });
    }

    // ── Legacy: return raw binary for direct download ──────────────────────────
    return new Response(pdfBytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="whiteboard.pdf"',
      },
    });
  } catch (error) {
    console.error("PDF generation error:", error);
    return NextResponse.json(
      { success: false, error: "Export failed" },
      { status: 500 }
    );
  }
}
