import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PayoutStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { PaystackService } from '@/common/paystack';
import { PaymentsService } from '@/modules/payments/payments.service';
import { PayoutsService } from '@/modules/payouts/payouts.service';
import type { Env } from '@/config/env.validation';

export interface WebhookResult {
  received: true;
  duplicate?: boolean;
  handled?: boolean;
  /** Signed but older than WEBHOOK_MAX_AGE_SECONDS — accepted (200) but not processed. */
  stale?: boolean;
}

interface PaystackWebhookPayload {
  event: string;
  data?: {
    id?: string | number;
    reference?: string;
    transfer_code?: string;
    status?: string;
    /** Failure detail on transfer.failed / transfer.reversed. */
    reason?: string;
    /** Present on charge / dedicated-account events. */
    customer?: { customer_code?: string };
    /** Present on dedicatedaccount.assign.success. */
    dedicated_account?: {
      id?: string | number;
      account_number?: string;
      bank?: { name?: string };
    };
    // Timestamps live inside the HMAC-signed body, so they can't be forged on a
    // replay. Field name varies by event type.
    paid_at?: string;
    created_at?: string;
    createdAt?: string;
  };
}

/**
 * Transfer webhooks (`transfer.*`) carry the `reference` we set when initiating
 * the transfer. Settlement MUST use the payout idempotency key
 * (`release:<transactionId>`) as that reference so this handler can close the
 * loop — see PayoutsService (manual payout mode).
 */

/**
 * Paystack signed-webhook processor. Two safety layers:
 *  - HMAC verification of the raw body (money rule 2) — an unsigned/forged event
 *    never reaches business logic.
 *  - WebhookEvent(providerEventId unique) dedupe (money rule 4) — a re-delivered
 *    event is recorded once and never processed twice.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly payments: PaymentsService,
    private readonly payouts: PayoutsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async handlePaystackEvent(rawBody: Buffer, signature: string): Promise<WebhookResult> {
    if (!this.paystack.verifyWebhookSignature(rawBody, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as PaystackWebhookPayload;
    const data = payload.data ?? {};

    // Replay backstop: a signed but stale event (older than the window) is
    // accepted with 200 — so Paystack stops retrying — but never processed. The
    // timestamp is inside the signed body, so a replay can't forge a fresh one.
    if (this.isStale(data)) {
      this.logger.warn(`Stale webhook ${payload.event} ignored (older than window)`);
      return { received: true, stale: true };
    }

    const providerEventId = `${payload.event}:${data.id ?? data.reference ?? 'unknown'}`;

    // Dedupe: the unique providerEventId is the idempotency guard.
    let webhookEventId: string;
    try {
      const record = await this.prisma.webhookEvent.create({
        data: {
          providerEventId,
          eventType: payload.event,
          rawPayload: payload as unknown as Prisma.InputJsonValue,
        },
      });
      webhookEventId = record.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.log(`Duplicate webhook ${providerEventId} ignored`);
        return { received: true, duplicate: true };
      }
      if ((err as { code?: string }).code === 'P2002') {
        this.logger.log(`Duplicate webhook ${providerEventId} ignored`);
        return { received: true, duplicate: true };
      }
      throw err;
    }

    let handled = false;
    try {
      handled = await this.route(payload);
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { processedAt: new Date(), processingResult: handled ? 'ok' : 'unhandled' },
      });
    } catch (err) {
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { processedAt: new Date(), processingResult: `error: ${(err as Error).message}` },
      });
      throw err;
    }

    return { received: true, handled };
  }

  /**
   * True if the event carries a timestamp older than WEBHOOK_MAX_AGE_SECONDS.
   * When no timestamp is present there is nothing to age-check, so it is not stale.
   */
  private isStale(data: NonNullable<PaystackWebhookPayload['data']>): boolean {
    const stamp = data.paid_at ?? data.created_at ?? data.createdAt;
    if (!stamp) {
      return false;
    }
    const ts = Date.parse(stamp);
    if (Number.isNaN(ts)) {
      return false;
    }
    const maxAgeMs = this.config.get('WEBHOOK_MAX_AGE_SECONDS', { infer: true }) * 1000;
    return Date.now() - ts > maxAgeMs;
  }

  /** Returns true if the event was dispatched to a handler. */
  private async route(payload: PaystackWebhookPayload): Promise<boolean> {
    const reference = payload.data?.reference;
    switch (payload.event) {
      case 'charge.success':
        if (reference) {
          // Hosted (our reference) and DVA (Paystack's reference + customer code)
          // both route here; PaymentsService resolves which payment it is.
          return this.payments.handleChargeSuccess(
            {
              reference,
              ...(payload.data?.customer?.customer_code
                ? { customerCode: payload.data.customer.customer_code }
                : {}),
            },
            'WEBHOOK',
          );
        }
        return false;
      case 'dedicatedaccount.assign.success': {
        const customerCode = payload.data?.customer?.customer_code;
        const acct = payload.data?.dedicated_account;
        if (customerCode && acct?.account_number) {
          await this.payments.attachDedicatedAccount(customerCode, {
            accountNumber: acct.account_number,
            bankName: acct.bank?.name ?? 'bank',
            ...(acct.id !== undefined ? { dedicatedAccountId: String(acct.id) } : {}),
          });
          return true;
        }
        return false;
      }
      case 'transfer.success': {
        const transferCode = payload.data?.transfer_code;
        if (reference && transferCode) {
          // reference == the payout idempotency key (release:<transactionId>).
          await this.payouts.markPaid(reference, transferCode);
          return true;
        }
        return false;
      }
      case 'transfer.failed':
      case 'transfer.reversed': {
        if (!reference) return false;
        // The money did not reach the seller. Record it and stop — the
        // transaction stays frozen in RELEASE_PROCESSING for an operator to
        // retry or refund. Never completed off a failure event.
        const status =
          payload.event === 'transfer.reversed' ? PayoutStatus.REVERSED : PayoutStatus.FAILED;
        const reason =
          payload.data?.reason ?? payload.data?.status ?? `Paystack reported ${payload.event}`;
        await this.payouts.markFailed(reference, status, reason);
        this.logger.error(`Payout ${reference} ${payload.event}: ${reason}`);
        return true;
      }
      default:
        this.logger.log(`Unhandled Paystack event ${payload.event}`);
        return false;
    }
  }
}
