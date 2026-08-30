-- Decision D-3 (2026-08-01): remove the SPLIT fee model.
--
-- SPLIT was revenue-losing and inconsistent: the charge side never added the
-- buyer's half (chargeAmount = amount), while the settle side deducted only
-- floor(feeAmount / 2) from the seller — so the platform collected about half
-- the fee it had booked. Two models with unambiguous math replace three.
--
-- Narrowing an enum requires a swap. This fails loudly if any row still holds
-- 'SPLIT', which is intended: such a row's money math was never well defined and
-- must be settled by hand before this migration runs.

ALTER TYPE "FeeModel" RENAME TO "FeeModel_old";

CREATE TYPE "FeeModel" AS ENUM ('BUYER_PAYS', 'SELLER_PAYS');

ALTER TABLE "transactions" ALTER COLUMN "feeModel" DROP DEFAULT;

ALTER TABLE "transactions"
  ALTER COLUMN "feeModel" TYPE "FeeModel" USING ("feeModel"::text::"FeeModel");

ALTER TABLE "transactions" ALTER COLUMN "feeModel" SET DEFAULT 'BUYER_PAYS';

DROP TYPE "FeeModel_old";
