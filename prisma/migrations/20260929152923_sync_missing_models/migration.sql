-- CreateEnum
CREATE TYPE "TeacherVettingStage" AS ENUM ('REGISTRATION', 'SCREENING', 'SIMULATION', 'EXAM_581', 'FINAL_VIDEO', 'APPROVED', 'REJECTED', 'APPLIED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SIMULATION_PASSED', 'PEDAGOGY_TEST_PASSED', 'TERMS_AGREED');

-- CreateEnum
CREATE TYPE "PayoutType" AS ENUM ('SLIP', 'INVOICE');

-- CreateEnum
CREATE TYPE "VettingStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VettingStepName" AS ENUM ('REGISTRATION_AND_CV', 'SCREENING_CALL', 'TEACHING_SIMULATION', 'EXAM_581', 'FINAL_VIDEO_CALL', 'FINAL_APPROVAL');

-- CreateEnum
CREATE TYPE "VettingStepStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'SKIPPED', 'PENDING_REVIEW');

-- CreateEnum
CREATE TYPE "PreLessonAssetType" AS ENUM ('IMAGE', 'PDF', 'TEXT_NOTE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "academicYear" TEXT,
ADD COLUMN     "classTrack" TEXT,
ADD COLUMN     "degreeField" TEXT,
ADD COLUMN     "notifyParentViaWhatsApp" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parentName" TEXT,
ADD COLUMN     "parentPhone" TEXT,
ADD COLUMN     "quadGroupUrl" TEXT,
ADD COLUMN     "schoolName" TEXT,
ADD COLUMN     "targetOrganization" TEXT,
ADD COLUMN     "trackType" TEXT;

-- AlterTable
ALTER TABLE "TeacherProfile" ADD COLUMN     "cvUrl" TEXT,
ADD COLUMN     "isApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payoutType" "PayoutType" NOT NULL DEFAULT 'SLIP',
ADD COLUMN     "permanentRoomUrl" TEXT,
ADD COLUMN     "topicProficiencies" JSONB,
ADD COLUMN     "trainingTrackJoined" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "vettingNotes" TEXT,
ADD COLUMN     "vettingStage" "TeacherVettingStage",
ADD COLUMN     "vettingStatus" "VettingStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "welcomePackSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "packageId" TEXT,
ADD COLUMN     "pedagogicalBrief" TEXT,
ALTER COLUMN "ratedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DiagnosticQuiz" ADD COLUMN     "academicYear" TEXT,
ADD COLUMN     "answersSummary" TEXT,
ADD COLUMN     "challengeAnswer" TEXT,
ADD COLUMN     "classTrack" TEXT,
ADD COLUMN     "coreCourse" TEXT,
ADD COLUMN     "degreeField" TEXT,
ADD COLUMN     "estimatedScore" INTEGER DEFAULT 0,
ADD COLUMN     "examBattery" TEXT,
ADD COLUMN     "examNumber" TEXT,
ADD COLUMN     "examTimeframe" TEXT,
ADD COLUMN     "hasUpcomingExam" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "identifiedGaps" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "isFirstAttempt" BOOLEAN,
ADD COLUMN     "isUnlocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastGrade" INTEGER,
ADD COLUMN     "learningGoal" TEXT,
ADD COLUMN     "mechinaTrack" TEXT,
ADD COLUMN     "packageId" TEXT,
ADD COLUMN     "psychometricEnglish" INTEGER,
ADD COLUMN     "psychometricQuant" INTEGER,
ADD COLUMN     "psychometricTotal" INTEGER,
ADD COLUMN     "psychometricVerbal" INTEGER,
ADD COLUMN     "quadGroupUrl" TEXT,
ADD COLUMN     "recommendationSummary" TEXT,
ADD COLUMN     "schoolName" TEXT,
ADD COLUMN     "score" INTEGER,
ADD COLUMN     "targetOrganization" TEXT,
ADD COLUMN     "targetTestSession" TEXT,
ADD COLUMN     "testingInstitute" TEXT,
ADD COLUMN     "topic" TEXT,
ADD COLUMN     "topicIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "totalQuestions" INTEGER,
ADD COLUMN     "trackType" TEXT,
ADD COLUMN     "unitsCount" INTEGER,
ADD COLUMN     "unlockedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "priceIls" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurriculumTopic" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "topicName" TEXT NOT NULL,
    "subTopics" JSONB NOT NULL DEFAULT '[]',
    "gradeLevel" TEXT NOT NULL DEFAULT 'HIGH_SCHOOL',
    "weightInExam" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurriculumTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VettingStepLog" (
    "id" TEXT NOT NULL,
    "teacherProfileId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "stepName" "VettingStepName" NOT NULL,
    "status" "VettingStepStatus" NOT NULL DEFAULT 'PENDING',
    "adminNotes" TEXT,
    "bypassedByAdmin" BOOLEAN NOT NULL DEFAULT false,
    "evaluatedByAdminId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VettingStepLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnifiedPackageChat" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "streamChannelId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnifiedPackageChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreLessonAsset" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "lessonId" TEXT,
    "chatId" TEXT,
    "assetType" "PreLessonAssetType" NOT NULL DEFAULT 'IMAGE',
    "assetUrl" TEXT,
    "textContent" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreLessonAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CurriculumTopicToDiagnosticQuiz" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_CurriculumTopicToDiagnosticQuiz_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Package_code_key" ON "Package"("code");

-- CreateIndex
CREATE INDEX "CurriculumTopic_subject_idx" ON "CurriculumTopic"("subject");

-- CreateIndex
CREATE INDEX "CurriculumTopic_gradeLevel_idx" ON "CurriculumTopic"("gradeLevel");

-- CreateIndex
CREATE INDEX "VettingStepLog_teacherProfileId_status_idx" ON "VettingStepLog"("teacherProfileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VettingStepLog_teacherProfileId_stepNumber_key" ON "VettingStepLog"("teacherProfileId", "stepNumber");

-- CreateIndex
CREATE UNIQUE INDEX "UnifiedPackageChat_packageId_key" ON "UnifiedPackageChat"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "UnifiedPackageChat_streamChannelId_key" ON "UnifiedPackageChat"("streamChannelId");

-- CreateIndex
CREATE INDEX "UnifiedPackageChat_packageId_idx" ON "UnifiedPackageChat"("packageId");

-- CreateIndex
CREATE INDEX "PreLessonAsset_packageId_idx" ON "PreLessonAsset"("packageId");

-- CreateIndex
CREATE INDEX "PreLessonAsset_lessonId_idx" ON "PreLessonAsset"("lessonId");

-- CreateIndex
CREATE INDEX "_CurriculumTopicToDiagnosticQuiz_B_index" ON "_CurriculumTopicToDiagnosticQuiz"("B");

-- AddForeignKey
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VettingStepLog" ADD CONSTRAINT "VettingStepLog_teacherProfileId_fkey" FOREIGN KEY ("teacherProfileId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnifiedPackageChat" ADD CONSTRAINT "UnifiedPackageChat_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreLessonAsset" ADD CONSTRAINT "PreLessonAsset_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreLessonAsset" ADD CONSTRAINT "PreLessonAsset_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreLessonAsset" ADD CONSTRAINT "PreLessonAsset_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "UnifiedPackageChat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreLessonAsset" ADD CONSTRAINT "PreLessonAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CurriculumTopicToDiagnosticQuiz" ADD CONSTRAINT "_CurriculumTopicToDiagnosticQuiz_A_fkey" FOREIGN KEY ("A") REFERENCES "CurriculumTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CurriculumTopicToDiagnosticQuiz" ADD CONSTRAINT "_CurriculumTopicToDiagnosticQuiz_B_fkey" FOREIGN KEY ("B") REFERENCES "DiagnosticQuiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

