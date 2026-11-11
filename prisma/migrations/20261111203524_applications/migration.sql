-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('AWAITING_SIGNATURE', 'SIGNED', 'ISSUED', 'VOIDED');

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "coverageCodes" TEXT[],
    "premiumCents" INTEGER NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'AWAITING_SIGNATURE',
    "docusignEnvelopeId" TEXT,
    "signerName" TEXT NOT NULL,
    "signerEmail" TEXT NOT NULL,
    "signerUserId" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3),
    "policyId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Application_docusignEnvelopeId_key" ON "Application"("docusignEnvelopeId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_policyId_key" ON "Application"("policyId");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
