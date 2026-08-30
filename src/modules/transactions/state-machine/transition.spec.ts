import type { ReleaseRule, TransactionStatus } from '@prisma/client';
import {
  RejectionReason,
  TERMINAL_STATES,
  isTerminalState,
  transition,
  type PaymentSource,
  type TransactionContext,
  type TransactionEvent,
} from './index';

/** A permissive default context: no dispute, buyer-confirmation rule, window not elapsed. */
const baseContext = (overrides: Partial<TransactionContext> = {}): TransactionContext => ({
  releaseRule: 'BUYER_CONFIRMATION',
  hasOpenDispute: false,
  autoConfirmWindowElapsed: false,
  ...overrides,
});

/** Every event type in the machine, used to prove the disallowed matrix. */
const ALL_EVENTS: TransactionEvent[] = [
  { type: 'SELLER_PUBLISH' },
  { type: 'CANCEL' },
  { type: 'BUYER_INITIATE_CHECKOUT' },
  { type: 'EXPIRE' },
  { type: 'PAYMENT_VERIFIED', source: 'WEBHOOK' },
  { type: 'PAYMENT_ABANDONED' },
  { type: 'SELLER_START_DELIVERY' },
  { type: 'RAISE_DISPUTE' },
  { type: 'REFUND' },
  { type: 'SELLER_MARK_DELIVERED' },
  { type: 'BUYER_CONFIRM' },
  { type: 'AUTO_CONFIRM' },
  { type: 'RESOLVE_DISPUTE_FOR_SELLER' },
  { type: 'RESOLVE_DISPUTE_FOR_BUYER' },
  { type: 'WITHDRAW_DISPUTE' },
  { type: 'PAYOUT_SUCCEEDED' },
  { type: 'PAYOUT_RETRY' },
  { type: 'ADMIN_INTERVENTION' },
];

interface AllowedCase {
  from: TransactionStatus;
  event: TransactionEvent;
  context?: Partial<TransactionContext>;
  to: TransactionStatus;
}

/** Every allowed transition, one row per edge in the spec diagram. */
const ALLOWED: AllowedCase[] = [
  { from: 'DRAFT', event: { type: 'SELLER_PUBLISH' }, to: 'LINK_ACTIVE' },
  { from: 'DRAFT', event: { type: 'CANCEL' }, to: 'CANCELLED' },

  { from: 'LINK_ACTIVE', event: { type: 'BUYER_INITIATE_CHECKOUT' }, to: 'PAYMENT_PENDING' },
  { from: 'LINK_ACTIVE', event: { type: 'CANCEL' }, to: 'CANCELLED' },
  { from: 'LINK_ACTIVE', event: { type: 'EXPIRE' }, to: 'EXPIRED' },

  {
    from: 'PAYMENT_PENDING',
    event: { type: 'PAYMENT_VERIFIED', source: 'WEBHOOK' },
    to: 'PAYMENT_PROTECTED',
  },
  {
    from: 'PAYMENT_PENDING',
    event: { type: 'PAYMENT_VERIFIED', source: 'SERVER_VERIFY' },
    to: 'PAYMENT_PROTECTED',
  },
  { from: 'PAYMENT_PENDING', event: { type: 'PAYMENT_ABANDONED' }, to: 'LINK_ACTIVE' },
  { from: 'PAYMENT_PENDING', event: { type: 'EXPIRE' }, to: 'EXPIRED' },

  {
    from: 'PAYMENT_PROTECTED',
    event: { type: 'SELLER_START_DELIVERY' },
    to: 'DELIVERY_IN_PROGRESS',
  },
  { from: 'PAYMENT_PROTECTED', event: { type: 'RAISE_DISPUTE' }, to: 'DISPUTED' },
  { from: 'PAYMENT_PROTECTED', event: { type: 'REFUND' }, to: 'REFUNDED' },

  {
    from: 'DELIVERY_IN_PROGRESS',
    event: { type: 'SELLER_MARK_DELIVERED' },
    to: 'CONFIRMATION_PENDING',
  },
  { from: 'DELIVERY_IN_PROGRESS', event: { type: 'RAISE_DISPUTE' }, to: 'DISPUTED' },

  { from: 'CONFIRMATION_PENDING', event: { type: 'BUYER_CONFIRM' }, to: 'RELEASE_PROCESSING' },
  {
    from: 'CONFIRMATION_PENDING',
    event: { type: 'AUTO_CONFIRM' },
    context: { releaseRule: 'AUTO_AFTER_WINDOW', autoConfirmWindowElapsed: true },
    to: 'RELEASE_PROCESSING',
  },
  { from: 'CONFIRMATION_PENDING', event: { type: 'RAISE_DISPUTE' }, to: 'DISPUTED' },

  { from: 'DISPUTED', event: { type: 'RESOLVE_DISPUTE_FOR_SELLER' }, to: 'RELEASE_PROCESSING' },
  { from: 'DISPUTED', event: { type: 'RESOLVE_DISPUTE_FOR_BUYER' }, to: 'REFUNDED' },
  { from: 'DISPUTED', event: { type: 'WITHDRAW_DISPUTE' }, to: 'PAYMENT_PROTECTED' },

  { from: 'RELEASE_PROCESSING', event: { type: 'PAYOUT_SUCCEEDED' }, to: 'COMPLETED' },
  { from: 'RELEASE_PROCESSING', event: { type: 'PAYOUT_RETRY' }, to: 'RELEASE_PROCESSING' },
  { from: 'RELEASE_PROCESSING', event: { type: 'ADMIN_INTERVENTION' }, to: 'DISPUTED' },
];

