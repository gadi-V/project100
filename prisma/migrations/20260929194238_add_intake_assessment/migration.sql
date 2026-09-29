-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'REPRESENTATIVE';

-- CreateTable
CREATE TABLE "IntakeAssessment" (
    "id" TEXT NOT NULL,
    "studentId" TEXT,
    "fallbackLeadId" TEXT,
    "representativeId" TEXT,
    "grade" TEXT NOT NULL,
    "levelUnits" TEXT NOT NULL,
    "hobbies" TEXT NOT NULL,
    "isProfessionalHobby" BOOLEAN NOT NULL,
    "weeklyHobbyFrequency" INTEGER,
    "nextExamDate" TIMESTAMP(3),
    "lastExamDate" TIMESTAMP(3),
    "lastExamScore" DOUBLE PRECISION,
    "strongTopic" TEXT NOT NULL,
    "weakTopic" TEXT NOT NULL,
    "focusRequest" TEXT,
    "mathPerception" TEXT NOT NULL,
    "classListening" TEXT NOT NULL,
    "pastAssistance" TEXT NOT NULL,
    "pastAssistanceDuration" TEXT,
    "mainGoals" TEXT NOT NULL,
    "firstMonthTarget" TEXT NOT NULL,
    "studentImportantNotes" TEXT,
    "parentMainGoalYear" TEXT NOT NULL,
    "parentTargetScore" DOUBLE PRECISION,
    "parentAverageScore" DOUBLE PRECISION,
    "motivationLevel" TEXT NOT NULL,
    "successDefinition" TEXT NOT NULL,
    "homeStudyTime" TEXT NOT NULL,
    "hasQuietSpace" BOOLEAN NOT NULL,
    "hasWorkingEquipment" BOOLEAN NOT NULL,
    "siblingsDetails" TEXT,
    "learningDisabilities" TEXT,
    "emotionalDifficulties" TEXT,
    "pastAssistanceExperience" TEXT,
    "progressFeltRating" INTEGER,
    "whatWorkedOrFailed" TEXT,
    "homeLanguage" TEXT,
    "parentInvolvementLevel" INTEGER,
    "parentImportantNotes" TEXT,
    "representativeNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntakeAssessment_studentId_createdAt_idx" ON "IntakeAssessment"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "IntakeAssessment_fallbackLeadId_createdAt_idx" ON "IntakeAssessment"("fallbackLeadId", "createdAt");

-- CreateIndex
CREATE INDEX "IntakeAssessment_representativeId_idx" ON "IntakeAssessment"("representativeId");

-- AddForeignKey
ALTER TABLE "IntakeAssessment" ADD CONSTRAINT "IntakeAssessment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeAssessment" ADD CONSTRAINT "IntakeAssessment_fallbackLeadId_fkey" FOREIGN KEY ("fallbackLeadId") REFERENCES "FallbackLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeAssessment" ADD CONSTRAINT "IntakeAssessment_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

