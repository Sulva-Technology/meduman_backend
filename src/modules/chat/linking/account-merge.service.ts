import { Injectable } from '@nestjs/common';
import { PayoutStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

/** A collision that refuses the merge and parks it for an admin. */
export type MergeCollisionKind = 'SELLER_PROFILE_CONFLICT' | 'SELF_TRANSACTION_CONFLICT';

/**
 * Any Prisma client — the root client or a `$transaction` client. Collision
 * checks must run INSIDE the merge's transaction, or a row could be created
 * between the check and the write and slip past it.
 */
export type MergeDb = Pick<
  Prisma.TransactionClient,
  'sellerProfile' | 'transaction' | 'invoice' | 'payout'
>;

/** Payout statuses that mean a transfer may be in flight right now. */
const NON_TERMINAL_PAYOUT: PayoutStatus[] = [PayoutStatus.PENDING, PayoutStatus.PROCESSING];

/**
 * Merges an absorbed chat-born account into a real account.
 *
 * The guards live here rather than in the caller so they can run both before the
 * merge (to choose the outcome) and inside it (to close the TOCTOU window).
 */
@Injectable()
export class AccountMergeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hard collisions. Both mean the merge would produce an account the domain
   * considers invalid, so neither is auto-resolvable — the caller parks the
   * request as PENDING_REVIEW for an admin.
   */
  async detectCollision(
    sourceUserId: string,
    targetUserId: string,
    db: MergeDb = this.prisma,
  ): Promise<MergeCollisionKind | null> {
    // Two seller profiles means two payout destinations. Picking one silently
    // discards the other, which is not a decision this code should make.
    const [sourceSeller, targetSeller] = await Promise.all([
      db.sellerProfile.findUnique({ where: { userId: sourceUserId } }),
      db.sellerProfile.findUnique({ where: { userId: targetUserId } }),
    ]);
    if (sourceSeller && targetSeller) {
      return 'SELLER_PROFILE_CONFLICT';
    }

    // One user on both sides of the same escrow is structurally invalid — there
    // is no counterparty, so release has no meaning.
    const pair = [
      { sellerId: sourceUserId, buyerId: targetUserId },
      { sellerId: targetUserId, buyerId: sourceUserId },
    ];
    const selfTransaction = await db.transaction.findFirst({ where: { OR: pair } });
    if (selfTransaction) {
      return 'SELF_TRANSACTION_CONFLICT';
    }

    const selfInvoice = await db.invoice.findFirst({ where: { OR: pair } });
    if (selfInvoice) {
      return 'SELF_TRANSACTION_CONFLICT';
    }

    return null;
  }

  /**
   * Transient, not a conflict: a transfer may be mid-send, and the destination is
   * read from the seller's profile at send time. Re-parenting `Payout.sellerId`
   * underneath it could change where the money lands (rule 4). The caller refuses
   * without consuming the code so the user can simply retry.
   */
  async hasInFlightPayout(userIds: string[], db: MergeDb = this.prisma): Promise<boolean> {
    const inFlight = await db.payout.findFirst({
      where: { sellerId: { in: userIds }, status: { in: NON_TERMINAL_PAYOUT } },
    });
    return inFlight !== null;
  }
}
