-- Decision D-0 (2026-08-01): automated payout initiation.
--
-- A seller is paid by a Paystack transfer to their own recipient code, created
-- once from a bank-resolved NUBAN account. Only the recipient code and masked
-- details are stored — the full account number is never persisted.

ALTER TABLE "seller_profiles"
  ADD COLUMN "providerRecipientCode" TEXT,
  ADD COLUMN "settlementBankCode" TEXT,
  ADD COLUMN "settlementAccountLast4" TEXT,
  ADD COLUMN "settlementAccountName" TEXT;

-- One payout destination per seller, and no destination shared between sellers.
CREATE UNIQUE INDEX "seller_profiles_providerRecipientCode_key"
  ON "seller_profiles"("providerRecipientCode");
