-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'INITIATED';

-- AlterTable
ALTER TABLE "Payment" ALTER COLUMN "status" SET DEFAULT 'INITIATED';