/** Event types that resolve to a defined (allowed OR guarded) edge for each state. */
const DEFINED_EVENTS: Record<TransactionStatus, ReadonlySet<TransactionEvent['type']>> = {
  DRAFT: new Set(['SELLER_PUBLISH', 'CANCEL']),
  LINK_ACTIVE: new Set(['BUYER_INITIATE_CHECKOUT', 'CANCEL', 'EXPIRE']),
  PAYMENT_PENDING: new Set(['PAYMENT_VERIFIED', 'PAYMENT_ABANDONED', 'EXPIRE']),
  PAYMENT_PROTECTED: new Set(['SELLER_START_DELIVERY', 'RAISE_DISPUTE', 'REFUND']),
  DELIVERY_IN_PROGRESS: new Set(['SELLER_MARK_DELIVERED', 'RAISE_DISPUTE']),
  CONFIRMATION_PENDING: new Set(['BUYER_CONFIRM', 'AUTO_CONFIRM', 'RAISE_DISPUTE']),
  DISPUTED: new Set([
    'RESOLVE_DISPUTE_FOR_SELLER',
    'RESOLVE_DISPUTE_FOR_BUYER',
    'WITHDRAW_DISPUTE',
  ]),
  RELEASE_PROCESSING: new Set(['PAYOUT_SUCCEEDED', 'PAYOUT_RETRY', 'ADMIN_INTERVENTION']),
  COMPLETED: new Set([]),
  REFUNDED: new Set([]),
  CANCELLED: new Set([]),
  EXPIRED: new Set([]),
};

const NON_TERMINAL: TransactionStatus[] = [
  'DRAFT',
  'LINK_ACTIVE',
  'PAYMENT_PENDING',
  'PAYMENT_PROTECTED',
  'DELIVERY_IN_PROGRESS',
  'CONFIRMATION_PENDING',
  'DISPUTED',
  'RELEASE_PROCESSING',
];

describe('transaction state machine — allowed transitions', () => {
  it.each(ALLOWED)('$from --$event.type--> $to', ({ from, event, context, to }) => {
    const result = transition(from, event, baseContext(context));
    expect(result).toEqual({ ok: true, nextState: to });
  });

  it('BUYER_CONFIRM is allowed under any release rule (manual confirm ignores the auto rule)', () => {
    for (const releaseRule of [
      'BUYER_CONFIRMATION',
      'AUTO_AFTER_WINDOW',
      'ADMIN_ONLY',
    ] as ReleaseRule[]) {
      const result = transition(
        'CONFIRMATION_PENDING',
        { type: 'BUYER_CONFIRM' },
        baseContext({ releaseRule }),
      );
      expect(result).toEqual({ ok: true, nextState: 'RELEASE_PROCESSING' });
    }
  });
});

