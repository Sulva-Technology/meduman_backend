-- Operator recovery for a failed transfer (decision D-0).
--
-- Paystack refuses to reuse the reference of a transfer that already exists, so
-- a retry after transfer.failed / transfer.reversed must send a NEW reference.
-- The payout row itself is still unique per transaction (idempotencyKey), so the
-- retry never creates a second payout — it only re-sends the same authorized
-- amount under a fresh provider reference, recorded here.

ALTER TABLE "payouts" ADD COLUMN "providerTransferReference" TEXT;

-- One provider reference maps to exactly one payout, so a retry can never
-- collide with another transaction's transfer.
CREATE UNIQUE INDEX "payouts_providerTransferReference_key"
  ON "payouts"("providerTransferReference");

-- Backfill: transfers sent before this column existed used the idempotency key
-- as their reference.
UPDATE "payouts"
  SET "providerTransferReference" = "idempotencyKey"
  WHERE "providerTransferCode" IS NOT NULL;
