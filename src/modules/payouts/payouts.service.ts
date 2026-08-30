import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ActorType,
  DisputeStatus,
  PayoutStatus,
  TransactionStatus,
  type FeeModel,
  type Payout,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { PaystackService } from '@/common/paystack/paystack.service';
import { AuditService } from '@/modules/audit/audit.service';
import { TransactionsService } from '@/modules/transactions/transactions.service';

/** Deterministic idempotency key — one release authorization per transaction (rule 4). */
export const releaseIdempotencyKey = (transactionId: string): string => `release:${transactionId}`;

/**
 * Seller settlement amount in kobo. BUYER_PAYS → seller keeps the full protected
 * amount (the buyer already paid the fee on top at collection). SELLER_PAYS →
 * the fee is deducted here. Integer kobo throughout, never a float.
 */
function sellerSettlement(amount: number, feeModel: FeeModel, feeAmount: number): number {
  switch (feeModel) {
    case 'BUYER_PAYS':
      return amount;
    case 'SELLER_PAYS':
      return amount - feeAmount;
    default:
      return amount;
  }
}

/**
 * Idempotent release execution (money rules 3, 4 & 5).
 *
 * `executeRelease` authorizes exactly one payout per transaction, and only while
 * the transaction sits in RELEASE_PROCESSING — a state the machine reaches only
 * through a valid release event (buyer/auto confirm, or seller-favour dispute
 * resolution) — then sends the Paystack transfer for it. `markPaid` records the
 * confirmed transfer and completes the transaction; `markFailed` records a
 * failed or reversed one without completing anything. All are safe to call
 * repeatedly.
 *
 * Disbursement is automated (decision D-0): the transfer goes out of the
 * platform balance to the seller's own recipient code, keyed by the payout's
 * idempotency key. That key is also the Paystack `reference`, so the provider
 * dedupes a resend even if our own guard were bypassed — two independent locks
 * on the one operation that must never happen twice.
 */
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
    private readonly paystack: PaystackService,
    private readonly audit: AuditService,
  ) {}

  async executeRelease(transactionId: string): Promise<Payout> {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!tx) {
      throw new NotFoundException(`Transaction ${transactionId} not found`);
    }
    if (tx.status !== TransactionStatus.RELEASE_PROCESSING) {
      throw new Error(
        `Transaction ${transactionId} is ${tx.status}, expected RELEASE_PROCESSING before payout`,
      );
    }

    // Rule 5, defence in depth: the machine already refuses to enter
    // RELEASE_PROCESSING under an open dispute, but a dispute raised in the
    // window before the job runs must still stop the money leaving.
    const openDisputes = await this.prisma.dispute.count({
      where: { transactionId: tx.id, status: DisputeStatus.OPEN },
    });
    if (openDisputes > 0) {
      throw new ConflictException(
        `Transaction ${transactionId} has an open dispute — release is frozen`,
      );
    }

    const payout = await this.authorizePayout(tx);
    return this.sendTransfer(payout);
  }

  /** Create the single payout row for this transaction, or reuse the existing one (rule 4). */
  private async authorizePayout(tx: {
    id: string;
    sellerId: string;
    amount: number;
    currency: string;
    feeModel: FeeModel;
    feeAmount: number;
    merchantId?: string | null;
  }): Promise<Payout> {
    const idempotencyKey = releaseIdempotencyKey(tx.id);
    const amount = sellerSettlement(tx.amount, tx.feeModel, tx.feeAmount);

    try {
      return await this.prisma.payout.create({
        data: {
          transactionId: tx.id,
          sellerId: tx.sellerId,
          idempotencyKey,
          amount,
          currency: tx.currency,
          status: PayoutStatus.PENDING,
          // Tenancy travels with the money: an EaaS payout inherits the owning
          // merchant from the transaction. Derived server-side, never client-
          // supplied; null keeps first-party payouts unchanged.
          ...(tx.merchantId ? { merchantId: tx.merchantId } : {}),
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        // A payout was already authorized for this transaction — reuse it (rule 4).
        this.logger.log(`Release for ${tx.id} already authorized — reusing payout`);
        const existing = await this.prisma.payout.findUnique({ where: { idempotencyKey } });
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * Send the authorized payout to Paystack. A payout that already settled, or
   * already carries a transfer code, is returned untouched — the transfer is
   * sent at most once per transaction (rule 4).
   */
  private async sendTransfer(payout: Payout, reference?: string): Promise<Payout> {
    if (payout.status === PayoutStatus.SUCCESS || payout.providerTransferCode) {
      return payout;
    }

    // First attempt reuses the idempotency key, so Paystack's own reference
    // dedupe backs up our unique constraint. A retry passes a fresh reference —
    // the provider rejects a reused one once a transfer exists for it.
    const providerReference = reference ?? payout.idempotencyKey;

    const seller = await this.prisma.sellerProfile.findUnique({
      where: { userId: payout.sellerId },
    });
    if (!seller?.providerRecipientCode) {
      // Funds stay held. The seller must onboard a payout destination; the job
      // retries and then dead-letters for an operator rather than losing money.
      throw new UnprocessableEntityException(
        `Seller ${payout.sellerId} has no payout destination — transfer not sent`,
      );
    }

    try {
      const transfer = await this.paystack.initiateTransfer({
        amount: payout.amount,
        recipient: seller.providerRecipientCode,
        reference: providerReference,
        reason: `Meduman release ${payout.transactionId}`,
      });
      return await this.recordTransferSent(payout, transfer.transferCode, providerReference);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // The reference may already exist because we sent it and then died before
      // persisting the code. Adopt that transfer instead of paying again.
      const existing = await this.paystack.verifyTransfer(providerReference);
      if (existing) {
        this.logger.warn(
          `Transfer for ${providerReference} already existed at Paystack — adopting ${existing.transferCode}`,
        );
        return this.recordTransferSent(payout, existing.transferCode, providerReference);
      }

      this.logger.error(`Transfer for ${providerReference} failed: ${message}`);
      await this.prisma.payout.update({
        where: { idempotencyKey: payout.idempotencyKey },
        data: { lastError: message, attemptCount: { increment: 1 } },
      });
      await this.audit.log({
        action: 'payout.transfer_send_failed',
        targetType: 'Payout',
        targetId: payout.id,
        actorType: ActorType.SYSTEM,
        reason: message,
        metadata: {
          transactionId: payout.transactionId,
          idempotencyKey: payout.idempotencyKey,
          amount: payout.amount,
        },
      });
      throw err;
    }
  }

  private async recordTransferSent(
    payout: Payout,
    providerTransferCode: string,
    providerTransferReference: string,
  ): Promise<Payout> {
    const updated = await this.prisma.payout.update({
      where: { idempotencyKey: payout.idempotencyKey },
      data: {
        providerTransferCode,
        providerTransferReference,
        status: PayoutStatus.PROCESSING,
        attemptCount: { increment: 1 },
        lastError: null,
      },
    });

    // Rule 6: money leaving the platform balance is an auditable event in its
    // own right, even though the transaction state does not change until the
    // signed transfer.success webhook lands.
    await this.audit.log({
      action: 'payout.transfer_sent',
      targetType: 'Payout',
      targetId: payout.id,
      actorType: ActorType.SYSTEM,
      metadata: {
        transactionId: payout.transactionId,
        idempotencyKey: payout.idempotencyKey,
        amount: payout.amount,
        providerTransferCode,
      },
    });

    return updated;
  }

  /**
   * Re-send a payout whose transfer failed or was reversed. Admin-triggered —
   * automated retry is deliberately absent, because a transfer that the bank
   * rejected usually needs a human to look at why before money moves again.
   *
   * Two guards make a double-release impossible: only a FAILED/REVERSED payout
   * is eligible (never one in flight or settled), and the previous reference is
   * verified at Paystack first — if that transfer actually succeeded, the payout
   * is completed from it instead of paying again. The retry re-sends the same
   * authorized amount on the same payout row; only the provider reference is
   * new, because Paystack will not accept a used one.
   */
  async retryTransfer(idempotencyKey: string, adminId: string): Promise<Payout> {
    const payout = await this.prisma.payout.findUnique({ where: { idempotencyKey } });
    if (!payout) {
      throw new NotFoundException(`Payout ${idempotencyKey} not found`);
    }
    if (payout.status === PayoutStatus.SUCCESS) {
      throw new ConflictException(`Payout ${idempotencyKey} already settled — nothing to retry`);
    }
    if (payout.status !== PayoutStatus.FAILED && payout.status !== PayoutStatus.REVERSED) {
      throw new ConflictException(
        `Payout ${idempotencyKey} is ${payout.status} — only a failed or reversed transfer can be retried`,
      );
    }

    // Rule 5: a dispute raised after the failure must stop the retry too.
    const openDisputes = await this.prisma.dispute.count({
      where: { transactionId: payout.transactionId, status: DisputeStatus.OPEN },
    });
    if (openDisputes > 0) {
      throw new ConflictException(
        `Transaction ${payout.transactionId} has an open dispute — release is frozen`,
      );
    }

    // The failure webhook and Paystack can disagree. Trust Paystack.
    const priorReference = payout.providerTransferReference ?? payout.idempotencyKey;
    const prior = await this.paystack.verifyTransfer(priorReference);
    if (prior?.status === 'success') {
      this.logger.warn(
        `Retry for ${idempotencyKey} aborted — transfer ${prior.transferCode} had in fact succeeded`,
      );
      await this.audit.log({
        action: 'payout.retry_aborted_already_paid',
        targetType: 'Payout',
        targetId: payout.id,
        actorId: adminId,
        actorType: ActorType.ADMIN,
        reason: `Provider reports ${priorReference} succeeded`,
        metadata: { transactionId: payout.transactionId, providerTransferCode: prior.transferCode },
      });
      return this.markPaid(idempotencyKey, prior.transferCode);
    }

    const nextReference = `${payout.idempotencyKey}:r${payout.attemptCount + 1}`;
    await this.audit.log({
      action: 'payout.transfer_retried',
      targetType: 'Payout',
      targetId: payout.id,
      actorId: adminId,
      actorType: ActorType.ADMIN,
      reason: payout.lastError ?? `Retry after ${payout.status}`,
      metadata: {
        transactionId: payout.transactionId,
        amount: payout.amount,
        previousReference: priorReference,
        providerTransferReference: nextReference,
      },
    });

    // Clear the dead transfer code so the send guard lets this through.
    const reset = await this.prisma.payout.update({
      where: { idempotencyKey },
      data: { status: PayoutStatus.PENDING, providerTransferCode: null, lastError: null },
    });

    return this.sendTransfer(reset, nextReference);
  }

  /**
   * Record a failed or reversed transfer (signed webhook only). The transaction
   * is deliberately left in RELEASE_PROCESSING: the money did not reach the
   * seller, so nothing may be completed, and an operator decides whether to
   * retry or refund. A payout that already settled is never downgraded (rule 4).
   */
  async markFailed(
    idempotencyKey: string,
    status: typeof PayoutStatus.FAILED | typeof PayoutStatus.REVERSED,
    reason: string,
  ): Promise<Payout> {
    const payout = await this.prisma.payout.findUnique({ where: { idempotencyKey } });
    if (!payout) {
      throw new NotFoundException(`Payout ${idempotencyKey} not found`);
    }
    if (payout.status === PayoutStatus.SUCCESS) {
      this.logger.warn(`Ignoring ${status} for ${idempotencyKey} — payout already settled`);
      return payout;
    }

    const updated = await this.prisma.payout.update({
      where: { idempotencyKey },
      data: { status, lastError: reason },
    });

    await this.audit.log({
      action:
        status === PayoutStatus.REVERSED ? 'payout.transfer_reversed' : 'payout.transfer_failed',
      targetType: 'Payout',
      targetId: payout.id,
      actorType: ActorType.SYSTEM,
      reason,
      metadata: {
        transactionId: payout.transactionId,
        idempotencyKey,
        amount: payout.amount,
      },
    });

    return updated;
  }

  /**
   * Record a confirmed transfer and complete the transaction. Idempotent: an
   * already-SUCCESS payout is a no-op, so a re-delivered transfer webhook or a
   * retried job can never double-complete (rule 4).
   */
  async markPaid(idempotencyKey: string, providerTransferCode: string): Promise<Payout> {
    const payout = await this.prisma.payout.findUnique({ where: { idempotencyKey } });
    if (!payout) {
      throw new NotFoundException(`Payout ${idempotencyKey} not found`);
    }
    if (payout.status === PayoutStatus.SUCCESS) {
      return payout;
    }

    const updated = await this.prisma.payout.update({
      where: { idempotencyKey },
      data: {
        status: PayoutStatus.SUCCESS,
        providerTransferCode,
      },
    });

    await this.transactions.apply({
      transactionId: payout.transactionId,
      event: { type: 'PAYOUT_SUCCEEDED' },
      actor: { type: ActorType.SYSTEM, role: 'SYSTEM' },
      reason: `payout ${idempotencyKey} settled (${providerTransferCode})`,
    });

    return updated;
  }
}
