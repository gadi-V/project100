-- Additive: board images addressed by id. No existing column is dropped or retyped.
-- excalidrawPdfUrl stays for legacy PDF links.

-- CreateTable
CREATE TABLE IF NOT EXISTS "BoardImage" (
    "id" TEXT NOT NULL,
    "notebookId" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoardImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BoardImage_notebookId_idx" ON "BoardImage"("notebookId");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "BoardImage" ADD CONSTRAINT "BoardImage_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "Notebook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "BoardImage" ADD CONSTRAINT "BoardImage_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
