-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "merchants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "MerchantStatus" NOT NULL DEFAULT 'ACTIVE',
    "livemodeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_api_keys" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "merchant_api_keys_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "users" ADD COLUMN "merchantId" UUID;
ALTER TABLE "seller_profiles" ADD COLUMN "merchantId" UUID;
ALTER TABLE "transactions" ADD COLUMN "merchantId" UUID;
ALTER TABLE "payouts" ADD COLUMN "merchantId" UUID;

-- Indexes
CREATE INDEX "merchants_status_idx" ON "merchants"("status");
CREATE UNIQUE INDEX "merchant_api_keys_keyHash_key" ON "merchant_api_keys"("keyHash");
CREATE INDEX "merchant_api_keys_merchantId_idx" ON "merchant_api_keys"("merchantId");
CREATE INDEX "users_merchantId_idx" ON "users"("merchantId");
CREATE INDEX "seller_profiles_merchantId_idx" ON "seller_profiles"("merchantId");
CREATE INDEX "transactions_merchantId_idx" ON "transactions"("merchantId");
CREATE INDEX "payouts_merchantId_idx" ON "payouts"("merchantId");

-- Foreign keys
ALTER TABLE "merchant_api_keys" ADD CONSTRAINT "merchant_api_keys_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
