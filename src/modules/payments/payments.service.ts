import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActorType, PaymentStatus, type Payment } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { PaystackService } from '@/common/paystack';
import { TransactionsService } from '@/modules/transactions/transactions.service';
import { QueueService } from '@/modules/queue/queue.service';
import { InvoicesService } from '@/modules/invoices/invoices.service';
import type { Env } from '@/config/env.validation';
import { AmountMismatchError } from './amount-mismatch.error';

export interface InitializeCollectionInput {
  transactionId?: string | undefined;
  publicLinkId?: string | undefined;
  /** Buyer's user-mirror id (from the verified JWT). */
  buyerId: string;
  /** Buyer email for the Paystack charge. */
  email: string;
}

export interface InitializeCollectionResult {
  paymentId: string;
  reference: string;
  authorizationUrl: string;
}

export interface InitializeVirtualAccountInput {
  transactionId: string;
  buyerId: string;
  email: string;
}

export interface VirtualAccountView {
  paymentId: string;
  /** Null until Paystack assigns the account (async). */
  accountNumber: string | null;
  bankName: string | null;
}

/** Only these two sources may protect a transaction (money rule 2). */
export type TrustedPaymentSource = 'WEBHOOK' | 'SERVER_VERIFY';

/**
 * Inbound collection. Owns the money-rule-2 boundary: a transaction is protected
 * ONLY after a server-side Paystack verify (or a signed webhook that routes
 * here) confirms both success AND the exact expected amount. A client callback —
 * or a chat message — never marks anything paid.
 *
 * Two collection shapes: a hosted checkout (returns an authorization URL) and a
 * dedicated virtual account (the buyer pays by bank transfer from their own app,
 * so the flow never leaves chat). Both converge on the same verify+protect core.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly transactions: TransactionsService,
    private readonly queue: QueueService,
    private readonly config: ConfigService<Env, true>,
    private readonly invoices: InvoicesService,
  ) {}

  /** Charge amount in kobo: protected amount plus the buyer's fee when BUYER_PAYS. */
  private chargeAmountFor(tx: { amount: number; feeModel: string; feeAmount: number }): number {
    return tx.amount + (tx.feeModel === 'BUYER_PAYS' ? tx.feeAmount : 0);
  }

  /**
   * Resolve transaction by either internal id or public link id.
   */
  private async resolveTransaction(input: {
    transactionId?: string | undefined;
    publicLinkId?: string | undefined;
  }) {
    if (input.transactionId) {
      return this.prisma.transaction.findUnique({ where: { id: input.transactionId } });
    }
    if (input.publicLinkId) {
      return this.prisma.transaction.findUnique({ where: { publicLinkId: input.publicLinkId } });
    }
    return null;
  }

  /**
   * Buyer initiates checkout. Drives LINK_ACTIVE -> PAYMENT_PENDING through the
   * machine (server-owned), links the buyer, persists a PENDING payment with a
   * unique provider reference, and opens a Paystack charge.
   */
  async initializeCollection(
    input: InitializeCollectionInput,
  ): Promise<InitializeCollectionResult> {
    const tx = await this.resolveTransaction(input);
    if (!tx) {
      const ref = input.transactionId || input.publicLinkId || 'unknown';
      throw new NotFoundException(`Transaction ${ref} not found`);
    }

    // Server owns the transition. Rejected (wrong state) throws before any charge.
    await this.transactions.apply({
      transactionId: tx.id,
      event: { type: 'BUYER_INITIATE_CHECKOUT' },
      actor: { id: input.buyerId, type: ActorType.USER, role: 'BUYER' },
    });

    if (!tx.buyerId) {
      await this.prisma.transaction.update({
        where: { id: tx.id },
        data: { buyerId: input.buyerId },
      });
    }

    const chargeAmount = this.chargeAmountFor(tx);
    const reference = `mdn_${randomUUID().replace(/-/g, '')}`;

    const payment = await this.prisma.payment.create({
      data: {
        transactionId: tx.id,
        providerReference: reference,
        amount: chargeAmount,
        currency: tx.currency,
        status: PaymentStatus.PENDING,
      },
    });

    const init = await this.paystack.initializeTransaction({
      email: input.email,
      amount: chargeAmount,
      reference,
      callbackUrl: `${this.config.get('APP_URL', { infer: true })}/payments/${reference}/verify`,
      metadata: { transactionId: tx.id, paymentId: payment.id },
    });

    return { paymentId: payment.id, reference, authorizationUrl: init.authorizationUrl };
  }

  /**
   * Buyer pays by bank transfer to a dedicated virtual account — the fully
   * in-chat path. One throwaway Paystack customer per transaction gives one DVA
   * per transaction, so an inbound transfer maps deterministically to one
   * payment. Idempotent: a re-request while a PENDING DVA payment already exists
   * returns that one rather than driving the transition or minting a second
   * customer.
   */
  async initializeVirtualAccount(
    input: InitializeVirtualAccountInput,
  ): Promise<VirtualAccountView> {
    const tx = await this.prisma.transaction.findUnique({ where: { id: input.transactionId } });
    if (!tx) {
      throw new NotFoundException(`Transaction ${input.transactionId} not found`);
    }

    // Re-request guard: reuse an existing PENDING DVA payment for this tx.
    const existing = await this.prisma.payment.findFirst({
      where: {
        transactionId: tx.id,
        status: PaymentStatus.PENDING,
        providerCustomerCode: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return {
        paymentId: existing.id,
        accountNumber: existing.virtualAccountNumber,
        bankName: existing.virtualAccountBank,
      };
    }

    // Server owns the transition (money rule 1). Rejected (wrong state) throws.
    await this.transactions.apply({
      transactionId: tx.id,
      event: { type: 'BUYER_INITIATE_CHECKOUT' },
      actor: { id: input.buyerId, type: ActorType.USER, role: 'BUYER' },
    });
    if (!tx.buyerId) {
      await this.prisma.transaction.update({
        where: { id: tx.id },
        data: { buyerId: input.buyerId },
      });
    }

    const chargeAmount = this.chargeAmountFor(tx);
    const reference = `mdn_dva_${randomUUID().replace(/-/g, '')}`;

    const customer = await this.paystack.createCustomer({ email: input.email });
    const account = await this.paystack.createDedicatedAccount({
      customerCode: customer.customerCode,
    });

    const payment = await this.prisma.payment.create({
      data: {
        transactionId: tx.id,
        providerReference: reference,
        providerCustomerCode: customer.customerCode,
        amount: chargeAmount,
        currency: tx.currency,
        status: PaymentStatus.PENDING,
        ...(account.accountNumber ? { virtualAccountNumber: account.accountNumber } : {}),
        ...(account.bankName ? { virtualAccountBank: account.bankName } : {}),
        ...(account.dedicatedAccountId
          ? { providerDedicatedAccountId: account.dedicatedAccountId }
          : {}),
      },
    });

    return {
      paymentId: payment.id,
      accountNumber: account.accountNumber,
      bankName: account.bankName,
    };
  }

  /**
   * Store the dedicated account details once Paystack assigns them
   * (`dedicatedaccount.assign.success`) and push them to the buyer in chat.
   * Returns null when no matching pending payment exists.
   */
  async attachDedicatedAccount(
    customerCode: string,
    account: { accountNumber: string; bankName: string; dedicatedAccountId?: string },
  ): Promise<Payment | null> {
    const payment = await this.prisma.payment.findFirst({
      where: { providerCustomerCode: customerCode, status: PaymentStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      this.logger.warn(`DVA assign for unknown customer ${customerCode} — ignored`);
      return null;
    }

    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        virtualAccountNumber: account.accountNumber,
        virtualAccountBank: account.bankName,
        ...(account.dedicatedAccountId
          ? { providerDedicatedAccountId: account.dedicatedAccountId }
          : {}),
      },
    });

    const tx = await this.prisma.transaction.findUnique({ where: { id: payment.transactionId } });
    if (tx?.buyerId) {
      await this.queue.enqueueChatOutbound({
        userId: tx.buyerId,
        templateKey: 'payment.dva_assigned',
        data: {
          accountNumber: account.accountNumber,
          bankName: account.bankName,
          amount: payment.amount,
          transactionTitle: tx.title,
        },
      });
    }
    return updated;
  }

  /**
   * Route a `charge.success` to the right payment (money rules 2 & 4). A hosted
   * charge resolves by our reference (which equals Paystack's). A DVA charge
   * carries Paystack's own reference, so it resolves by customer code and binds
   * that reference as a one-shot idempotency lock before verifying. Returns
   * false only when nothing matched.
   */
  async handleChargeSuccess(
    event: { reference: string; customerCode?: string },
    source: TrustedPaymentSource,
  ): Promise<boolean> {
    const hosted = await this.prisma.payment.findUnique({
      where: { providerReference: event.reference },
    });
    if (hosted) {
      await this.verifyAndProtectPayment(hosted, event.reference, source);
      return true;
    }

    if (event.customerCode) {
      const payment = await this.resolveDvaPayment(event.customerCode, event.reference);
      if (payment) {
        await this.verifyAndProtectPayment(payment, event.reference, source);
        return true;
      }
    }

    this.logger.warn(`charge.success ${event.reference} matched no payment`);
    return false;
  }

  /**
   * Resolve the DVA payment for an inbound charge and bind Paystack's reference
   * to it exactly once. The conditional bind (`providerChargeReference: null`) is
   * the idempotency lock: a re-delivered webhook binds nothing and re-reads the
   * already-bound row, so the charge is never counted twice (money rule 4).
   */
  private async resolveDvaPayment(
    customerCode: string,
    chargeReference: string,
  ): Promise<Payment | null> {
    const alreadyBound = await this.prisma.payment.findUnique({
      where: { providerChargeReference: chargeReference },
    });
    if (alreadyBound) return alreadyBound;

    const payment = await this.prisma.payment.findFirst({
      where: { providerCustomerCode: customerCode },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) return null;

    const bound = await this.prisma.payment.updateMany({
      where: { id: payment.id, providerChargeReference: null },
      data: { providerChargeReference: chargeReference },
    });
    if (bound.count !== 1) {
      // Lost the race — another delivery bound it first. Use the winner's row.
      return this.prisma.payment.findUnique({
        where: { providerChargeReference: chargeReference },
      });
    }
    return this.prisma.payment.findUnique({ where: { id: payment.id } });
  }

  /**
   * Server-side verify + protect (money rule 2), against the hosted checkout
   * reference. Kept for the web callback / hosted webhook path.
   */
  async verifyAndProtect(reference: string, source: TrustedPaymentSource): Promise<Payment> {
    const payment = await this.prisma.payment.findUnique({
      where: { providerReference: reference },
    });
    if (!payment) {
      throw new NotFoundException(`Payment ${reference} not found`);
    }
    return this.verifyAndProtectPayment(payment, reference, source);
  }

  /**
   * The shared verify+protect core. Idempotent (money rule 4): an already-SUCCESS
   * payment is a no-op. Verifies the charge at Paystack under `verifyReference`
   * (our reference for hosted, Paystack's for DVA), refuses to protect on any
   * amount mismatch, then drives PAYMENT_VERIFIED with a trusted source. On a
   * fresh protection it pushes a confirmation to the chat participants (a no-op
   * for website-only users with no chat identity).
   */
  private async verifyAndProtectPayment(
    payment: Payment,
    verifyReference: string,
    source: TrustedPaymentSource,
  ): Promise<Payment> {
    if (payment.status === PaymentStatus.SUCCESS) {
      // Already protected — idempotent no-op for the payment itself. Still
      // (re)derive invoice PAID so a prior post-SUCCESS failure heals on retry.
      await this.invoices.markPaidByTransaction(payment.transactionId);
      return payment;
    }

    const verified = await this.paystack.verifyTransaction(verifyReference);

    if (verified.status !== 'success') {
      this.logger.warn(`Payment ${verifyReference} verify returned status=${verified.status}`);
      const nonSuccess =
        verified.status === 'abandoned' ? PaymentStatus.ABANDONED : PaymentStatus.FAILED;
      return this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: nonSuccess, rawPayload: verified.raw as object },
      });
    }

    if (verified.amount !== payment.amount) {
      this.logger.error(
        `Payment ${verifyReference} amount mismatch: expected ${payment.amount}, got ${verified.amount}`,
      );
      throw new AmountMismatchError(verifyReference, payment.amount, verified.amount);
    }

    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.SUCCESS,
        verifiedAt: new Date(),
        rawPayload: verified.raw as object,
      },
    });

    // Drive the protection transition with the trusted source. If the machine
    // rejects (e.g. an open dispute or a racing protect), the payment stays
    // correctly SUCCESS and the state is governed independently.
    await this.transactions.apply({
      transactionId: payment.transactionId,
      event: { type: 'PAYMENT_VERIFIED', source },
      actor: { type: ActorType.SYSTEM, role: 'SYSTEM' },
      reason: `payment ${verifyReference} verified via ${source}`,
    });

    // Derive invoice PAID from the same signed-webhook / server-verify protect
    // event that owns money rule 2, BEFORE the best-effort chat push — a chat
    // enqueue failure must not skip the derivation. No-op when the tx has no
    // invoice; idempotent so a retry after a partial failure heals it.
    await this.invoices.markPaidByTransaction(payment.transactionId);
    await this.notifyProtected(payment.transactionId);
    return updated;
  }

  /** Push "funds protected" to buyer and seller in chat (no-op without identities). */
  private async notifyProtected(transactionId: string): Promise<void> {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!tx) return;
    if (tx.buyerId) {
      await this.queue.enqueueChatOutbound({
        userId: tx.buyerId,
        templateKey: 'payment.protected_buyer',
        data: { transactionTitle: tx.title, amount: tx.amount },
      });
    }
    await this.queue.enqueueChatOutbound({
      userId: tx.sellerId,
      templateKey: 'payment.protected_seller',
      data: { transactionTitle: tx.title, amount: tx.amount },
    });
  }
}
