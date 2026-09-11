-- CreateEnum
CREATE TYPE "ChatLinkRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'PENDING_REVIEW', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChatLinkConflictReason" AS ENUM ('SELLER_PROFILE_CONFLICT', 'SELF_TRANSACTION_CONFLICT');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "mergedIntoUserId" UUID;

-- CreateTable
CREATE TABLE "chat_link_requests" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "targetUserId" UUID NOT NULL,
    "platform" "ChatPlatform",
    "platformUserId" TEXT,
    "chatIdentityId" UUID,
    "sourceUserId" UUID,
    "status" "ChatLinkRequestStatus" NOT NULL DEFAULT 'PENDING',
    "conflictReason" "ChatLinkConflictReason",
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_link_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_link_requests_codeHash_key" ON "chat_link_requests"("codeHash");

-- CreateIndex
CREATE INDEX "chat_link_requests_targetUserId_status_idx" ON "chat_link_requests"("targetUserId", "status");

-- CreateIndex
CREATE INDEX "chat_link_requests_status_idx" ON "chat_link_requests"("status");

-- CreateIndex
CREATE INDEX "chat_link_requests_expiresAt_idx" ON "chat_link_requests"("expiresAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_mergedIntoUserId_fkey" FOREIGN KEY ("mergedIntoUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_link_requests" ADD CONSTRAINT "chat_link_requests_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_link_requests" ADD CONSTRAINT "chat_link_requests_chatIdentityId_fkey" FOREIGN KEY ("chatIdentityId") REFERENCES "chat_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

