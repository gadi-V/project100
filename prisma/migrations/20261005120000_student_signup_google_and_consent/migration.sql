-- AlterTable (additive, nullable)
ALTER TABLE "User" ADD COLUMN     "googleSub" TEXT,
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "whatsappUpdatesConsentAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");
