import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import type { Env } from '@/config/env.validation';
import { PaymentsService } from './payments.service';

/**
 * Payment reconciliation (cron). A charge protects on exactly two triggers: the
 * signed `charge.success` webhook, or the buyer's browser returning to the
 * server-verify endpoint. If BOTH are missed — webhook not configured/rejected,
 * buyer closed the tab at the Paystack success screen — a payment that really
 * succeeded at Paystack would sit PENDING forever and the transaction would stay
 * PAYMENT_PENDING with the buyer's money collected.
 *
 * This scan closes that hole: every PENDING charge older than the threshold is
 * re-verified server-side, reusing the SAME verify+protect seam the webhook uses
 * (money rule 2 — a server-side Paystack verify, never a client claim). It is
 * idempotent: an already-SUCCESS payment is a no-op, and an amount mismatch is
 * refused exactly as it is on the webhook path.
 *
 * Nothing here releases funds — it only lets a genuine payment reach
 * PAYMENT_PROTECTED, which is where the normal lifecycle picks it up.
 */
@Injectable()
export class PaymentReconcileService {
  private readonly logger = new Logger(PaymentReconcileService.name);
  private readonly thresholdMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    config: ConfigService<Env, true>,
  ) {
    this.thresholdMs = config.get('PAYMENT_RECONCILE_AFTER_SECONDS', { infer: true }) * 1000;
  }

  /** Re-verify recent stranded charges. Returns how many reached SUCCESS. */
  async reconcilePending(now: Date = new Date()): Promise<{ checked: number; protected: number }> {
    const cutoff = new Date(now.getTime() - this.thresholdMs);

    const stranded = await this.prisma.payment.findMany({
      where: { status: PaymentStatus.PENDING, createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    let protectedCount = 0;
    for (const payment of stranded) {
      try {
        // Resolves the right verification reference per shape (hosted vs a bound
        // DVA charge) and is idempotent — the same core the webhook uses.
        const result = await this.payments.reconcilePayment(payment.id);
        if (result.status === PaymentStatus.SUCCESS) {
          protectedCount++;
          this.logger.log(`Reconciled stranded payment ${payment.id} → SUCCESS`);
        }
      } catch (err) {
        // Amount mismatch (real anomaly — alert-worthy), a Paystack outage, or a
        // transition rejected by the machine. Skip this payment; the next tick
        // retries, and the webhook remains the primary path.
        this.logger.warn(`Reconcile skipped ${payment.id}: ${(err as Error).message}`);
      }
    }

    return { checked: stranded.length, protected: protectedCount };
  }
}
