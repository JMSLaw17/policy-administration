-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "paymentReturnId" TEXT;

-- CreateTable
CREATE TABLE "PaymentReturn" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "stripeDisputeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReturn_stripeDisputeId_key" ON "PaymentReturn"("stripeDisputeId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_paymentReturnId_key" ON "LedgerEntry"("paymentReturnId");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_paymentReturnId_fkey" FOREIGN KEY ("paymentReturnId") REFERENCES "PaymentReturn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReturn" ADD CONSTRAINT "PaymentReturn_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReturn" ADD CONSTRAINT "PaymentReturn_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

