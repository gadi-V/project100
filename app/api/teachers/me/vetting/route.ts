import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../../../lib/prisma";
import { requireAuth } from "../../../../../lib/api-auth";
import {
  getTeacherVettingProgress,
  updateVettingStep,
} from "../../../../../lib/teacher-vetting";
import { VettingStepName, VettingStepStatus } from "@prisma/client";
import { uploadBoardImage, uploadLessonPdf } from "../../../../../lib/storage";

/**
 * Identity comes only from the signed session cookie. The `x-user-id` request
 * header is attacker-controllable and is never read here.
 */
function findOwnTeacherProfile(userId: string) {
  return prisma.teacherProfile.findUnique({ where: { userId } });
}

export async function GET() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  try {
    const teacherProfile = await findOwnTeacherProfile(auth.user.id);

    if (!teacherProfile) {
      return NextResponse.json(
        { error: "Teacher profile not found" },
        { status: 404 }
      );
    }

    const progress = await getTeacherVettingProgress(teacherProfile.id);
    return NextResponse.json(progress, { status: 200 });
  } catch (error) {
    console.error("Failed to fetch current teacher vetting status:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

/**
 * Teacher-facing POST — submits the exam 581 solution for review.
 * The teacher never self-approves: the step is set to PENDING_REVIEW so an
 * ADMIN/MANAGER still has to pass it on the admin vetting dashboard.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;

  try {
    const contentType = request.headers.get("content-type") ?? "";
    const isMultipart = contentType.includes("multipart/form-data");

    // The body stream can be read once: multipart is parsed via formData() below.
    const body = (
      isMultipart ? {} : await request.json().catch(() => ({}))
    ) as {
      solutionUrl?: unknown;
      notes?: unknown;
      examSolutionUrl?: unknown;
    };

    const solutionUrl =
      (typeof body.solutionUrl === "string" && body.solutionUrl.trim()
        ? body.solutionUrl.trim()
        : null) ??
      (typeof body.examSolutionUrl === "string" && body.examSolutionUrl.trim()
        ? body.examSolutionUrl.trim()
        : null);

    if (!solutionUrl && !isMultipart) {
      return NextResponse.json(
        { error: "יש להזין קישור לקובץ הפתרון" },
        { status: 400 }
      );
    }

    const teacherProfile = await findOwnTeacherProfile(auth.user.id);

    if (!teacherProfile) {
      return NextResponse.json(
        { error: "Teacher profile not found" },
        { status: 404 }
      );
    }

    // Multipart path: upload solution files (images/PDF) to storage then store URLs.
    let uploadedSolutionUrls: string[] = [];
    let uploadedNotes = "";

    if (isMultipart) {
      const formData = await request.formData();
      const files = formData.getAll("solutions").filter((f): f is File => f instanceof File);

      if (files.length === 0) {
        return NextResponse.json(
          { error: "יש להעלות לפחות קובץ פתרון אחד" },
          { status: 400 }
        );
      }

      for (const [idx, file] of files.entries()) {
        const buffer = Buffer.from(await file.arrayBuffer());
        const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
        if (isPdf) {
          const url = await uploadLessonPdf(`exam-581-${teacherProfile.userId}`, buffer, file.name);
          if (url) uploadedSolutionUrls.push(url);
        } else {
          const url = await uploadBoardImage(`exam-581-${teacherProfile.userId}-${idx}`, buffer, file.type);
          uploadedSolutionUrls.push(url);
        }
      }

      const questionsRaw = formData.get("questions");
      uploadedNotes = typeof questionsRaw === "string" ? questionsRaw : "";
      if (uploadedNotes) {
        uploadedNotes = `שאלות שנבחרו: ${uploadedNotes}`;
      }
    }

    const resolvedSolutionUrl =
      solutionUrl ??
      (uploadedSolutionUrls.length > 0
        ? uploadedSolutionUrls.join("\n")
        : null);

    if (!resolvedSolutionUrl) {
      return NextResponse.json(
        { error: "העלאת קובץ הפתרון נכשלה" },
        { status: 500 }
      );
    }

    const notes =
      typeof body.notes === "string" && body.notes.trim()
        ? body.notes.trim()
        : uploadedNotes;

    const stepLog = await updateVettingStep({
      teacherProfileId: teacherProfile.id,
      stepNumber: 4,
      stepName: VettingStepName.EXAM_581,
      status: VettingStepStatus.PENDING,
      adminNotes: notes
        ? `פתרון מבחן 581: ${resolvedSolutionUrl}\n${notes}`
        : `פתרון מבחן 581: ${resolvedSolutionUrl}`,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          stepNumber: stepLog.stepNumber,
          status: stepLog.status,
          message: "הפתרון נשלח לבדיקת ההנהלה — שלב 581 ממתין לאישור.",
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Failed to submit exam 581 solution:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}