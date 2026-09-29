import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { requireAuth } from "../../../../lib/api-auth";
import {
  PayoutType,
  VettingStatus,
  VettingStepName,
  VettingStepStatus,
  TeacherVettingStage,
} from "@prisma/client";

const VETTING_DEFAULT_STEPS: VettingStepName[] = [
  VettingStepName.REGISTRATION_AND_CV,
  VettingStepName.SCREENING_CALL,
  VettingStepName.TEACHING_SIMULATION,
  VettingStepName.EXAM_581,
  VettingStepName.FINAL_VIDEO_CALL,
  VettingStepName.FINAL_APPROVAL,
];

/**
 * The applicant is always the signed-in user. Any `userId` in the body or a
 * client-sent `x-user-id` header is ignored, so nobody can apply (or overwrite
 * bank details) on behalf of another account.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const targetUserId = auth.user.id;

  try {
    const body = await request.json();

    const {
      cvUrl,
      payoutType,
      topicProficiencies,
      bio,
      bankName,
      accountNumber,
    } = body;

    if (!cvUrl) {
      return NextResponse.json(
        { error: "CV URL is required" },
        { status: 400 }
      );
    }

    const profile = await prisma.$transaction(async (tx) => {
      const teacher = await tx.teacherProfile.upsert({
        where: { userId: targetUserId },
        create: {
          userId: targetUserId,
          cvUrl,
          payoutType: payoutType || PayoutType.SLIP,
          topicProficiencies: topicProficiencies || [],
          bankName,
          accountNumber,
          vettingNotes: bio,
          vettingStatus: VettingStatus.PENDING,
          vettingStage: TeacherVettingStage.REGISTRATION,
          isApproved: false,
        },
        update: {
          cvUrl,
          payoutType: payoutType || undefined,
          topicProficiencies: topicProficiencies || undefined,
          bankName: bankName || undefined,
          accountNumber: accountNumber || undefined,
          vettingNotes: bio || undefined,
          vettingStatus: VettingStatus.PENDING,
        },
      });

      for (let i = 0; i < VETTING_DEFAULT_STEPS.length; i++) {
        const stepName = VETTING_DEFAULT_STEPS[i];
        const stepNumber = i + 1;

        await tx.vettingStepLog.upsert({
          where: {
            teacherProfileId_stepNumber: {
              teacherProfileId: teacher.id,
              stepNumber,
            },
          },
          create: {
            teacherProfileId: teacher.id,
            stepNumber,
            stepName,
            status:
              stepNumber === 1
                ? VettingStepStatus.PASSED
                : VettingStepStatus.PENDING,
            completedAt: stepNumber === 1 ? new Date() : null,
          },
          update: {},
        });
      }

      return teacher;
    });

    return NextResponse.json(profile, { status: 201 });
  } catch (error) {
    console.error("Failed to apply for teacher vetting:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
