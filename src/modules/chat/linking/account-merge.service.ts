import { Injectable } from '@nestjs/common';
import { ActorType, PayoutStatus, UserStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/modules/audit/audit.service';
import { LinkMergeCollisionError, LinkMergeInFlightError } from './linking.errors';

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

/** What a completed merge moved. Logged to the audit row; returned to the caller. */
export interface MergeReport {
  chatIdentities: number;
  transactionsSold: number;
  transactionsBought: number;
  payouts: number;
  invoicesSold: number;
  invoicesBought: number;
  notifications: number;
  disputes: number;
  evidence: number;
  profileMerged: boolean;
  sellerProfileMoved: boolean;
}

/**
 * Merges an absorbed chat-born account into a real account.
 *
 * The guards live here rather than in the caller so they can run both before the
 * merge (to choose the outcome) and inside it (to close the TOCTOU window).
 */
@Injectable()
export class AccountMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

  /**
   * Absorb `sourceUserId` into `targetUserId` in ONE transaction. Either every
   * row moves and the tombstone is set, or nothing does.
   *
   * The guards re-run inside the transaction: checking outside would leave a
   * window in which a row could be created and slip past the check.
   */
  async merge(
    sourceUserId: string,
    targetUserId: string,
    opts: {
      keepProfile?: 'TARGET' | 'SOURCE';
      /**
       * An admin's explicit ruling that a SELLER_PROFILE_CONFLICT is acceptable —
       * they have chosen which profile survives, so the guard no longer has a
       * decision to make. Deliberately NOT widened to SELF_TRANSACTION_CONFLICT:
       * no choice of profile makes one user a valid counterparty to themselves.
       */
      overrideCollision?: 'SELLER_PROFILE_CONFLICT';
    } = {},
  ): Promise<MergeReport> {
    return this.prisma.$transaction(async (db) => {
      const collision = await this.detectCollision(sourceUserId, targetUserId, db);
      if (collision && collision !== opts.overrideCollision) {
        throw new LinkMergeCollisionError(collision);
      }
      if (await this.hasInFlightPayout([sourceUserId, targetUserId], db)) {
        throw new LinkMergeInFlightError();
      }

      const source = await db.user.findUniqueOrThrow({ where: { id: sourceUserId } });
      const target = await db.user.findUniqueOrThrow({ where: { id: targetUserId } });

      // 1. Identities. A user may have linked more than one platform to the
      //    throwaway, so this is updateMany, not a single row.
      const identities = await db.chatIdentity.updateMany({
        where: { userId: sourceUserId },
        data: { userId: targetUserId },
      });

      // 2. Money ownership travels with the account.
      const transactionsSold = await db.transaction.updateMany({
        where: { sellerId: sourceUserId },
        data: { sellerId: targetUserId },
      });
      const transactionsBought = await db.transaction.updateMany({
        where: { buyerId: sourceUserId },
        data: { buyerId: targetUserId },
      });
      const payouts = await db.payout.updateMany({
        where: { sellerId: sourceUserId },
        data: { sellerId: targetUserId },
      });
      const invoicesSold = await db.invoice.updateMany({
        where: { sellerId: sourceUserId },
        data: { sellerId: targetUserId },
      });
      const invoicesBought = await db.invoice.updateMany({
        where: { buyerId: sourceUserId },
        data: { buyerId: targetUserId },
      });
      const notifications = await db.notification.updateMany({
        where: { userId: sourceUserId },
        data: { userId: targetUserId },
      });

      // 3. Functional participant references. Polymorphic ids rather than FKs, but
      //    they back participant/ownership checks, so they must follow the
      //    account. AuditLog / TimelineEvent actors below are deliberately NOT
      //    touched — those are immutable history (rule 6).
      const disputes = await db.dispute.updateMany({
        where: { openedBy: sourceUserId },
        data: { openedBy: targetUserId },
      });
      const evidence = await db.evidence.updateMany({
        where: { uploadedBy: sourceUserId },
        data: { uploadedBy: targetUserId },
      });

      // 4. Profile is 1:1 with a unique userId — the two rows cannot coexist.
      const profileMerged = await this.mergeProfile(db, sourceUserId, targetUserId, opts);

      // 5. SellerProfile is 1:1 too. Two of them is a SELLER_PROFILE_CONFLICT — the
      //    only way past that guard is an admin's explicit override, and they have
      //    already chosen whose payout destination survives.
      const sourceSeller = await db.sellerProfile.findUnique({ where: { userId: sourceUserId } });
      let sellerProfileMoved = false;
      if (sourceSeller) {
        const targetSeller = await db.sellerProfile.findUnique({
          where: { userId: targetUserId },
        });
        if (targetSeller) {
          // One account cannot hold two payout destinations. The survivor keeps its
          // own; the absorbed account's is discarded rather than left behind with a
          // live `providerRecipientCode` that a later path could read (rule 4). The
          // transfers it already made survive in the Payout rows.
          await db.sellerProfile.delete({ where: { userId: sourceUserId } });
        } else {
          await db.sellerProfile.update({
            where: { userId: sourceUserId },
            data: { userId: targetUserId },
          });
          sellerProfileMoved = true;
        }
      }

      // 6. Surviving user fields. The target's own values always win; the source
      //    only fills gaps.
      await db.user.update({
        where: { id: targetUserId },
        data: {
          roleFlags: { set: [...new Set([...target.roleFlags, ...source.roleFlags])] },
          ...((target.phone ?? source.phone) ? { phone: target.phone ?? source.phone } : {}),
        },
      });

      // 7. Tombstone — never a hard delete (legal retention; Payout.sellerId and
      //    Invoice.sellerId are Restrict FKs, and audit actors still reference it).
      await db.user.update({
        where: { id: sourceUserId },
        data: {
          status: UserStatus.DEACTIVATED,
          mergedIntoUserId: targetUserId,
          mergedAt: new Date(),
        },
      });

      const report: MergeReport = {
        chatIdentities: identities.count,
        transactionsSold: transactionsSold.count,
        transactionsBought: transactionsBought.count,
        payouts: payouts.count,
        invoicesSold: invoicesSold.count,
        invoicesBought: invoicesBought.count,
        notifications: notifications.count,
        disputes: disputes.count,
        evidence: evidence.count,
        profileMerged,
        sellerProfileMoved,
      };

      // 8. Rule 6. The row counts make the merge auditable after the fact.
      await this.audit.log(
        {
          action: 'chat.account_linked',
          targetType: 'User',
          targetId: targetUserId,
          actorId: targetUserId,
          actorType: ActorType.USER,
          metadata: { sourceUserId, ...report },
        },
        db,
      );

      return report;
    });
  }

  /**
   * Move or fold the 1:1 profile. `keepProfile: 'SOURCE'` is the admin's explicit
   * choice in a review; the default keeps the target's values and fills only its
   * nulls.
   */
  private async mergeProfile(
    db: Prisma.TransactionClient,
    sourceUserId: string,
    targetUserId: string,
    opts: { keepProfile?: 'TARGET' | 'SOURCE' },
  ): Promise<boolean> {
    const source = await db.profile.findUnique({ where: { userId: sourceUserId } });
    if (!source) {
      return false;
    }
    const target = await db.profile.findUnique({ where: { userId: targetUserId } });

    if (!target) {
      await db.profile.update({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      return true;
    }

    const winner = opts.keepProfile === 'SOURCE' ? source : target;
    const loser = opts.keepProfile === 'SOURCE' ? target : source;

    // A Json column has no useful field-wise merge, so carry over whichever side
    // set one and leave the target's own value alone if neither did. The key is
    // omitted rather than set to undefined — `exactOptionalPropertyTypes` is on.
    const channelLinks = winner.channelLinks ?? loser.channelLinks;

    await db.profile.update({
      where: { userId: targetUserId },
      data: {
        country: winner.country ?? loser.country,
        city: winner.city ?? loser.city,
        avatarUrl: winner.avatarUrl ?? loser.avatarUrl,
        bio: winner.bio ?? loser.bio,
        ...(channelLinks ? { channelLinks } : {}),
      },
    });
    await db.profile.delete({ where: { userId: sourceUserId } });
    return true;
  }
}
