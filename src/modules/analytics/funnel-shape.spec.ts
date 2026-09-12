import { TransactionStatus } from '@prisma/client';
import {
  transition,
  type TransactionContext,
  type TransactionEvent,
  type TransactionEventType,
} from '@/modules/transactions/state-machine';

/**
 * The funnel's shape, derived rather than asserted.
 *
 * The analytics design claims the stage counts form a monotonically decreasing
 * sequence. Most of that claim is true, but **`delivered >= released` is not** —
 * a dispute resolved for the seller reaches `COMPLETED` without ever passing
 * through `CONFIRMATION_PENDING`. This spec proves that from the transition
 * function itself, so the corrected understanding cannot quietly rot back into
 * the false guarantee.
 *
 * Pure: no Prisma, no I/O, no database. It runs everywhere.
 */

/** One concrete event per `TransactionEvent['type']`. */
const ALL_EVENTS = [
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
] as const satisfies readonly TransactionEvent[];

/**
 * Compile-time totality proof: `never` only if the union is fully covered, so
 * the graph below cannot silently go stale.
 */
type CoveredEventType = (typeof ALL_EVENTS)[number]['type'];
const EVERY_EVENT_TYPE_IS_COVERED: Exclude<TransactionEventType, CoveredEventType> extends never
  ? true
  : never = true;

/** Guards open: no dispute, window elapsed, a rule that permits auto-confirm. */
const PERMISSIVE: TransactionContext = {
  releaseRule: 'AUTO_AFTER_WINDOW',
  hasOpenDispute: false,
  autoConfirmWindowElapsed: true,
};

const ALL_STATES = Object.values(TransactionStatus) as TransactionStatus[];

/** `from -> to`, one edge per event the machine permits. */
function edges(): Map<TransactionStatus, Set<TransactionStatus>> {
  const graph = new Map<TransactionStatus, Set<TransactionStatus>>();
  for (const from of ALL_STATES) {
    const out = new Set<TransactionStatus>();
    for (const event of ALL_EVENTS) {
      const result = transition(from, event, PERMISSIVE);
      if (result.ok) {
        out.add(result.nextState);
      }
    }
    graph.set(from, out);
  }
  return graph;
}

/**
 * Breadth-first, so the witness path returned is the shortest one — which makes
 * a failure message readable rather than a random walk.
 */
function shortestPath(
  to: TransactionStatus,
  avoid: TransactionStatus[] = [],
): TransactionStatus[] | null {
  const graph = edges();
  const banned = new Set(avoid);
  if (banned.has('DRAFT')) {
    return null;
  }
  const queue: TransactionStatus[][] = [['DRAFT']];
  const seen = new Set<TransactionStatus>(['DRAFT']);
  while (queue.length > 0) {
    const path = queue.shift() as TransactionStatus[];
    const tail = path[path.length - 1] as TransactionStatus;
    if (tail === to) {
      return path;
    }
    for (const next of graph.get(tail) ?? []) {
      if (banned.has(next) || seen.has(next)) {
        continue;
      }
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

describe('funnel shape — derived from the transition function', () => {
  it('COMPLETED is reachable', () => {
    // Read here as well as at compile time, so the totality proof is not a
    // vacuous declaration and the graph below cannot drift from the union.
    expect(EVERY_EVENT_TYPE_IS_COVERED).toBe(true);
    expect(ALL_EVENTS).toHaveLength(18);
    expect(shortestPath(TransactionStatus.COMPLETED)).not.toBeNull();
  });

  it('EVERY path to COMPLETED passes through RELEASE_PROCESSING', () => {
    // The part of the design's cumulative claim that IS true, and the contrast
    // that shows the test below is discriminating rather than trivially green.
    expect(
      shortestPath(TransactionStatus.COMPLETED, [TransactionStatus.RELEASE_PROCESSING]),
    ).toBeNull();
  });

  it('a transaction can be RELEASED without ever being DELIVERED — the counterexample', () => {
    // This is the finding: `delivered >= released` is NOT an invariant of the
    // funnel, because a dispute resolved for the seller skips CONFIRMATION_PENDING
    // entirely. A real transaction takes this path:
    const path = shortestPath(TransactionStatus.COMPLETED, [
      TransactionStatus.CONFIRMATION_PENDING,
    ]);
    expect(path).toEqual([
      'DRAFT',
      'LINK_ACTIVE',
      'PAYMENT_PENDING',
      'PAYMENT_PROTECTED',
      'DISPUTED',
      'RELEASE_PROCESSING',
      'COMPLETED',
    ]);
    expect(path).not.toContain('CONFIRMATION_PENDING');
  });

  it('so `released` can exceed `delivered` for a cohort containing such a dispute', () => {
    // Two transactions on one platform: one delivered-then-released (older flow),
    // one disputed-then-released. delivered = 1, released = 2 — the per-origin row
    // is NOT monotone, and a chart that assumes it is would lie.
    const deliveredThenReleased = ['CONFIRMATION_PENDING', 'RELEASE_PROCESSING', 'COMPLETED'];
    const disputedThenReleased = ['DISPUTED', 'RELEASE_PROCESSING', 'COMPLETED'];
    const reached = (tx: string[], state: string) => tx.includes(state);
    const cohort = [deliveredThenReleased, disputedThenReleased];

    const delivered = cohort.filter((tx) => reached(tx, 'CONFIRMATION_PENDING')).length;
    const released = cohort.filter((tx) => reached(tx, 'COMPLETED')).length;

    expect(delivered).toBe(1);
    expect(released).toBe(2);
    expect(released).toBeGreaterThan(delivered);
  });

  it('the earlier stages ARE cumulative — every path into PAYMENT_PROTECTED passes through PAYMENT_PENDING', () => {
    // The half of the design's claim the funnel genuinely relies on, so the
    // abandoned-payment case is a counting question rather than a shape question.
    expect(
      shortestPath(TransactionStatus.PAYMENT_PROTECTED, [TransactionStatus.PAYMENT_PENDING]),
    ).toBeNull();
    expect(
      shortestPath(TransactionStatus.PAYMENT_PROTECTED, [TransactionStatus.LINK_ACTIVE]),
    ).toBeNull();
  });

  it('but NOT through CONFIRMATION_PENDING — protected and released are not adjacent stages', () => {
    // The asymmetry, stated positively: the funnel is cumulative *up to*
    // protected, and after that it forks.
    expect(
      shortestPath(TransactionStatus.PAYMENT_PROTECTED, [TransactionStatus.CONFIRMATION_PENDING]),
    ).not.toBeNull();
  });
});
