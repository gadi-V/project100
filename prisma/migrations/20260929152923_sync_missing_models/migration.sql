-- Idempotent: the production DB already contained these objects (schema synced via `db push`),
-- so every statement tolerates pre-existing enums, columns, tables, indexes and constraints.

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "TeacherVettingStage" AS ENUM ('REGISTRATION', 'SCREENING', 'SIMULATION', 'EXAM_581', 'FINAL_VIDEO', 'APPROVED', 'REJECTED', 'APPLIED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SIMULATION_PASSED', 'PEDAGOGY_TEST_PASSED', 'TERMS_AGREED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "PayoutType" AS ENUM ('SLIP', 'INVOICE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "VettingStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'APPROVED', 'REJECTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "VettingStepName" AS ENUM ('REGISTRATION_AND_CV', 'SCREENING_CALL', 'TEACHING_SIMULATION', 'EXAM_581', 'FINAL_VIDEO_CALL', 'FINAL_APPROVAL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "VettingStepStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'SKIPPED', 'PENDING_REVIEW');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "PreLessonAssetType" AS ENUM ('IMAGE', 'PDF', 'TEXT_NOTE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "academicYear" TEXT,
ADD COLUMN IF NOT EXISTS "classTrack" TEXT,
ADD COLUMN IF NOT EXISTS "degreeField" TEXT,
ADD COLUMN IF NOT EXISTS "notifyParentViaWhatsApp" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "parentName" TEXT,
ADD COLUMN IF NOT EXISTS "parentPhone" TEXT,
ADD COLUMN IF NOT EXISTS "quadGroupUrl" TEXT,
ADD COLUMN IF NOT EXISTS "schoolName" TEXT,
ADD COLUMN IF NOT EXISTS "targetOrganization" TEXT,
ADD COLUMN IF NOT EXISTS "trackType" TEXT;

-- AlterTable
ALTER TABLE "TeacherProfile" ADD COLUMN IF NOT EXISTS "cvUrl" TEXT,
ADD COLUMN IF NOT EXISTS "isApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "payoutType" "PayoutType" NOT NULL DEFAULT 'SLIP',
ADD COLUMN IF NOT EXISTS "permanentRoomUrl" TEXT,
ADD COLUMN IF NOT EXISTS "topicProficiencies" JSONB,
ADD COLUMN IF NOT EXISTS "trainingTrackJoined" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "vettingNotes" TEXT,
ADD COLUMN IF NOT EXISTS "vettingStage" "TeacherVettingStage",
ADD COLUMN IF NOT EXISTS "vettingStatus" "VettingStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN IF NOT EXISTS "welcomePackSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN IF NOT EXISTS "packageId" TEXT,
ADD COLUMN IF NOT EXISTS "pedagogicalBrief" TEXT,
ALTER COLUMN "ratedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DiagnosticQuiz" ADD COLUMN IF NOT EXISTS "academicYear" TEXT,
ADD COLUMN IF NOT EXISTS "answersSummary" TEXT,
ADD COLUMN IF NOT EXISTS "challengeAnswer" TEXT,
ADD COLUMN IF NOT EXISTS "classTrack" TEXT,
ADD COLUMN IF NOT EXISTS "coreCourse" TEXT,
ADD COLUMN IF NOT EXISTS "degreeField" TEXT,
ADD COLUMN IF NOT EXISTS "estimatedScore" INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS "examBattery" TEXT,
ADD COLUMN IF NOT EXISTS "examNumber" TEXT,
ADD COLUMN IF NOT EXISTS "examTimeframe" TEXT,
ADD COLUMN IF NOT EXISTS "hasUpcomingExam" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "identifiedGaps" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "isFirstAttempt" BOOLEAN,
ADD COLUMN IF NOT EXISTS "isUnlocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "lastGrade" INTEGER,
ADD COLUMN IF NOT EXISTS "learningGoal" TEXT,
ADD COLUMN IF NOT EXISTS "mechinaTrack" TEXT,
ADD COLUMN IF NOT EXISTS "packageId" TEXT,
ADD COLUMN IF NOT EXISTS "psychometricEnglish" INTEGER,
ADD COLUMN IF NOT EXISTS "psychometricQuant" INTEGER,
ADD COLUMN IF NOT EXISTS "psychometricTotal" INTEGER,
ADD COLUMN IF NOT EXISTS "psychometricVerbal" INTEGER,
ADD COLUMN IF NOT EXISTS "quadGroupUrl" TEXT,
ADD COLUMN IF NOT EXISTS "recommendationSummary" TEXT,
ADD COLUMN IF NOT EXISTS "schoolName" TEXT,
ADD COLUMN IF NOT EXISTS "score" INTEGER,
ADD COLUMN IF NOT EXISTS "targetOrganization" TEXT,
ADD COLUMN IF NOT EXISTS "targetTestSession" TEXT,
ADD COLUMN IF NOT EXISTS "testingInstitute" TEXT,
ADD COLUMN IF NOT EXISTS "topic" TEXT,
ADD COLUMN IF NOT EXISTS "topicIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "totalQuestions" INTEGER,
ADD COLUMN IF NOT EXISTS "trackType" TEXT,
ADD COLUMN IF NOT EXISTS "unitsCount" INTEGER,
ADD COLUMN IF NOT EXISTS "unlockedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Package" (
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
CREATE TABLE IF NOT EXISTS "CurriculumTopic" (
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
CREATE TABLE IF NOT EXISTS "VettingStepLog" (
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
CREATE TABLE IF NOT EXISTS "UnifiedPackageChat" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "streamChannelId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnifiedPackageChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PreLessonAsset" (
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
CREATE TABLE IF NOT EXISTS "_CurriculumTopicToDiagnosticQuiz" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_CurriculumTopicToDiagnosticQuiz_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Package_code_key" ON "Package"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CurriculumTopic_subject_idx" ON "CurriculumTopic"("subject");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CurriculumTopic_gradeLevel_idx" ON "CurriculumTopic"("gradeLevel");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VettingStepLog_teacherProfileId_status_idx" ON "VettingStepLog"("teacherProfileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "VettingStepLog_teacherProfileId_stepNumber_key" ON "VettingStepLog"("teacherProfileId", "stepNumber");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "UnifiedPackageChat_packageId_key" ON "UnifiedPackageChat"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "UnifiedPackageChat_streamChannelId_key" ON "UnifiedPackageChat"("streamChannelId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UnifiedPackageChat_packageId_idx" ON "UnifiedPackageChat"("packageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PreLessonAsset_packageId_idx" ON "PreLessonAsset"("packageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PreLessonAsset_lessonId_idx" ON "PreLessonAsset"("lessonId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "_CurriculumTopicToDiagnosticQuiz_B_index" ON "_CurriculumTopicToDiagnosticQuiz"("B");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "VettingStepLog" ADD CONSTRAINT "VettingStepLog_teacherProfileId_fkey" FOREIGN KEY ("teacherProfileId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "UnifiedPackageChat" ADD CONSTRAINT "UnifiedPackageChat_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "PreLessonAsset" ADD CONSTRAINT "PreLessonAsset_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "PreLessonAsset" ADD CONSTRAINT "PreLessonAsset_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "PreLessonAsset" ADD CONSTRAINT "PreLessonAsset_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "UnifiedPackageChat"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "PreLessonAsset" ADD CONSTRAINT "PreLessonAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "_CurriculumTopicToDiagnosticQuiz" ADD CONSTRAINT "_CurriculumTopicToDiagnosticQuiz_A_fkey" FOREIGN KEY ("A") REFERENCES "CurriculumTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "_CurriculumTopicToDiagnosticQuiz" ADD CONSTRAINT "_CurriculumTopicToDiagnosticQuiz_B_fkey" FOREIGN KEY ("B") REFERENCES "DiagnosticQuiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