describe('transaction state machine — terminal states', () => {
  it.each([...TERMINAL_STATES])('%s has no outbound transitions for any event', (state) => {
    for (const event of ALL_EVENTS) {
      const result = transition(state, event, baseContext());
      expect(result).toEqual({
        ok: false,
        reason: RejectionReason.TERMINAL_STATE,
        message: expect.any(String),
      });
    }
  });

  it('isTerminalState / TERMINAL_STATES agree', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['CANCELLED', 'COMPLETED', 'EXPIRED', 'REFUNDED']);
    expect(isTerminalState('COMPLETED')).toBe(true);
    expect(isTerminalState('DRAFT')).toBe(false);
  });
});

describe('transaction state machine — disallowed transitions', () => {
  it('rejects every event that is not a defined edge with ILLEGAL_TRANSITION', () => {
    for (const from of NON_TERMINAL) {
      for (const event of ALL_EVENTS) {
        if (DEFINED_EVENTS[from].has(event.type)) continue;
        const result = transition(from, event, baseContext());
        expect(result).toEqual({
          ok: false,
          reason: RejectionReason.ILLEGAL_TRANSITION,
          message: expect.any(String),
        });
      }
    }
  });
});

describe('GUARD 1 — payment source: a client-sourced event can never protect a transaction', () => {
  it('rejects PAYMENT_PENDING + PAYMENT_VERIFIED(CLIENT) with CLIENT_SOURCE_FORBIDDEN', () => {
    const result = transition(
      'PAYMENT_PENDING',
      { type: 'PAYMENT_VERIFIED', source: 'CLIENT' },
      baseContext(),
    );
    expect(result).toEqual({
      ok: false,
      reason: RejectionReason.CLIENT_SOURCE_FORBIDDEN,
      message: expect.any(String),
    });
  });

  it('a CLIENT-sourced payment event never yields PAYMENT_PROTECTED from any state', () => {
    const clientPayment: TransactionEvent = { type: 'PAYMENT_VERIFIED', source: 'CLIENT' };
    for (const from of [...NON_TERMINAL, ...TERMINAL_STATES]) {
      const result = transition(from, clientPayment, baseContext());
      expect(result.ok && result.nextState === 'PAYMENT_PROTECTED').toBe(false);
    }
  });

  it('only WEBHOOK and SERVER_VERIFY protect a transaction', () => {
    const sources: PaymentSource[] = ['WEBHOOK', 'SERVER_VERIFY'];
    for (const source of sources) {
      const result = transition(
        'PAYMENT_PENDING',
        { type: 'PAYMENT_VERIFIED', source },
        baseContext(),
      );
      expect(result).toEqual({ ok: true, nextState: 'PAYMENT_PROTECTED' });
    }
  });
});

