-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'DENIED', 'PAID');

-- AlterTable
ALTER TABLE "Policy" ADD COLUMN     "commissionRateBps" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN     "renewedFromId" TEXT;

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "claimNumber" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "coverageCode" TEXT NOT NULL,
    "lossDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "claimedCents" INTEGER NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'SUBMITTED',
    "approvedLossCents" INTEGER,
    "deductibleCents" INTEGER,
    "limitCents" INTEGER,
    "payoutCents" INTEGER,
    "decisionNote" TEXT,
    "filedById" TEXT NOT NULL,
    "filedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Claim_claimNumber_key" ON "Claim"("claimNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_renewedFromId_key" ON "Policy"("renewedFromId");

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_renewedFromId_fkey" FOREIGN KEY ("renewedFromId") REFERENCES "Policy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_filedById_fkey" FOREIGN KEY ("filedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

