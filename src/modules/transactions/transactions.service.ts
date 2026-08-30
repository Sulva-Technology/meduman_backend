import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ActorType,
  Dispute,
  DisputeStatus,
  FeeModel,
  Payout,
  ReleaseRule,
  TimelineEvent,
  Transaction,
  TransactionStatus,
  TrustLevel,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { OutboundEventsService } from '@/modules/outbound-events/outbound-events.service';
import {
  RejectionReason,
  transition,
  type TransactionContext,
  type TransactionEvent,
} from './state-machine';
import { TransitionRejectedError } from './transition-rejected.error';

/** Who is driving the transition — used for the timeline + audit rows (rule 6). */
export interface TransitionActor {
  /** Actor id (user/admin). Omitted for automated system events (cron/webhook). */
  id?: string;
  /** Actor class for the audit row. */
  type: ActorType;
  /** Human-facing role tag for the timeline (BUYER / SELLER / ADMIN / SYSTEM). */
  role?: string;
}

export interface ApplyTransitionInput {
  transactionId: string;
  event: TransactionEvent;
  actor: TransitionActor;
  /** Optional free-text reason recorded on the timeline + audit rows. */
  reason?: string;
  /**
   * Context the service cannot derive from the row alone. `hasOpenDispute`
   * overrides the derived value (e.g. a dispute-resolution flow that must
   * exclude the dispute it is resolving). `autoConfirmWindowElapsed` is supplied
   * by the caller that knows the timing (the auto-confirm cron).
   */
  context?: { hasOpenDispute?: boolean; autoConfirmWindowElapsed?: boolean };
}

/** Input for creating a seller's draft transaction. Amounts are integer kobo. */
export interface CreateDraftInput {
  sellerId: string;
  title: string;
  amount: number;
  description?: string;
  currency?: string;
  releaseRule?: ReleaseRule;
  feeModel?: FeeModel;
  feeAmount?: number;
  expectedDeliveryDate?: Date;
  merchantId?: string;
}

/** Query options for a role-scoped transaction list (cursor pagination). */
export interface ListTransactionsOptions {
  role: 'buyer' | 'seller';
  status?: TransactionStatus;
  cursor?: string;
  limit?: number;
}

/** Lean, allow-listed projection for the UNAUTHENTICATED public pay page. */
export interface PublicTransactionView {
  publicLinkId: string;
  title: string;
  description: string | null;
  amount: number; // kobo
  currency: string;
  feeModel: FeeModel;
  feeAmount: number; // kobo
  status: TransactionStatus;
  seller: { displayName: string | null; trustLevel: TrustLevel | null; verified: boolean };
}

/** Payout projection safe to return to a participant — no idempotency secrets. */
export interface PayoutView {
  id: string;
  amount: number;
  currency: string;
  status: Payout['status'];
  attemptCount: number;
  createdAt: Date;
}

/**
 * Statuses for which the public pay page may render the link. Any other status
 * (paid, disputed, closed, cancelled) returns 404 — we never confirm a link
 * exists in a state where showing it leaks information or invites a double-pay.
 */
const PUBLIC_VISIBLE_STATUSES = ['LINK_ACTIVE', 'PAYMENT_PENDING'] as const;

/** Dispute statuses that freeze automated release (money rule 5). */
const FREEZING_DISPUTE_STATUSES = [
  'OPEN',
  'UNDER_REVIEW',
] as const satisfies readonly DisputeStatus[];

/** Timeline event `type` string per driving event. */
const TIMELINE_TYPE: Record<TransactionEvent['type'], string> = {
  SELLER_PUBLISH: 'link.activated',
  CANCEL: 'transaction.cancelled',
  BUYER_INITIATE_CHECKOUT: 'payment.initiated',
  EXPIRE: 'transaction.expired',
  PAYMENT_VERIFIED: 'payment.protected',
  PAYMENT_ABANDONED: 'payment.abandoned',
  SELLER_START_DELIVERY: 'delivery.started',
  RAISE_DISPUTE: 'dispute.raised',
  REFUND: 'transaction.refunded',
  SELLER_MARK_DELIVERED: 'delivery.marked',
  BUYER_CONFIRM: 'delivery.confirmed',
  AUTO_CONFIRM: 'delivery.auto_confirmed',
  RESOLVE_DISPUTE_FOR_SELLER: 'dispute.resolved_release',
  RESOLVE_DISPUTE_FOR_BUYER: 'dispute.resolved_refund',
  WITHDRAW_DISPUTE: 'dispute.withdrawn',
  PAYOUT_SUCCEEDED: 'payout.completed',
  PAYOUT_RETRY: 'payout.retry',
  ADMIN_INTERVENTION: 'admin.intervention',
};

