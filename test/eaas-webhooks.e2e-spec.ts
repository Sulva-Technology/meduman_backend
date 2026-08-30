import type { Server } from 'node:http';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { Env } from '@/config/env.validation';
import { MerchantsService } from '@/modules/merchants/merchants.service';
import { WebhookDeliveryService } from '@/modules/merchants/webhook-delivery.service';
import { PayoutsService, releaseIdempotencyKey } from '@/modules/payouts/payouts.service';
import { authHeaders } from './utils/e2e-identity';
import type { MoneyE2EContext } from './utils/e2e-harness';

/**
 * End-to-end proof of EaaS Slice 2 (outbound webhooks) against a REAL database.
 * Mirrors eaas-tenancy.e2e-spec.ts / money-safety.e2e-spec.ts: only Paystack,
 * the auth guard and the Redis/BullMQ queues are faked, so these need Postgres
 * only. SKIPs when no DATABASE_URL is configured so an unconfigured CI stays
 * green.
 *
 * Under test: the outbox only ever emits for a tenanted (merchantId-carrying)
 * transaction, never for first-party Meduman traffic; emission is exactly-once
 * per driving event; a merchant can only ever read its own events; and
 * delivery is a plain fetch POST that marks DELIVERED on 2xx and dead-letters
 * to FAILED once attempts are exhausted, never retrying forever in-process.
 */
const describeE2E = process.env.DATABASE_URL ? describe : describe.skip;

const BUYER = '44444444-4444-4444-4444-444444444444';
const FIRST_PARTY_SELLER = '55555555-5555-5555-5555-555555555555';
const FIRST_PARTY_BUYER = '66666666-6666-6666-6666-666666666666';
const AMOUNT = 125_000; // kobo (₦1,250.00)

