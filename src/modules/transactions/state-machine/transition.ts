import type { TransactionStatus } from '@prisma/client';
import type { TransactionContext } from './context';
import type { TransactionEvent } from './events';
import { RejectionReason } from './reasons';

/**
 * Result of a transition attempt. Either a permitted move to `nextState`, or a
 * typed rejection carrying a `reason` code (never a thrown string).
 */
export type TransitionResult =
  | { ok: true; nextState: TransactionStatus }
  | { ok: false; reason: RejectionReason; message: string };

/** The four states with no outbound transitions. */
export const TERMINAL_STATES = [
  'COMPLETED',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED',
] as const satisfies readonly TransactionStatus[];

const TERMINAL_SET: ReadonlySet<TransactionStatus> = new Set(TERMINAL_STATES);

export const isTerminalState = (state: TransactionStatus): boolean => TERMINAL_SET.has(state);

const accept = (nextState: TransactionStatus): TransitionResult => ({ ok: true, nextState });

const reject = (reason: RejectionReason, message: string): TransitionResult => ({
  ok: false,
  reason,
  message,
});

const illegal = (from: TransactionStatus, event: TransactionEvent): TransitionResult =>
  reject(RejectionReason.ILLEGAL_TRANSITION, `Event ${event.type} is not permitted from ${from}`);

/**
 * The single choke point for entering RELEASE_PROCESSING. An open dispute
 * freezes every path in (money rule 5), checked here in the machine itself —
 * not only in the service layer. Applied uniformly to buyer confirmation,
 * auto-confirm, seller-favour dispute resolution, and payout retries.
 */
const enterReleaseProcessing = (context: TransactionContext): TransitionResult =>
  context.hasOpenDispute
    ? reject(
        RejectionReason.DISPUTE_OPEN,
        'Cannot enter RELEASE_PROCESSING while a dispute is open',
      )
    : accept('RELEASE_PROCESSING');

/**
 * Auto-confirm (CONFIRMATION_PENDING -> RELEASE_PROCESSING with no buyer action)
 * fires only if the release rule allows it AND the window has elapsed AND no
 * dispute is open. The rule check precedes the window check so the reason is
 * deterministic.
 */
const autoConfirm = (context: TransactionContext): TransitionResult => {
  if (context.releaseRule !== 'AUTO_AFTER_WINDOW') {
    return reject(
      RejectionReason.RELEASE_RULE_FORBIDS_AUTO_CONFIRM,
      `Auto-confirm not permitted under release rule ${context.releaseRule}`,
    );
  }
  if (!context.autoConfirmWindowElapsed) {
    return reject(
      RejectionReason.AUTO_CONFIRM_WINDOW_NOT_ELAPSED,
      'Auto-confirm window has not elapsed',
    );
  }
  return enterReleaseProcessing(context);
};

/**
 * Pure transition function. Given the current state, an event, and a context
 * snapshot, returns the next state or a typed rejection. No side effects, no
 * I/O — this is the money-critical core and must stay dependency-free.
 */
export function transition(
  from: TransactionStatus,
  event: TransactionEvent,
  context: TransactionContext,
): TransitionResult {
  switch (from) {
    case 'DRAFT':
      switch (event.type) {
        case 'SELLER_PUBLISH':
          return accept('LINK_ACTIVE');
        case 'CANCEL':
          return accept('CANCELLED');
        default:
          return illegal(from, event);
      }

    case 'LINK_ACTIVE':
      switch (event.type) {
        case 'BUYER_INITIATE_CHECKOUT':
          return accept('PAYMENT_PENDING');
        case 'CANCEL':
          return accept('CANCELLED');
        case 'EXPIRE':
          return accept('EXPIRED');
        default:
          return illegal(from, event);
      }

    case 'PAYMENT_PENDING':
      switch (event.type) {
        case 'PAYMENT_VERIFIED':
          // Money rule 2: only a signed webhook or a server-side verify may protect.
          if (event.source === 'CLIENT') {
            return reject(
              RejectionReason.CLIENT_SOURCE_FORBIDDEN,
              'A client-sourced payment event can never protect a transaction',
            );
          }
          return accept('PAYMENT_PROTECTED');
        case 'PAYMENT_ABANDONED':
          return accept('LINK_ACTIVE');
        case 'EXPIRE':
          return accept('EXPIRED');
        default:
          return illegal(from, event);
      }

    case 'PAYMENT_PROTECTED':
      switch (event.type) {
        case 'SELLER_START_DELIVERY':
          return accept('DELIVERY_IN_PROGRESS');
        case 'RAISE_DISPUTE':
          return accept('DISPUTED');
        case 'REFUND':
          return accept('REFUNDED');
        default:
          return illegal(from, event);
      }

    case 'DELIVERY_IN_PROGRESS':
      switch (event.type) {
        case 'SELLER_MARK_DELIVERED':
          return accept('CONFIRMATION_PENDING');
        case 'RAISE_DISPUTE':
          return accept('DISPUTED');
        default:
          return illegal(from, event);
      }

    case 'CONFIRMATION_PENDING':
      switch (event.type) {
        case 'BUYER_CONFIRM':
          return enterReleaseProcessing(context);
        case 'AUTO_CONFIRM':
          return autoConfirm(context);
        case 'RAISE_DISPUTE':
          return accept('DISPUTED');
        default:
          return illegal(from, event);
      }

    case 'DISPUTED':
      switch (event.type) {
        case 'RESOLVE_DISPUTE_FOR_SELLER':
          return enterReleaseProcessing(context);
        case 'RESOLVE_DISPUTE_FOR_BUYER':
          return accept('REFUNDED');
        case 'WITHDRAW_DISPUTE':
          return accept('PAYMENT_PROTECTED');
        default:
          return illegal(from, event);
      }

    case 'RELEASE_PROCESSING':
      switch (event.type) {
        case 'PAYOUT_SUCCEEDED':
          return accept('COMPLETED');
        case 'PAYOUT_RETRY':
          return enterReleaseProcessing(context);
        case 'ADMIN_INTERVENTION':
          return accept('DISPUTED');
        default:
          return illegal(from, event);
      }

    case 'COMPLETED':
    case 'REFUNDED':
    case 'CANCELLED':
    case 'EXPIRED':
      return reject(
        RejectionReason.TERMINAL_STATE,
        `${from} is terminal and has no outbound transitions`,
      );
  }
}
