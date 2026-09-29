-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "attendanceMarkedAt" TIMESTAMP(3),
ADD COLUMN     "attendanceMarkedById" TEXT,
ADD COLUMN     "attendanceStatus" TEXT;

-- CreateTable
CREATE TABLE "StudentProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "grade" TEXT,
    "studyGroup" TEXT,
    "nationalId" TEXT,
    "city" TEXT,
    "birthDate" TIMESTAMP(3),
    "invoiceName" TEXT,
    "invoiceTaxId" TEXT,
    "studentStatus" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "statusUpdatedAt" TIMESTAMP(3),
    "statusUpdatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentCommunicationLog" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "courseContext" TEXT,
    "content" TEXT NOT NULL,
    "structuredData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentCommunicationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudentProfile_userId_key" ON "StudentProfile"("userId");

-- CreateIndex
CREATE INDEX "StudentCommunicationLog_studentId_createdAt_idx" ON "StudentCommunicationLog"("studentId", "createdAt");

-- AddForeignKey
ALTER TABLE "StudentProfile" ADD CONSTRAINT "StudentProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentCommunicationLog" ADD CONSTRAINT "StudentCommunicationLog_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

