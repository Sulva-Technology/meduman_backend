-- CreateEnum
CREATE TYPE "TransactionOrigin" AS ENUM ('WEB', 'TELEGRAM', 'WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'X', 'EAAS');

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "origin" "TransactionOrigin" NOT NULL DEFAULT 'WEB';

-- CreateIndex
CREATE INDEX "transactions_origin_createdAt_idx" ON "transactions"("origin", "createdAt");

-- CreateIndex
CREATE INDEX "timeline_events_transactionId_newState_idx" ON "timeline_events"("transactionId", "newState");

-- ---------------------------------------------------------------------------
-- Backfill (best effort — see docs/superpowers/specs/2026-09-11-platform-analytics-design.md).
--
-- Rows created before this migration have no recorded origin, so this
-- RECONSTRUCTS the most likely one. Treat the pre-migration period as an
-- estimate, not authoritative; every row created after this migration carries a
-- recorded origin and needs no estimate.
-- ---------------------------------------------------------------------------

-- EaaS is unambiguous: the tenant column IS the record.
UPDATE "transactions" SET "origin" = 'EAAS'
 WHERE "merchantId" IS NOT NULL;

-- Otherwise attribute to chat ONLY when the seller holds exactly one chat
-- identity. Two identities means the origin is genuinely ambiguous, and a guess
-- would be worse than the WEB default the column already carries.
--
-- The double cast is deliberate: "ChatPlatform" and "TransactionOrigin" are
-- distinct Postgres enum types, so the value must go through text.
UPDATE "transactions" t SET "origin" = (
  SELECT ci."platform"::text::"TransactionOrigin"
    FROM "chat_identities" ci WHERE ci."userId" = t."sellerId"
)
 WHERE t."merchantId" IS NULL
   AND (SELECT COUNT(*) FROM "chat_identities" ci WHERE ci."userId" = t."sellerId") = 1;
