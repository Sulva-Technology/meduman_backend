/**
 * The events that drive the transaction state machine. Each event is the
 * *intent* to transition; the machine decides whether it is permitted.
 *
 * Pure module — no HTTP / Prisma / Paystack types leak in here.
 */

/**
 * Where a payment-verified signal originated. Only WEBHOOK (signed Paystack
 * webhook) and SERVER_VERIFY (server-side Paystack verify call) may protect a
 * transaction. CLIENT is never trusted (money rule 2).
 */
export type PaymentSource = 'WEBHOOK' | 'SERVER_VERIFY' | 'CLIENT';

/** Discriminated union of every transition-driving event. */
export type TransactionEvent =
  | { type: 'SELLER_PUBLISH' } // DRAFT -> LINK_ACTIVE
  | { type: 'CANCEL' } // DRAFT / LINK_ACTIVE -> CANCELLED
  | { type: 'BUYER_INITIATE_CHECKOUT' } // LINK_ACTIVE -> PAYMENT_PENDING
  | { type: 'EXPIRE' } // LINK_ACTIVE / PAYMENT_PENDING -> EXPIRED
  | { type: 'PAYMENT_VERIFIED'; source: PaymentSource } // PAYMENT_PENDING -> PAYMENT_PROTECTED (guarded)
  | { type: 'PAYMENT_ABANDONED' } // PAYMENT_PENDING -> LINK_ACTIVE
  | { type: 'SELLER_START_DELIVERY' } // PAYMENT_PROTECTED -> DELIVERY_IN_PROGRESS
  | { type: 'RAISE_DISPUTE' } // PAYMENT_PROTECTED / DELIVERY_IN_PROGRESS / CONFIRMATION_PENDING -> DISPUTED
  | { type: 'REFUND' } // PAYMENT_PROTECTED -> REFUNDED
  | { type: 'SELLER_MARK_DELIVERED' } // DELIVERY_IN_PROGRESS -> CONFIRMATION_PENDING
  | { type: 'BUYER_CONFIRM' } // CONFIRMATION_PENDING -> RELEASE_PROCESSING (buyer / OTP, guarded)
  | { type: 'AUTO_CONFIRM' } // CONFIRMATION_PENDING -> RELEASE_PROCESSING (window, guarded)
  | { type: 'RESOLVE_DISPUTE_FOR_SELLER' } // DISPUTED -> RELEASE_PROCESSING (guarded)
  | { type: 'RESOLVE_DISPUTE_FOR_BUYER' } // DISPUTED -> REFUNDED
  | { type: 'WITHDRAW_DISPUTE' } // DISPUTED -> PAYMENT_PROTECTED
  | { type: 'PAYOUT_SUCCEEDED' } // RELEASE_PROCESSING -> COMPLETED
  | { type: 'PAYOUT_RETRY' } // RELEASE_PROCESSING -> RELEASE_PROCESSING (guarded)
  | { type: 'ADMIN_INTERVENTION' }; // RELEASE_PROCESSING -> DISPUTED

export type TransactionEventType = TransactionEvent['type'];
