import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ActorType,
  DisputeStatus,
  type Dispute,
  type DisputeOutcome,
  type DisputeReason,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { TransactionsService } from '@/modules/transactions/transactions.service';
import { QueueService } from '@/modules/queue/queue.service';

/** Statuses in which a dispute still freezes automated release (money rule 5). */
const OPEN_DISPUTE_STATUSES = [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] as const;

export interface RaiseDisputeInput {
  transactionId: string;
  /** User (buyer or seller) who opened it. */
  openedBy: string;
  /** Timeline/audit role tag. */
  role?: string;
  reason: DisputeReason;
  description?: string;
  desiredOutcome?: DisputeOutcome;
}

export interface ResolveDisputeInput {
  disputeId: string;
  /** Admin id resolving it. */
  resolvedBy: string;
  /** RELEASE → funds go to seller; REFUND → funds return to buyer. */
  outcome: 'RELEASE' | 'REFUND';
  resolution?: string;
}

/**
 * Raise / resolve disputes. An OPEN dispute freezes automated release (money
 * rule 5) — enforced in the state machine itself; this service only creates the
 * dispute row and drives the matching transition. Resolution excludes the
 * dispute being resolved when deciding whether release may proceed.
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
    private readonly queue: QueueService,
  ) {}

  async raise(input: RaiseDisputeInput): Promise<Dispute> {
    // Server owns the transition; a wrong-state raise throws before any row is
    // written. RAISE_DISPUTE from DISPUTED is illegal, so this also blocks a
    // second concurrent dispute on the same transaction.
    await this.transactions.apply({
      transactionId: input.transactionId,
      event: { type: 'RAISE_DISPUTE' },
      actor: { id: input.openedBy, type: ActorType.USER, role: input.role ?? 'BUYER' },
      ...(input.description ? { reason: input.description } : {}),
    });

    return this.prisma.dispute.create({
      data: {
        transactionId: input.transactionId,
        openedBy: input.openedBy,
        reason: input.reason,
        status: DisputeStatus.OPEN,
        ...(input.description ? { description: input.description } : {}),
        ...(input.desiredOutcome ? { desiredOutcome: input.desiredOutcome } : {}),
      },
    });
  }

  async resolve(input: ResolveDisputeInput): Promise<Dispute> {
    const dispute = await this.prisma.dispute.findUnique({ where: { id: input.disputeId } });
    if (!dispute) {
      throw new NotFoundException(`Dispute ${input.disputeId} not found`);
    }
    if (!OPEN_DISPUTE_STATUSES.includes(dispute.status as (typeof OPEN_DISPUTE_STATUSES)[number])) {
      throw new BadRequestException(`Dispute ${input.disputeId} is already ${dispute.status}`);
    }

    // Any OTHER still-open dispute keeps release frozen even if this one resolves
    // in the seller's favour. Excludes the dispute being resolved (money rule 5).
    const otherOpen = await this.prisma.dispute.count({
      where: {
        transactionId: dispute.transactionId,
        status: { in: [...OPEN_DISPUTE_STATUSES] },
        id: { not: dispute.id },
      },
    });

    const forSeller = input.outcome === 'RELEASE';
    await this.transactions.apply({
      transactionId: dispute.transactionId,
      event: { type: forSeller ? 'RESOLVE_DISPUTE_FOR_SELLER' : 'RESOLVE_DISPUTE_FOR_BUYER' },
      actor: { id: input.resolvedBy, type: ActorType.ADMIN, role: 'ADMIN' },
      ...(input.resolution ? { reason: input.resolution } : {}),
      context: { hasOpenDispute: otherOpen > 0 },
    });

    // Seller-favour resolution moves the transaction into RELEASE_PROCESSING —
    // enqueue the (idempotent) payout. The buyer-favour path refunds instead.
    if (forSeller) {
      await this.queue.enqueueRelease(dispute.transactionId);
    }

    return this.prisma.dispute.update({
      where: { id: dispute.id },
      data: {
        status: forSeller ? DisputeStatus.RESOLVED_RELEASE : DisputeStatus.RESOLVED_REFUND,
        resolvedAt: new Date(),
        resolvedBy: input.resolvedBy,
        resolution: input.resolution ?? null,
      },
    });
  }
}
