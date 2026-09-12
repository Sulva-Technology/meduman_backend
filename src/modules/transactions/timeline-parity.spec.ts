import { ActorType, TransactionStatus } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import type { OutboundEventsService } from '@/modules/outbound-events/outbound-events.service';
import { TransactionsService } from './transactions.service';
import { TransitionRejectedError } from './transition-rejected.error';
import {
  transition,
  type TransactionContext,
  type TransactionEvent,
  type TransactionEventType,
} from './state-machine';

const stubOutbound = {
  recordForTransition: () => Promise.resolve(null),
  dispatch: () => Promise.resolve(),
} as unknown as OutboundEventsService;

/**
 * One concrete event per `TransactionEvent['type']`. `satisfies` plus the
 * totality assertion below fail to COMPILE if the union gains a member this list
 * misses — so the matrix cannot silently go stale.
 */
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

type CoveredEventType = (typeof ALL_EVENTS)[number]['type'];
/** Compile-time totality proof. `never` only if the union is fully covered. */
const EVERY_EVENT_TYPE_IS_COVERED: Exclude<TransactionEventType, CoveredEventType> extends never
  ? true
  : never = true;

/** A context that permits every guarded transition, so the matrix is about the
 *  graph rather than about the guards. */
const PERMISSIVE: TransactionContext = {
  releaseRule: 'AUTO_AFTER_WINDOW',
  hasOpenDispute: false,
  autoConfirmWindowElapsed: true,
};

describe('timeline parity', () => {
  it('covers every event type in the union', () => {
    expect(EVERY_EVENT_TYPE_IS_COVERED).toBe(true);
  });

  it('writes exactly one timeline row per permitted transition, and none per rejection', async () => {
    const actor = { id: 'user-1', type: ActorType.USER, role: 'SELLER' };
    const permitted: string[] = [];
    const rejected: string[] = [];

    for (const from of Object.values(TransactionStatus)) {
      for (const event of ALL_EVENTS) {
        const row = {
          id: 'tx-1',
          status: from,
          releaseRule: 'AUTO_AFTER_WINDOW',
          disputes: [],
        };
        const txClient = {
          transaction: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: jest.fn().mockResolvedValue({ ...row }),
          },
          timelineEvent: { create: jest.fn().mockResolvedValue({}) },
          auditLog: { create: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
          transaction: { findUnique: jest.fn().mockResolvedValue(row) },
          $transaction: jest.fn(async (cb: (db: typeof txClient) => Promise<unknown>) =>
            cb(txClient),
          ),
        } as unknown as PrismaService;
        const service = new TransactionsService(prisma, stubOutbound);
        const key = `${from} + ${event.type}`;
        // `apply` derives `hasOpenDispute` from the row and defaults
        // `autoConfirmWindowElapsed` to false; pass the same permissive context
        // the expectation is computed from, or the two would disagree on the
        // window-guarded edges and the matrix would test the guards twice.
        const call = {
          transactionId: 'tx-1',
          event,
          actor,
          context: { hasOpenDispute: false, autoConfirmWindowElapsed: true },
        };

        const expected = transition(from, event, PERMISSIVE);
        if (expected.ok) {
          await service.apply(call);
          // Object equality so a failure names the offending pair.
          expect({ key, written: txClient.timelineEvent.create.mock.calls.length }).toEqual({
            key,
            written: 1,
          });
          permitted.push(key);
        } else {
          await expect(service.apply(call)).rejects.toBeInstanceOf(TransitionRejectedError);
          expect({ key, written: txClient.timelineEvent.create.mock.calls.length }).toEqual({
            key,
            written: 0,
          });
          rejected.push(key);
        }
      }
    }

    // Guards against a vacuous pass: both outcomes must actually occur.
    expect(permitted.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
  });
});
