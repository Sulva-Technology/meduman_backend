-- CreateEnum
CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "OutboundEventStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbound_events" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboundEventStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outbound_events_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "webhook_endpoints_merchantId_key" ON "webhook_endpoints"("merchantId");
CREATE INDEX "outbound_events_status_createdAt_idx" ON "outbound_events"("status", "createdAt");
CREATE INDEX "outbound_events_merchantId_createdAt_idx" ON "outbound_events"("merchantId", "createdAt");

-- Foreign keys
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