describe('GUARD 2 — an open dispute freezes all paths into RELEASE_PROCESSING', () => {
  it('a disputed transaction cannot reach RELEASE_PROCESSING via buyer confirmation', () => {
    const result = transition(
      'CONFIRMATION_PENDING',
      { type: 'BUYER_CONFIRM' },
      baseContext({ hasOpenDispute: true }),
    );
    expect(result).toEqual({
      ok: false,
      reason: RejectionReason.DISPUTE_OPEN,
      message: expect.any(String),
    });
  });

  it('a disputed transaction cannot reach RELEASE_PROCESSING via auto-confirm', () => {
    const result = transition(
      'CONFIRMATION_PENDING',
      { type: 'AUTO_CONFIRM' },
      baseContext({
        releaseRule: 'AUTO_AFTER_WINDOW',
        autoConfirmWindowElapsed: true,
        hasOpenDispute: true,
      }),
    );
    expect(result).toEqual({
      ok: false,
      reason: RejectionReason.DISPUTE_OPEN,
      message: expect.any(String),
    });
  });

  it('a disputed transaction cannot reach RELEASE_PROCESSING via a payout retry', () => {
    const result = transition(
      'RELEASE_PROCESSING',
      { type: 'PAYOUT_RETRY' },
      baseContext({ hasOpenDispute: true }),
    );
    expect(result).toEqual({
      ok: false,
      reason: RejectionReason.DISPUTE_OPEN,
      message: expect.any(String),
    });
  });

  it('resolving for the seller is blocked while another dispute is still open', () => {
    const result = transition(
      'DISPUTED',
      { type: 'RESOLVE_DISPUTE_FOR_SELLER' },
      baseContext({ hasOpenDispute: true }),
    );
    expect(result).toEqual({
      ok: false,
      reason: RejectionReason.DISPUTE_OPEN,
      message: expect.any(String),
    });
  });

  it('NO event that targets RELEASE_PROCESSING succeeds while a dispute is open', () => {
    const targetingRelease: Array<{
      from: TransactionStatus;
      event: TransactionEvent;
      context?: Partial<TransactionContext>;
    }> = [
      { from: 'CONFIRMATION_PENDING', event: { type: 'BUYER_CONFIRM' } },
      {
        from: 'CONFIRMATION_PENDING',
        event: { type: 'AUTO_CONFIRM' },
        context: { releaseRule: 'AUTO_AFTER_WINDOW', autoConfirmWindowElapsed: true },
      },
      { from: 'DISPUTED', event: { type: 'RESOLVE_DISPUTE_FOR_SELLER' } },
      { from: 'RELEASE_PROCESSING', event: { type: 'PAYOUT_RETRY' } },
    ];
    for (const { from, event, context } of targetingRelease) {
      const result = transition(from, event, baseContext({ ...context, hasOpenDispute: true }));
      expect(result.ok).toBe(false);
    }
  });
});

describe('GUARD 3 — auto-confirm only fires under the right rule, window, and no dispute', () => {
  it('rejects auto-confirm when the release rule is BUYER_CONFIRMATION', () => {
    const result = transition(
      'CONFIRMATION_PENDING',
      { type: 'AUTO_CONFIRM' },
      baseContext({ releaseRule: 'BUYER_CONFIRMATION', autoConfirmWindowElapsed: true }),
    );
    expect(result).toEqual({
      ok: false,
      reason: RejectionReason.RELEASE_RULE_FORBIDS_AUTO_CONFIRM,
      message: expect.any(String),
    });
  });

  it('rejects auto-confirm when the release rule is ADMIN_ONLY', () => {
    const result = transition(
      'CONFIRMATION_PENDING',
      { type: 'AUTO_CONFIRM' },
      baseContext({ releaseRule: 'ADMIN_ONLY', autoConfirmWindowElapsed: true }),
    );
    expect(result).toEqual({
      ok: false,
      reason: RejectionReason.RELEASE_RULE_FORBIDS_AUTO_CONFIRM,
      message: expect.any(String),
    });
  });

  it('rejects auto-confirm when the window has not elapsed', () => {
    const result = transition(
      'CONFIRMATION_PENDING',
      { type: 'AUTO_CONFIRM' },
      baseContext({ releaseRule: 'AUTO_AFTER_WINDOW', autoConfirmWindowElapsed: false }),
    );
    expect(result).toEqual({
      ok: false,
      reason: RejectionReason.AUTO_CONFIRM_WINDOW_NOT_ELAPSED,
      message: expect.any(String),
    });
  });

  it('fires auto-confirm only when rule allows AND window elapsed AND no dispute', () => {
    const result = transition(
      'CONFIRMATION_PENDING',
      { type: 'AUTO_CONFIRM' },
      baseContext({
        releaseRule: 'AUTO_AFTER_WINDOW',
        autoConfirmWindowElapsed: true,
        hasOpenDispute: false,
      }),
    );
    expect(result).toEqual({ ok: true, nextState: 'RELEASE_PROCESSING' });
  });

  it('the release-rule check precedes the window check', () => {
    // Wrong rule + window not elapsed → the rule reason wins, deterministically.
    const result = transition(
      'CONFIRMATION_PENDING',
      { type: 'AUTO_CONFIRM' },
      baseContext({ releaseRule: 'BUYER_CONFIRMATION', autoConfirmWindowElapsed: false }),
    );
    expect(result).toEqual({
      ok: false,
      reason: RejectionReason.RELEASE_RULE_FORBIDS_AUTO_CONFIRM,
      message: expect.any(String),
    });
  });
});
