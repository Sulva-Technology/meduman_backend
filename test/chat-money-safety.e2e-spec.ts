import { createHmac } from 'node:crypto';
import { ChatPlatform, TransactionStatus } from '@prisma/client';
import { PaymentsService } from '@/modules/payments/payments.service';
import { TransactionsService } from '@/modules/transactions/transactions.service';
import { WebhooksService } from '@/modules/webhooks/webhooks.service';
import { ChatInboundService } from '@/modules/chat/gateway/chat-inbound.service';
import { ActorType } from '@prisma/client';
import type { MoneyE2EContext } from './utils/e2e-harness';

/**
 * End-to-end proof that the chat-native surface cannot weaken the money rules,
 * against a REAL database. Only external seams (Paystack, Supabase admin, auth,
 * Redis/queue) are faked. SKIPS without DATABASE_URL so unconfigured CI stays
 * green.
 */
const describeE2E = process.env.DATABASE_URL ? describe : describe.skip;

const SELLER = '11111111-1111-1111-1111-111111111111';
const BUYER = '22222222-2222-2222-2222-222222222222';
const AMOUNT = 125_000; // kobo

describeE2E('Chat money-safety (e2e)', () => {
  let ctx: MoneyE2EContext;
  let payments: PaymentsService;
  let transactions: TransactionsService;
  let webhooks: WebhooksService;
  let inbound: ChatInboundService;

  beforeAll(async () => {
    const { createMoneyE2EApp } = await import('./utils/e2e-harness');
    ctx = await createMoneyE2EApp(process.env.PAYSTACK_SECRET_KEY ?? 'sk_test_e2e');
    payments = ctx.app.get(PaymentsService);
    transactions = ctx.app.get(TransactionsService);
    webhooks = ctx.app.get(WebhooksService);
    inbound = ctx.app.get(ChatInboundService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    await ctx.seedUser(SELLER, { email: 'seller@e2e.test' });
    await ctx.seedUser(BUYER, { email: 'buyer@e2e.test' });
    await ctx.seedSellerRecipient(SELLER);
  });

  /** Create + publish a transaction, then open a DVA collection for the buyer. */
  async function openDvaCollection(): Promise<string> {
    const tx = await transactions.createDraft({ sellerId: SELLER, title: 'Nikes', amount: AMOUNT });
    await transactions.apply({
      transactionId: tx.id,
      event: { type: 'SELLER_PUBLISH' },
      actor: { id: SELLER, type: ActorType.USER, role: 'SELLER' },
    });
    await payments.initializeVirtualAccount({
      transactionId: tx.id,
      buyerId: BUYER,
      email: 'buyer@e2e.test',
    });
    return tx.id;
  }

  /** A signed Paystack webhook envelope. */
  function signedWebhook(event: string, data: unknown): { raw: Buffer; sig: string } {
    const raw = Buffer.from(JSON.stringify({ event, data }));
    const sig = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY ?? 'sk_test_e2e')
      .update(raw)
      .digest('hex');
    return { raw, sig };
  }

  it('opening a DVA collection does NOT protect — funds move only on a signed webhook (rule 2)', async () => {
    const txId = await openDvaCollection();

    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    // A buyer typing "I paid" in chat cannot advance this; only a signed
    // charge.success can. Until then the transaction is merely PAYMENT_PENDING.
    expect(tx.status).toBe(TransactionStatus.PAYMENT_PENDING);

    const payment = await ctx.prisma.payment.findFirstOrThrow({ where: { transactionId: txId } });
    expect(payment.status).toBe('PENDING');
    expect(payment.providerCustomerCode).toBe('CUS_e2e');
  });

  it('a DVA charge.success with a MISMATCHED amount never protects (rule 2 amount hard-stop)', async () => {
    const txId = await openDvaCollection();

    // Buyer "paid" the wrong amount — Paystack reports less than expected.
    ctx.paystack.verifyResult = { status: 'success', amount: AMOUNT - 1 };
    const { raw, sig } = signedWebhook('charge.success', {
      id: 501,
      reference: 'PSTK_charge_wrong',
      customer: { customer_code: 'CUS_e2e' },
    });

    await expect(webhooks.handlePaystackEvent(raw, sig)).rejects.toBeTruthy();

    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe(TransactionStatus.PAYMENT_PENDING);
  });

  it('a DVA charge.success with the EXACT amount protects (control) and binds the charge ref once', async () => {
    const txId = await openDvaCollection();

    ctx.paystack.verifyResult = { status: 'success', amount: AMOUNT };
    const evt = signedWebhook('charge.success', {
      id: 502,
      reference: 'PSTK_charge_ok',
      customer: { customer_code: 'CUS_e2e' },
    });

    await webhooks.handlePaystackEvent(evt.raw, evt.sig);

    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe(TransactionStatus.PAYMENT_PROTECTED);

    const payment = await ctx.prisma.payment.findFirstOrThrow({ where: { transactionId: txId } });
    expect(payment.status).toBe('SUCCESS');
    expect(payment.providerChargeReference).toBe('PSTK_charge_ok');
  });

  it('a re-delivered DVA charge.success never double-protects (rule 4)', async () => {
    const txId = await openDvaCollection();
    ctx.paystack.verifyResult = { status: 'success', amount: AMOUNT };

    const first = signedWebhook('charge.success', {
      id: 601,
      reference: 'PSTK_charge_dup',
      customer: { customer_code: 'CUS_e2e' },
    });
    await webhooks.handlePaystackEvent(first.raw, first.sig);

    // Same charge reference, different event id — a genuine re-delivery.
    const second = signedWebhook('charge.success', {
      id: 602,
      reference: 'PSTK_charge_dup',
      customer: { customer_code: 'CUS_e2e' },
    });
    await webhooks.handlePaystackEvent(second.raw, second.sig);

    // Exactly one SUCCESS payment; the transaction is protected, not double-moved.
    const payments = await ctx.prisma.payment.findMany({ where: { transactionId: txId } });
    expect(payments.filter((p) => p.status === 'SUCCESS')).toHaveLength(1);
    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe(TransactionStatus.PAYMENT_PROTECTED);
  });

  it('a duplicate inbound chat message is recorded and acted on at most once (rule 4)', async () => {
    const update = {
      update_id: 700,
      message: { text: '/help', chat: { id: 555 }, from: { first_name: 'Ada' } },
    };
    const raw = Buffer.from(JSON.stringify(update));
    const headers = { 'x-telegram-bot-api-secret-token': 'test-telegram-webhook-secret' };

    const first = await inbound.ingest(ChatPlatform.TELEGRAM, raw, headers, update);
    const second = await inbound.ingest(ChatPlatform.TELEGRAM, raw, headers, update);

    expect(first.accepted).toBe(1);
    expect(second.accepted).toBe(0);
    expect(second.duplicate).toBe(1);

    const count = await ctx.prisma.chatInboundEvent.count();
    expect(count).toBe(1);
  });

  it('rejects a chat webhook with a bad signature (the signature is the auth)', async () => {
    const update = { update_id: 800, message: { text: '/help', chat: { id: 556 } } };
    const raw = Buffer.from(JSON.stringify(update));

    await expect(
      inbound.ingest(
        ChatPlatform.TELEGRAM,
        raw,
        { 'x-telegram-bot-api-secret-token': 'wrong' },
        update,
      ),
    ).rejects.toBeTruthy();

    expect(await ctx.prisma.chatInboundEvent.count()).toBe(0);
  });
});
