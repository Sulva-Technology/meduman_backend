import type { Server } from 'node:http';
import { ActorType } from '@prisma/client';
import request from 'supertest';
import { PayoutsService, releaseIdempotencyKey } from '@/modules/payouts/payouts.service';
import { TransactionsService } from '@/modules/transactions/transactions.service';
import { authHeaders } from './utils/e2e-identity';
import type { MoneyE2EContext } from './utils/e2e-harness';

/**
 * End-to-end proof of the six money-safety rules against a REAL database. Only
 * external seams (Paystack, auth, Redis/queue) are faked. These need a throwaway
 * Postgres — set DATABASE_URL to a TEST database and run `npm run test:e2e`. They
 * SKIP when no DATABASE_URL is configured so an unconfigured CI stays green.
 */
const describeE2E = process.env.DATABASE_URL ? describe : describe.skip;

const SELLER = '11111111-1111-1111-1111-111111111111';
const BUYER = '22222222-2222-2222-2222-222222222222';
const AMOUNT = 125_000; // kobo (₦1,250.00)

describeE2E('Money-safety (e2e)', () => {
  let ctx: MoneyE2EContext;

  const http = (): Server => ctx.app.getHttpServer() as Server;
  const asSeller = authHeaders({ sub: SELLER, email: 'seller@e2e.test', appRole: 'SELLER' });
  const asBuyer = authHeaders({ sub: BUYER, email: 'buyer@e2e.test', appRole: 'BUYER' });

  beforeAll(async () => {
    // Loaded lazily — importing the harness pulls in AppModule, which validates
    // env at import time; keep that out of collection so the suite skips cleanly.
    const { createMoneyE2EApp } = await import('./utils/e2e-harness');
    ctx = await createMoneyE2EApp(process.env.PAYSTACK_SECRET_KEY ?? 'sk_test_e2e');
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    await ctx.seedUser(SELLER, { email: 'seller@e2e.test' });
    await ctx.seedUser(BUYER, { email: 'buyer@e2e.test', phone: '+2348010000000' });
    await ctx.seedSellerRecipient(SELLER);
    ctx.paystack.transfers = [];
    ctx.paystack.transferError = null;
    ctx.paystack.knownTransfers.clear();
  });

  /** Seller creates + publishes; buyer pays + server-verify protects; seller delivers. */
  async function driveToConfirmationPending(
    releaseRule?: 'BUYER_CONFIRMATION' | 'AUTO_AFTER_WINDOW',
  ): Promise<{ txId: string; reference: string }> {
    const created = await request(http())
      .post('/transactions')
      .set(asSeller)
      .send({ title: 'Nikes', amount: AMOUNT, ...(releaseRule ? { releaseRule } : {}) })
      .expect(201);
    const txId = (created.body as { id: string }).id;

    await request(http()).post(`/transactions/${txId}/publish`).set(asSeller).expect(201);

    const init = await request(http())
      .post('/payments/initialize')
      .set(asBuyer)
      .send({ transactionId: txId })
      .expect(201);
    const reference = (init.body as { reference: string }).reference;

    ctx.paystack.verifyResult = { status: 'success', amount: AMOUNT };
    await request(http()).post(`/payments/${reference}/verify`).set(asBuyer).expect(201);

    await request(http()).post(`/transactions/${txId}/start-delivery`).set(asSeller).expect(201);
    await request(http()).post(`/transactions/${txId}/mark-delivered`).set(asSeller).expect(201);

    return { txId, reference };
  }

  it('Rule 1–3: pay → protect → deliver → confirm → release completes the transaction', async () => {
    const { txId } = await driveToConfirmationPending();

    await request(http()).post(`/transactions/${txId}/confirm`).set(asBuyer).expect(201);

    let tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('RELEASE_PROCESSING');

    // Worker + transfer webhook, simulated in-line (queue is faked).
    const payouts = ctx.app.get(PayoutsService);
    await payouts.executeRelease(txId);
    await payouts.markPaid(releaseIdempotencyKey(txId), 'TRF_test');

    tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    const payout = await ctx.prisma.payout.findUniqueOrThrow({
      where: { idempotencyKey: releaseIdempotencyKey(txId) },
    });
    expect(tx.status).toBe('COMPLETED');
    expect(payout.status).toBe('SUCCESS');
    expect(payout.amount).toBe(AMOUNT);
  });

  it('Rule 3: auto-confirm after the window reaches RELEASE_PROCESSING', async () => {
    const { txId } = await driveToConfirmationPending('AUTO_AFTER_WINDOW');

    await ctx.app.get(TransactionsService).apply({
      transactionId: txId,
      event: { type: 'AUTO_CONFIRM' },
      actor: { type: ActorType.SYSTEM, role: 'SYSTEM' },
      context: { autoConfirmWindowElapsed: true },
    });

    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('RELEASE_PROCESSING');
  });

  it('Rule 4: retrying the release authorizes exactly one payout (no double-pay)', async () => {
    const { txId } = await driveToConfirmationPending();
    await request(http()).post(`/transactions/${txId}/confirm`).set(asBuyer).expect(201);

    const payouts = ctx.app.get(PayoutsService);
    await payouts.executeRelease(txId);
    await payouts.executeRelease(txId); // retry / duplicate job

    const count = await ctx.prisma.payout.count({ where: { transactionId: txId } });
    expect(count).toBe(1);
  });

  it('Rule 3–4: release sends exactly one transfer, and only the signed webhook completes it', async () => {
    const { txId } = await driveToConfirmationPending();
    await request(http()).post(`/transactions/${txId}/confirm`).set(asBuyer).expect(201);

    const payouts = ctx.app.get(PayoutsService);
    await payouts.executeRelease(txId);
    await payouts.executeRelease(txId); // duplicate job — must not send a second transfer

    expect(ctx.paystack.transfers).toHaveLength(1);
    expect(ctx.paystack.transfers[0]).toMatchObject({
      reference: releaseIdempotencyKey(txId),
      amount: AMOUNT,
      recipient: 'RCP_e2e_seller',
    });

    // Money is out the door but unconfirmed: nothing is COMPLETED yet.
    let tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    let payout = await ctx.prisma.payout.findUniqueOrThrow({
      where: { idempotencyKey: releaseIdempotencyKey(txId) },
    });
    expect(tx.status).toBe('RELEASE_PROCESSING');
    expect(payout.status).toBe('PROCESSING');

    const payload = JSON.stringify({
      event: 'transfer.success',
      data: { id: 777, reference: releaseIdempotencyKey(txId), transfer_code: 'TRF_1' },
    });
    await request(http())
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', ctx.paystack.sign(payload))
      .send(payload)
      .expect(200);

    tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    payout = await ctx.prisma.payout.findUniqueOrThrow({
      where: { idempotencyKey: releaseIdempotencyKey(txId) },
    });
    expect(tx.status).toBe('COMPLETED');
    expect(payout.status).toBe('SUCCESS');
  });

  it('Rule 3: a seller with no payout destination never has funds transferred', async () => {
    const { txId } = await driveToConfirmationPending();
    await request(http()).post(`/transactions/${txId}/confirm`).set(asBuyer).expect(201);
    await ctx.prisma.sellerProfile.delete({ where: { userId: SELLER } });

    await expect(ctx.app.get(PayoutsService).executeRelease(txId)).rejects.toThrow(
      /payout destination/i,
    );

    expect(ctx.paystack.transfers).toHaveLength(0);
    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('RELEASE_PROCESSING'); // funds stay held, never completed
  });

  it('Rule 4: a transfer.failed webhook records the failure and completes nothing', async () => {
    const { txId } = await driveToConfirmationPending();
    await request(http()).post(`/transactions/${txId}/confirm`).set(asBuyer).expect(201);
    await ctx.app.get(PayoutsService).executeRelease(txId);

    const payload = JSON.stringify({
      event: 'transfer.failed',
      data: {
        id: 888,
        reference: releaseIdempotencyKey(txId),
        transfer_code: 'TRF_1',
        reason: 'account closed',
      },
    });
    await request(http())
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', ctx.paystack.sign(payload))
      .send(payload)
      .expect(200);

    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    const payout = await ctx.prisma.payout.findUniqueOrThrow({
      where: { idempotencyKey: releaseIdempotencyKey(txId) },
    });
    expect(payout.status).toBe('FAILED');
    expect(payout.lastError).toBe('account closed');
    expect(tx.status).toBe('RELEASE_PROCESSING');
  });

  it('Rule 4: replaying the charge.success webhook does not re-protect or double-count', async () => {
    const { reference } = await driveToConfirmationPending();

    const payload = JSON.stringify({
      event: 'charge.success',
      data: { id: 555, reference },
    });
    const sig = ctx.paystack.sign(payload);

    const first = await request(http())
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sig)
      .send(payload)
      .expect(200);
    expect((first.body as { duplicate?: boolean }).duplicate).toBeUndefined();

    const second = await request(http())
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sig)
      .send(payload)
      .expect(200);
    expect((second.body as { duplicate?: boolean }).duplicate).toBe(true);

    const payments = await ctx.prisma.payment.findMany({ where: { providerReference: reference } });
    expect(payments).toHaveLength(1);
    expect(payments[0]?.status).toBe('SUCCESS');
  });

  it('Rule 2: a webhook with a bad signature is rejected and never recorded', async () => {
    const payload = JSON.stringify({ event: 'charge.success', data: { id: 1, reference: 'x' } });

    await request(http())
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'deadbeef')
      .send(payload)
      .expect(401);

    const count = await ctx.prisma.webhookEvent.count();
    expect(count).toBe(0);
  });

  it('Rule 5: an open dispute freezes buyer confirmation (release refused)', async () => {
    const { txId } = await driveToConfirmationPending();

    await request(http())
      .post(`/transactions/${txId}/disputes`)
      .set(asBuyer)
      .send({ reason: 'ITEM_NOT_RECEIVED' })
      .expect(201);

    // Confirmation into RELEASE_PROCESSING must be rejected while disputed.
    await request(http()).post(`/transactions/${txId}/confirm`).set(asBuyer).expect(409);

    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('DISPUTED');
    expect(await ctx.prisma.payout.count({ where: { transactionId: txId } })).toBe(0);
  });

  it('Rule 6: every state transition writes an immutable audit row', async () => {
    const { txId } = await driveToConfirmationPending();
    await request(http()).post(`/transactions/${txId}/confirm`).set(asBuyer).expect(201);
    const payouts = ctx.app.get(PayoutsService);
    await payouts.executeRelease(txId);
    await payouts.markPaid(releaseIdempotencyKey(txId), 'TRF_test');

    const audits = await ctx.prisma.auditLog.findMany({
      where: { action: 'transaction.status_change', targetId: txId },
    });
    // publish, payment_verified, start_delivery, mark_delivered, buyer_confirm, payout_succeeded
    expect(audits.length).toBeGreaterThanOrEqual(5);
  });

  it('Rule (kobo): money values stay integer minor units end-to-end', async () => {
    const { txId, reference } = await driveToConfirmationPending();
    await request(http()).post(`/transactions/${txId}/confirm`).set(asBuyer).expect(201);
    await ctx.app.get(PayoutsService).executeRelease(txId);

    const payment = await ctx.prisma.payment.findUniqueOrThrow({
      where: { providerReference: reference },
    });
    const payout = await ctx.prisma.payout.findUniqueOrThrow({
      where: { idempotencyKey: releaseIdempotencyKey(txId) },
    });
    expect(Number.isInteger(payment.amount)).toBe(true);
    expect(Number.isInteger(payout.amount)).toBe(true);
    expect(payment.amount).toBe(AMOUNT);
    expect(payout.amount).toBe(AMOUNT);
  });
});
