import { NextRequest, NextResponse } from "next/server";
import { PreLessonAssetType } from "@prisma/client";
import { getPackagePedagogicalBrief, uploadPreLessonAsset } from "../../../../../lib/package-chat";
import { prisma } from "../../../../../lib/prisma";
import { getCurrentUser } from "../../../../../lib/session";

async function requirePackageParticipant(
  packageId: string,
): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (user.role === "ADMIN" || user.role === "MANAGER") {
    return { ok: true, userId: user.id };
  }
  const membership = await prisma.lesson.findFirst({
    where: {
      packageId,
      OR: [
        { studentId: user.id },
        { teacherId: user.id },
        { substituteTeacherId: user.id },
        { originalTeacherId: user.id },
      ],
    },
    select: { id: true },
  });
  if (membership) return { ok: true, userId: user.id };

  // Package has no student/owner column. A diagnostic is the student link that
  // exists before any lesson is scheduled.
  const diagnostic = await prisma.diagnosticQuiz.findFirst({
    where: { packageId, studentId: user.id },
    select: { id: true },
  });
  if (!diagnostic) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true, userId: user.id };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const resolvedParams = await Promise.resolve(params);
    const packageId = resolvedParams.id;
    const access = await requirePackageParticipant(packageId);
    if (!access.ok) return access.response;

    const brief = await getPackagePedagogicalBrief(packageId);
    if (!brief) {
      return NextResponse.json({ error: "Package not found" }, { status: 404 });
    }

    return NextResponse.json({
      packageId,
      assets: brief.preLessonAssets,
      chat: brief.chat,
      lessons: brief.lessons,
    });
  } catch (error) {
    console.error("Failed to fetch pedagogical brief:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const resolvedParams = await Promise.resolve(params);
    const packageId = resolvedParams.id;
    const access = await requirePackageParticipant(packageId);
    if (!access.ok) return access.response;

    const body = await request.json();
    const { lessonId, assetType, assetUrl, textContent } = body;

    if (!assetType) {
      return NextResponse.json(
        { error: "Missing required fields: assetType is mandatory" },
        { status: 400 }
      );
    }

    const validTypes = Object.values(PreLessonAssetType);
    if (!validTypes.includes(assetType)) {
      return NextResponse.json(
        { error: `Invalid assetType. Must be one of: ${validTypes.join(", ")}` },
        { status: 400 }
      );
    }

    const asset = await uploadPreLessonAsset({
      packageId,
      lessonId: typeof lessonId === "string" ? lessonId : undefined,
      assetType,
      assetUrl,
      textContent,
      uploadedById: access.userId,
    });

    return NextResponse.json(asset, { status: 201 });
  } catch (error) {
    console.error("Failed to upload pre-lesson asset:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
