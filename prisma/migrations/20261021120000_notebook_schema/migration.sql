-- Additive: one notebook per student, pages, and optional lesson page range.
-- excalidrawPdfUrl is left in place for legacy PDF links.

-- CreateTable
CREATE TABLE IF NOT EXISTS "Notebook" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notebook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "NotebookPage" (
    "id" TEXT NOT NULL,
    "notebookId" TEXT NOT NULL,
    "pageIndex" INTEGER NOT NULL,
    "paperStyle" TEXT NOT NULL,
    "snapshotPath" TEXT,
    "snapshotVersion" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "NotebookPage_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN IF NOT EXISTS "notebookId" TEXT;
ALTER TABLE "Lesson" ADD COLUMN IF NOT EXISTS "startPage" INTEGER;
ALTER TABLE "Lesson" ADD COLUMN IF NOT EXISTS "endPage" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Notebook_studentId_key" ON "Notebook"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "NotebookPage_notebookId_pageIndex_key" ON "NotebookPage"("notebookId", "pageIndex");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lesson_notebookId_idx" ON "Lesson"("notebookId");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Notebook" ADD CONSTRAINT "Notebook_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "NotebookPage" ADD CONSTRAINT "NotebookPage_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "Notebook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "Notebook"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
