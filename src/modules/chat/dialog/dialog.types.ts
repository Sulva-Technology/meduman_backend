/**
 * Dialog steps. Stored as a plain string on ChatSession so the flow can evolve
 * without a migration. IDLE is the resting state where top-level commands work.
 */
export enum ChatStep {
  IDLE = 'IDLE',
  // Seller creates a transaction
  SELLER_TX_TITLE = 'SELLER_TX_TITLE',
  SELLER_TX_AMOUNT = 'SELLER_TX_AMOUNT',
  SELLER_TX_DESCRIPTION = 'SELLER_TX_DESCRIPTION',
  // Seller onboards a payout destination
  SELLER_PAYOUT_ACCOUNT = 'SELLER_PAYOUT_ACCOUNT',
  // Buyer is expected to type the delivery-confirmation OTP
  BUYER_AWAIT_OTP = 'BUYER_AWAIT_OTP',
  // A dispute is open and the user may send photo/document evidence
  DISPUTE_EVIDENCE = 'DISPUTE_EVIDENCE',
}

/** Partial input gathered across steps. Persisted as ChatSession.draft JSON. */
export interface ChatDraft {
  title?: string;
  amountKobo?: number;
  description?: string;
  /** The dispute currently collecting evidence (DISPUTE_EVIDENCE step). */
  disputeId?: string;
}
