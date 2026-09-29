import { NextResponse } from "next/server";
import type { CurriculumTopic } from "@prisma/client";
import { prisma } from "../../../../lib/prisma";
import { requireAuth } from "../../../../lib/api-auth";
import { rankTeachersForDiagnostic, type MatchableTeacher } from "../../../../lib/matching";

/**
 * Unlock gated diagnostic tree.
 * 1. Verifies authentication and that student has lessonCredits > 0 (or Admin/Manager).
 * 2. Unlocks the diagnostic quiz knowledge tree.
 * 3. Matches and assigns the optimal specialist teacher via lib/matching.ts.
 * 4. Reports the quad WhatsApp group status. This route never creates a group or stores a link:
 *    the group is opened by POST /api/whatsapp/dispatch-channel once a teacher is assigned and a
 *    lesson is scheduled.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireAuth(["STUDENT", "ADMIN", "MANAGER"]);
    if (auth.error) return auth.error;

    const body = await request.json();
    const { diagnosticId } = body;

    if (!diagnosticId) {
      return NextResponse.json(
        { success: false, error: "מזהה אבחון חסר" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: auth.user.id },
    });

    if (!user) {
      return NextResponse.json(
        { success: false, error: "משתמש לא נמצא" },
        { status: 404 }
      );
    }

    const isAdminOrManager = user.role === "ADMIN" || user.role === "MANAGER";
    const hasCredits = user.lessonCredits > 0;

    if (!hasCredits && !isAdminOrManager) {
      return NextResponse.json(
        {
          success: false,
          error: "נדרשת יתרת שיעורים (חבילת שיעורים פעילה) לפתיחת דו״ח פערי הידע המלא",
          requiresPurchase: true,
        },
        { status: 402 }
      );
    }

    const diagnostic = await prisma.diagnosticQuiz.findUnique({
      where: { id: diagnosticId },
      include: {
        topics: true,
      },
    });

    if (!diagnostic) {
      return NextResponse.json(
        { success: false, error: "דו״ח אבחון לא נמצא" },
        { status: 404 }
      );
    }

    // 1. Mark diagnostic as unlocked
    const updated = await prisma.diagnosticQuiz.update({
      where: { id: diagnosticId },
      data: {
        isUnlocked: true,
        unlockedAt: new Date(),
        studentId: user.id,
      },
      include: {
        topics: true,
      },
    });

    // 2. Fetch approved teachers and run smart matching
    const teachersRaw = await prisma.user.findMany({
      where: {
        role: "TEACHER",
        isApproved: true,
        teacherProfile: { isNot: null },
      },
      select: {
        id: true,
        name: true,
        teacherProfile: {
          select: {
            subjects: true,
            ageGroups: true,
            bio: true,
            profileImageUrl: true,
            referralCount: true,
            activeStudentsCount: true,
            lastReferralAt: true,
            topicProficiencies: true,
          },
        },
        availabilities: {
          where: {
            isBooked: false,
            startTime: { gte: new Date() },
          },
          select: { id: true, startTime: true },
          take: 50,
        },
      },
    });

    const matchable: MatchableTeacher[] = teachersRaw
      .filter((t) => t.teacherProfile)
      .map((t) => ({
        id: t.id,
        name: t.name,
        profile: {
          subjects: t.teacherProfile!.subjects,
          ageGroups: t.teacherProfile!.ageGroups,
          bio: t.teacherProfile!.bio,
          profileImageUrl: t.teacherProfile!.profileImageUrl,
          referralCount: t.teacherProfile!.referralCount,
          activeStudentsCount: t.teacherProfile!.activeStudentsCount,
          lastReferralAt: t.teacherProfile!.lastReferralAt,
          topicProficiencies: (t.teacherProfile!.topicProficiencies as Record<string, number> | null) ?? null,
        },
        openSlotsCount: t.availabilities.length,
        openSlots: t.availabilities.map((s) => ({ id: s.id, startTime: s.startTime })),
      }));

    const ranked = rankTeachersForDiagnostic(
      {
        ageGroup: diagnostic.ageGroup,
        subject: diagnostic.subject,
        challenge: diagnostic.challenge,
        topics: updated.topics.map((t) => ({
          id: t.id,
          topicName: t.topicName,
          subTopics: Array.isArray(t.subTopics) ? (t.subTopics as string[]) : [],
          weightInExam: t.weightInExam,
        })),
      },
      matchable
    );

    const matchedTeacher = ranked[0] ?? null;

    // 3. Quad group status. Only a live group (whatsappGroupId) has a real invite link; any
    // quadGroupUrl without one is a legacy placeholder and is never returned.
    const hasLiveGroup = Boolean(user.whatsappGroupId);
    const groupStatus = hasLiveGroup ? "EXISTING" : "PENDING_TEACHER_ASSIGNMENT";
    const quadGroupUrl = hasLiveGroup ? user.quadGroupUrl : null;

    // 4. Record teacher referral if matched
    if (matchedTeacher) {
      const existingRef = await prisma.teacherReferral.findFirst({
        where: { studentId: user.id },
      });

      if (!existingRef) {
        await prisma.teacherReferral.create({
          data: {
            teacherId: matchedTeacher.teacherId,
            studentId: user.id,
            diagnosticId: updated.id,
            matchScore: matchedTeacher.matchScore,
            reason: matchedTeacher.reasons.join(" · ") || "onboarding-unlock-match",
          },
        });

        await prisma.teacherProfile.update({
          where: { userId: matchedTeacher.teacherId },
          data: {
            referralCount: { increment: 1 },
            lastReferralAt: new Date(),
            lastMatchScore: matchedTeacher.matchScore,
          },
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        id: updated.id,
        isUnlocked: true,
        unlockedAt: updated.unlockedAt,
        estimatedScore: updated.estimatedScore,
        recommendationSummary: updated.recommendationSummary,
        quadGroupUrl,
        groupStatus,
        matchedTeacher: matchedTeacher
          ? {
              teacherId: matchedTeacher.teacherId,
              teacherName: matchedTeacher.teacherName,
              matchScore: matchedTeacher.matchScore,
              reasons: matchedTeacher.reasons,
              openSlotsCount: matchedTeacher.openSlotsCount,
            }
          : null,
        topics: updated.topics.map((t: CurriculumTopic) => ({
          id: t.id,
          topicName: t.topicName,
          subTopics: t.subTopics,
          weightInExam: t.weightInExam,
          gradeLevel: t.gradeLevel,
        })),
      },
    });
  } catch (error: unknown) {
    console.error("Diagnostic unlock error:", error);
    return NextResponse.json(
      { success: false, error: "שגיאה בפתיחת דו״ח האבחון ושיבוץ המורה" },
      { status: 500 }
    );
  }
}
