-- Chat-native bot gateway (slice 1).
-- Additive only: new enum, new chat tables, new nullable columns on payments.
-- Safe to apply to a populated database — no existing column is altered or dropped.

-- New chat channels for outbound notifications.
ALTER TYPE "NotificationChannel" ADD VALUE IF NOT EXISTS 'TELEGRAM';
ALTER TYPE "NotificationChannel" ADD VALUE IF NOT EXISTS 'INSTAGRAM';
ALTER TYPE "NotificationChannel" ADD VALUE IF NOT EXISTS 'MESSENGER';

-- Social platforms the gateway speaks.
CREATE TYPE "ChatPlatform" AS ENUM ('TELEGRAM', 'WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'X');

-- Dedicated-virtual-account collection fields on payments (all nullable).
ALTER TABLE "payments"
  ADD COLUMN "providerChargeReference"    TEXT,
  ADD COLUMN "providerCustomerCode"       TEXT,
  ADD COLUMN "providerDedicatedAccountId" TEXT,
  ADD COLUMN "virtualAccountNumber"       TEXT,
  ADD COLUMN "virtualAccountBank"         TEXT;

-- One Paystack charge reference maps to at most one payment; nullable so binding
-- it is a one-shot idempotency lock (money rule 4).
CREATE UNIQUE INDEX "payments_providerChargeReference_key"
  ON "payments"("providerChargeReference");

-- chat_identities: platform account -> Meduman user (Supabase auth uuid).
CREATE TABLE "chat_identities" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "platform"       "ChatPlatform" NOT NULL,
  "platformUserId" TEXT NOT NULL,
  "userId"         UUID NOT NULL,
  "displayName"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chat_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_identities_platform_platformUserId_key"
  ON "chat_identities"("platform", "platformUserId");
CREATE INDEX "chat_identities_userId_idx" ON "chat_identities"("userId");

ALTER TABLE "chat_identities"
  ADD CONSTRAINT "chat_identities_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- chat_sessions: conversational state (never transaction state), one per identity.
CREATE TABLE "chat_sessions" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "chatIdentityId" UUID NOT NULL,
  "step"           TEXT NOT NULL DEFAULT 'IDLE',
  "draft"          JSONB,
  "transactionId"  UUID,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_sessions_chatIdentityId_key"
  ON "chat_sessions"("chatIdentityId");
CREATE INDEX "chat_sessions_expiresAt_idx" ON "chat_sessions"("expiresAt");

ALTER TABLE "chat_sessions"
  ADD CONSTRAINT "chat_sessions_chatIdentityId_fkey"
  FOREIGN KEY ("chatIdentityId") REFERENCES "chat_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- chat_inbound_events: inbound-message idempotency (mirrors webhook_events).
CREATE TABLE "chat_inbound_events" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "platform"          "ChatPlatform" NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "rawPayload"        JSONB NOT NULL,
  "processedAt"       TIMESTAMP(3),
  "processingResult"  TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_inbound_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_inbound_events_platform_providerMessageId_key"
  ON "chat_inbound_events"("platform", "providerMessageId");
CREATE INDEX "chat_inbound_events_processedAt_idx" ON "chat_inbound_events"("processedAt");