describeE2E('EaaS outbound webhooks (e2e)', () => {
  let ctx: MoneyE2EContext;
  const originalFetch = global.fetch;

  const http = (): Server => ctx.app.getHttpServer() as Server;
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
    await ctx.seedUser(BUYER, { email: 'buyer@e2e.test', phone: '+2348010000002' });
    ctx.paystack.transfers = [];
    ctx.paystack.transferError = null;
    ctx.paystack.knownTransfers.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const merchants = (): MerchantsService => ctx.app.get(MerchantsService);

  /** Mint a merchant + its one-time test-mode key, as an admin onboarding would. */
  async function onboardMerchant(name: string): Promise<{ id: string; bearer: string }> {
    const { merchant, apiKey } = await merchants().createMerchant(name);
    return { id: merchant.id, bearer: `Bearer ${apiKey}` };
  }

  async function createSeller(bearer: string, businessName: string): Promise<string> {
    const res = await request(http())
      .post('/v1/sellers')
      .set('Authorization', bearer)
      .send({ businessName })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Merchant-scoped tx: create + payout destination + publish + server-verified protect. */
  async function driveMerchantTxToProtected(
    merchantName: string,
  ): Promise<{ merchantId: string; bearer: string; sellerId: string; txId: string }> {
    const m = await onboardMerchant(merchantName);
    const sellerId = await createSeller(m.bearer, `${merchantName} Store`);

    await request(http())
      .post(`/v1/sellers/${sellerId}/recipient`)
      .set('Authorization', m.bearer)
      .send({ bankCode: '058', accountNumber: '0123456789' })
      .expect(201);

    const txRes = await request(http())
      .post('/v1/transactions')
      .set('Authorization', m.bearer)
      .send({ sellerId, title: 'Widget', amount: AMOUNT })
      .expect(201);
    const txId = (txRes.body as { id: string }).id;

    await request(http())
      .post(`/v1/transactions/${txId}/publish`)
      .set('Authorization', m.bearer)
      .expect(201);

    // Payment protection rides the EXISTING first-party path — /v1 adds no
    // money-marking endpoint. Rule 2: only a server-side verify (or a signed
    // webhook) can protect, never a client callback.
    const init = await request(http())
      .post('/payments/initialize')
      .set(asBuyer)
      .send({ transactionId: txId })
      .expect(201);
    const reference = (init.body as { reference: string }).reference;

    ctx.paystack.verifyResult = { status: 'success', amount: AMOUNT };
    await request(http()).post(`/payments/${reference}/verify`).set(asBuyer).expect(201);

    return { merchantId: m.id, bearer: m.bearer, sellerId, txId };
  }

  it('Spec 1: a merchant tx driven to PAYMENT_PROTECTED writes exactly one transaction.protected outbox row', async () => {
    const { merchantId, txId } = await driveMerchantTxToProtected('Merchant A');

    const rows = await ctx.prisma.outboundEvent.findMany({ where: { merchantId } });
    const protectedRows = rows.filter((r) => r.type === 'transaction.protected');
    expect(protectedRows).toHaveLength(1);
    expect(protectedRows[0]?.payload).toMatchObject({
      transactionId: txId,
      status: 'PAYMENT_PROTECTED',
    });
  });

  it('Spec 2: a first-party tx (no merchantId) writes ZERO outbound events', async () => {
    await ctx.seedUser(FIRST_PARTY_SELLER, { email: 'fpseller@e2e.test' });
    await ctx.seedUser(FIRST_PARTY_BUYER, { email: 'fpbuyer@e2e.test', phone: '+2348010000003' });
    await ctx.seedSellerRecipient(FIRST_PARTY_SELLER);

    const asFpSeller = authHeaders({
      sub: FIRST_PARTY_SELLER,
      email: 'fpseller@e2e.test',
      appRole: 'SELLER',
    });
    const asFpBuyer = authHeaders({
      sub: FIRST_PARTY_BUYER,
      email: 'fpbuyer@e2e.test',
      appRole: 'BUYER',
    });

    const created = await request(http())
      .post('/transactions')
      .set(asFpSeller)
      .send({ title: 'First-party Widget', amount: AMOUNT })
      .expect(201);
    const txId = (created.body as { id: string }).id;

    await request(http()).post(`/transactions/${txId}/publish`).set(asFpSeller).expect(201);

    const init = await request(http())
      .post('/payments/initialize')
      .set(asFpBuyer)
      .send({ transactionId: txId })
      .expect(201);
    const reference = (init.body as { reference: string }).reference;

    ctx.paystack.verifyResult = { status: 'success', amount: AMOUNT };
    await request(http()).post(`/payments/${reference}/verify`).set(asFpBuyer).expect(201);

    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('PAYMENT_PROTECTED');
    expect(tx.merchantId).toBeNull();

    // No merchant in play for this whole run — the outbox stayed empty.
    expect(await ctx.prisma.outboundEvent.count()).toBe(0);
  });

  it('Spec 3: funds.released is emitted exactly once on payout completion', async () => {
    const { merchantId, sellerId, txId } = await driveMerchantTxToProtected('Merchant A');
    const asSeller = authHeaders({ sub: sellerId, email: 'sellerA@e2e.test', appRole: 'SELLER' });

    await request(http()).post(`/transactions/${txId}/start-delivery`).set(asSeller).expect(201);
    await request(http()).post(`/transactions/${txId}/mark-delivered`).set(asSeller).expect(201);
    await request(http()).post(`/transactions/${txId}/confirm`).set(asBuyer).expect(201);

    let tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('RELEASE_PROCESSING');

    // Queue is faked — drive the worker + transfer webhook in-line, same as
    // eaas-tenancy.e2e-spec.ts / money-safety.e2e-spec.ts.
    const payouts = ctx.app.get(PayoutsService);
    await payouts.executeRelease(txId);
    await payouts.markPaid(releaseIdempotencyKey(txId), 'TRF_webhooks_e2e');

    tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('COMPLETED');

    const rows = await ctx.prisma.outboundEvent.findMany({
      where: { merchantId, type: 'funds.released' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ transactionId: txId, status: 'COMPLETED' });
  });

  it("Spec 4: merchant B's GET /v1/events never shows merchant A's events", async () => {
    await driveMerchantTxToProtected('Merchant A');
    const b = await onboardMerchant('Merchant B');

    // Sanity: A really did get an event, so this isn't a vacuous pass.
    expect(await ctx.prisma.outboundEvent.count()).toBeGreaterThan(0);

    const res = await request(http()).get('/v1/events').set('Authorization', b.bearer).expect(200);
    expect((res.body as { items: unknown[] }).items).toHaveLength(0);
  });

  it('Spec 5: delivery marks DELIVERED on a 2xx stub, and FAILED after max attempts on a 500 stub', async () => {
    const { merchantId, bearer, txId } = await driveMerchantTxToProtected('Merchant A');

    await request(http())
      .post('/v1/webhook-endpoints')
      .set('Authorization', bearer)
      .send({ url: 'https://example.com/webhook' })
      .expect(201);

    const delivery = ctx.app.get(WebhookDeliveryService);
    const maxAttempts = ctx.app
      .get(ConfigService<Env, true>)
      .get('WEBHOOK_MAX_ATTEMPTS', { infer: true });

    const protectedEvent = await ctx.prisma.outboundEvent.findFirstOrThrow({
      where: { merchantId, type: 'transaction.protected' },
    });

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as never;
    await delivery.deliver(protectedEvent.id);

    const delivered = await ctx.prisma.outboundEvent.findUniqueOrThrow({
      where: { id: protectedEvent.id },
    });
    expect(delivered.status).toBe('DELIVERED');
    expect(delivered.deliveredAt).not.toBeNull();

    // A fresh event for the failure path — the protected event is already DELIVERED
    // (deliver() no-ops on it), so exhausting attempts needs its own row.
    const failEvent = await ctx.prisma.outboundEvent.create({
      data: {
        merchantId,
        type: 'test.failure',
        payload: { transactionId: txId, status: 'X' },
      },
    });

    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as never;
    for (let i = 0; i < maxAttempts; i += 1) {
      // deliver() re-throws until attempts are exhausted (so BullMQ would
      // retry); driving it directly in a loop simulates those retries.
      await delivery.deliver(failEvent.id).catch(() => undefined);
    }

    const failed = await ctx.prisma.outboundEvent.findUniqueOrThrow({
      where: { id: failEvent.id },
    });
    expect(failed.status).toBe('FAILED');
    expect(failed.attemptCount).toBeGreaterThanOrEqual(maxAttempts);
  });
});
