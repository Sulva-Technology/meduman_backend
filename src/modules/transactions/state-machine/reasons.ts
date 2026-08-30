/**
 * Typed rejection reason codes for the transaction state machine.
 *
 * The machine NEVER throws a string — a disallowed transition or a failed guard
 * always returns one of these codes so callers can branch on the reason
 * (HTTP status, retry, audit message) without string matching.
 */
export enum RejectionReason {
  /** `from` is a terminal state (COMPLETED / REFUNDED / CANCELLED / EXPIRED). */
  TERMINAL_STATE = 'TERMINAL_STATE',
  /** The event is not a defined edge out of `from`. */
  ILLEGAL_TRANSITION = 'ILLEGAL_TRANSITION',
  /** A PAYMENT_VERIFIED event whose source is CLIENT — only WEBHOOK / SERVER_VERIFY may protect. */
  CLIENT_SOURCE_FORBIDDEN = 'CLIENT_SOURCE_FORBIDDEN',
  /** An open dispute freezes every path into RELEASE_PROCESSING (money rule 5). */
  DISPUTE_OPEN = 'DISPUTE_OPEN',
  /** Auto-confirm attempted, but the transaction's release rule is not AUTO_AFTER_WINDOW. */
  RELEASE_RULE_FORBIDS_AUTO_CONFIRM = 'RELEASE_RULE_FORBIDS_AUTO_CONFIRM',
  /** Auto-confirm attempted before the confirmation window elapsed. */
  AUTO_CONFIRM_WINDOW_NOT_ELAPSED = 'AUTO_CONFIRM_WINDOW_NOT_ELAPSED',
}