/**
 * Thin wrapper over the pure state machine. Loads the transaction, calls the
 * machine, and — only on a permitted transition — writes the new status, a
 * TimelineEvent, and an AuditLog row inside a single Prisma transaction. If the
 * machine rejects, it throws {@link TransitionRejectedError} and writes nothing.
 *
 * The server is the sole owner of TransactionStatus (money rule 1): the caller
 * supplies an intent (event), never a target status.
 */
@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundEventsService,
  ) {}

  /**
   * Create a seller's DRAFT transaction. The server generates the unguessable
   * public link id — never the client. Status always starts at DRAFT; it can
   * only advance through the machine (money rule 1).
   */
  async createDraft(input: CreateDraftInput): Promise<Transaction> {
    return this.prisma.transaction.create({
      data: {
        sellerId: input.sellerId,
        title: input.title,
        amount: input.amount,
        publicLinkId: randomUUID().replace(/-/g, ''),
        status: 'DRAFT',
        ...(input.description ? { description: input.description } : {}),
        ...(input.currency ? { currency: input.currency } : {}),
        ...(input.releaseRule ? { releaseRule: input.releaseRule } : {}),
        ...(input.feeModel ? { feeModel: input.feeModel } : {}),
        ...(input.feeAmount !== undefined ? { feeAmount: input.feeAmount } : {}),
        ...(input.expectedDeliveryDate ? { expectedDeliveryDate: input.expectedDeliveryDate } : {}),
        ...(input.merchantId ? { merchantId: input.merchantId } : {}),
      },
    });
  }

  /** Load a transaction or throw 404. */
  async getById(id: string): Promise<Transaction> {
    const tx = await this.prisma.transaction.findUnique({ where: { id } });
    if (!tx) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }
    return tx;
  }

  /** Load a transaction for a merchant or throw 404 if not found or owned by another merchant. */
  async getByIdForMerchant(merchantId: string, id: string): Promise<Transaction> {
    const tx = await this.prisma.transaction.findFirst({ where: { id, merchantId } });
    if (!tx) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }
    return tx;
  }

  /**
   * Public pay-page projection. Unauthenticated: exposes only an allow-listed
   * subset and only in payable states. `publicLinkId` is a 32-char random hex,
   * not a UUID — do not validate it as one.
   */
  async getPublicByLinkId(publicLinkId: string): Promise<PublicTransactionView> {
    const tx = await this.prisma.transaction.findUnique({
      where: { publicLinkId },
      include: { seller: { include: { sellerProfile: true } } },
    });
    if (
      !tx ||
      !PUBLIC_VISIBLE_STATUSES.includes(tx.status as (typeof PUBLIC_VISIBLE_STATUSES)[number])
    ) {
      throw new NotFoundException('Payment link not found or no longer active');
    }
    return {
      publicLinkId: tx.publicLinkId,
      title: tx.title,
      description: tx.description,
      amount: tx.amount,
      currency: tx.currency,
      feeModel: tx.feeModel,
      feeAmount: tx.feeAmount,
      status: tx.status,
      seller: {
        displayName: tx.seller.sellerProfile?.businessName ?? tx.seller.fullName ?? null,
        trustLevel: tx.seller.sellerProfile?.trustLevel ?? null,
        verified: tx.seller.sellerProfile?.verificationStatus === 'VERIFIED',
      },
    };
  }

  /**
   * Role-scoped list for a dashboard. The caller's id is ALWAYS intersected with
   * the filter, so a buyer can never enumerate another user's transactions.
   * Cursor pagination on id (stable secondary sort under createdAt).
   */
  async listForUser(
    userId: string,
    opts: ListTransactionsOptions,
  ): Promise<{ items: Transaction[]; nextCursor: string | null }> {
    const take = opts.limit ?? 20;
    const where = {
      ...(opts.role === 'buyer' ? { buyerId: userId } : { sellerId: userId }),
      ...(opts.status ? { status: opts.status } : {}),
    };
    const rows = await this.prisma.transaction.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1, // +1 sentinel to detect a next page
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, take);
    const last = items.at(-1);
    const nextCursor = rows.length > take && last ? last.id : null;
    return { items, nextCursor };
  }

  /** Merchant-scoped list with cursor pagination. Filters by merchantId and optional status. */
  async listForMerchant(
    merchantId: string,
    opts: { status?: TransactionStatus; cursor?: string; limit?: number },
  ): Promise<{ items: Transaction[]; nextCursor: string | null }> {
    const take = opts.limit ?? 20;
    const rows = await this.prisma.transaction.findMany({
      where: { merchantId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, take);
    const last = items.at(-1);
    const nextCursor = rows.length > take && last ? last.id : null;
    return { items, nextCursor };
  }

  /** User-facing timeline for one transaction (oldest first). 404 if missing. */
  async getTimeline(id: string): Promise<TimelineEvent[]> {
    await this.getById(id);
    return this.prisma.timelineEvent.findMany({
      where: { transactionId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Disputes on one transaction (newest first). 404 if the tx is missing. */
  async getDisputesForTx(id: string): Promise<Dispute[]> {
    await this.getById(id);
    return this.prisma.dispute.findMany({
      where: { transactionId: id },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Payouts on one transaction, projected without idempotency secrets (rule 4). */
  async getPayoutsForTx(id: string): Promise<PayoutView[]> {
    await this.getById(id);
    const payouts = await this.prisma.payout.findMany({
      where: { transactionId: id },
      orderBy: { createdAt: 'desc' },
    });
    return payouts.map((p) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      attemptCount: p.attemptCount,
      createdAt: p.createdAt,
    }));
  }

  async apply(input: ApplyTransitionInput): Promise<Transaction> {
    const { transactionId, event, actor, reason } = input;

    const tx = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { disputes: { where: { status: { in: [...FREEZING_DISPUTE_STATUSES] } } } },
    });
    if (!tx) {
      throw new NotFoundException(`Transaction ${transactionId} not found`);
    }

    const context: TransactionContext = {
      releaseRule: tx.releaseRule,
      hasOpenDispute: input.context?.hasOpenDispute ?? tx.disputes.length > 0,
      autoConfirmWindowElapsed: input.context?.autoConfirmWindowElapsed ?? false,
    };

    const result = transition(tx.status, event, context);
    if (!result.ok) {
      // Machine rejected — nothing is written.
      throw new TransitionRejectedError(result.reason, result.message);
    }
    const nextState = result.nextState;

    let outboundEventId: string | null = null;
    const updatedTx = await this.prisma.$transaction(async (db) => {
      // Optimistic guard: only flip if still in the state we decided from.
      // A duplicate/racing event finds count 0 and the whole tx rolls back.
      const updated = await db.transaction.updateMany({
        where: { id: transactionId, status: tx.status },
        data: { status: nextState },
      });
      if (updated.count !== 1) {
        throw new TransitionRejectedError(
          RejectionReason.ILLEGAL_TRANSITION,
          `Transaction ${transactionId} changed state concurrently`,
        );
      }

      await db.timelineEvent.create({
        data: {
          transactionId,
          actorId: actor.id ?? null,
          actorRole: actor.role ?? null,
          type: TIMELINE_TYPE[event.type],
          oldState: tx.status,
          newState: nextState,
          ...(reason ? { metadata: { reason } } : {}),
        },
      });

      await db.auditLog.create({
        data: {
          actorId: actor.id ?? null,
          actorType: actor.type,
          action: 'transaction.status_change',
          targetType: 'Transaction',
          targetId: transactionId,
          reason: reason ?? null,
          metadata: { event: event.type, from: tx.status, to: nextState },
        },
      });

      outboundEventId = await this.outbound.recordForTransition(db, event.type, {
        id: tx.id,
        status: nextState,
        amount: tx.amount,
        currency: tx.currency,
        title: tx.title,
        merchantId: tx.merchantId,
      });

      return db.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    });
    if (outboundEventId) {
      await this.outbound.dispatch(outboundEventId);
    }
    return updatedTx;
  }
}
