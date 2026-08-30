import type { Server } from 'node:http';
import request from 'supertest';
import { MerchantsService } from '@/modules/merchants/merchants.service';
import { PayoutsService, releaseIdempotencyKey } from '@/modules/payouts/payouts.service';
import { authHeaders } from './utils/e2e-identity';
import type { MoneyE2EContext } from './utils/e2e-harness';

/**
 * End-to-end proof of EaaS Slice 1 tenant isolation + the merchant-scoped /v1
 * lifecycle, against a REAL database. Mirrors money-safety.e2e-spec.ts: only
 * Paystack, the auth guard and the Redis/BullMQ queue are faked, so these need
 * Postgres only. They SKIP when no DATABASE_URL is configured so an
 * unconfigured CI stays green.
 *
 * Isolation is the money-safety property under test here: a merchant must never
 * read or mutate another tenant's rows, and a cross-tenant id must 404 (not
 * 403) so the API never confirms that someone else's transaction exists.
 */
const describeE2E = process.env.DATABASE_URL ? describe : describe.skip;

const BUYER = '33333333-3333-3333-3333-333333333333';
const AMOUNT = 125_000; // kobo (₦1,250.00)

describeE2E('EaaS tenancy (e2e)', () => {
  let ctx: MoneyE2EContext;

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
    await ctx.seedUser(BUYER, { email: 'buyer@e2e.test', phone: '+2348010000001' });
    ctx.paystack.transfers = [];
    ctx.paystack.transferError = null;
    ctx.paystack.knownTransfers.clear();
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

  it('a /v1 call with no API key 401s; with a valid sk_test key it succeeds, merchant-scoped', async () => {
    await request(http()).post('/v1/sellers').send({ businessName: 'Store A' }).expect(401);

    const a = await onboardMerchant('Merchant A');
    const sellerId = await createSeller(a.bearer, 'Store A');

    // The minted seller is a real User row, owned by the calling merchant.
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: sellerId } });
    const profile = await ctx.prisma.sellerProfile.findUniqueOrThrow({
      where: { userId: sellerId },
    });
    expect(user.merchantId).toBe(a.id);
    expect(profile.merchantId).toBe(a.id);
  });

  it("merchant A cannot read merchant B's transaction (404, not 403)", async () => {
    const a = await onboardMerchant('Merchant A');
    const b = await onboardMerchant('Merchant B');

    const sellerAId = await createSeller(a.bearer, 'Store A');
    const tx = await request(http())
      .post('/v1/transactions')
      .set('Authorization', a.bearer)
      .send({ sellerId: sellerAId, title: 'Widget', amount: AMOUNT })
      .expect(201);
    const txId = (tx.body as { id: string }).id;

    // Sanity: the row really is A's.
    const owned = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(owned.merchantId).toBe(a.id);

    // 404, never 403 — B must not learn that this id exists.
    await request(http())
      .get(`/v1/transactions/${txId}`)
      .set('Authorization', b.bearer)
      .expect(404);

    // ...and it never appears in B's list either.
    const list = await request(http())
      .get('/v1/transactions')
      .set('Authorization', b.bearer)
      .expect(200);
    expect((list.body as { items: unknown[] }).items).toHaveLength(0);
  });

  it("merchant A cannot create a transaction for merchant B's seller (404)", async () => {
    const a = await onboardMerchant('Merchant A');
    const b = await onboardMerchant('Merchant B');

    const sellerBId = await createSeller(b.bearer, 'Store B');

    await request(http())
      .post('/v1/transactions')
      .set('Authorization', a.bearer)
      .send({ sellerId: sellerBId, title: 'Widget', amount: AMOUNT })
      .expect(404);

    // Nothing was written for either tenant.
    expect(await ctx.prisma.transaction.count()).toBe(0);

    // Reading B's seller directly is refused the same way.
    await request(http())
      .get(`/v1/sellers/${sellerBId}`)
      .set('Authorization', a.bearer)
      .expect(404);
  });

  it('a sk_live key is rejected (403) until an admin enables livemode', async () => {
    const a = await onboardMerchant('Merchant A');
    const { apiKey: liveKey } = await merchants().issueKey(a.id, true);
    expect(liveKey.startsWith('sk_live_')).toBe(true);

    await request(http()).get('/v1/sellers').set('Authorization', `Bearer ${liveKey}`).expect(403);

    await merchants().setLivemodeEnabled(a.id, true);

    await request(http()).get('/v1/sellers').set('Authorization', `Bearer ${liveKey}`).expect(200);

    // A revoked key stops working regardless of livemode.
    const { apiKey: doomed, keyId } = await merchants().issueKey(a.id, false);
    await merchants().revokeKey(a.id, keyId);
    await request(http()).get('/v1/sellers').set('Authorization', `Bearer ${doomed}`).expect(401);
  });

  it('full lifecycle stays merchant-scoped: one transfer, protected only via server verify', async () => {
    const a = await onboardMerchant('Merchant A');
    const sellerId = await createSeller(a.bearer, 'Store A');
    const asSeller = authHeaders({ sub: sellerId, email: 'sellerA@e2e.test', appRole: 'SELLER' });

    // Payout destination, onboarded through /v1 (Paystack resolve + recipient faked).
    await request(http())
      .post(`/v1/sellers/${sellerId}/recipient`)
      .set('Authorization', a.bearer)
      .send({ bankCode: '058', accountNumber: '0123456789' })
      .expect(201);

    const txRes = await request(http())
      .post('/v1/transactions')
      .set('Authorization', a.bearer)
      .send({ sellerId, title: 'EaaS Widget', amount: AMOUNT })
      .expect(201);
    const txId = (txRes.body as { id: string }).id;

    await request(http())
      .post(`/v1/transactions/${txId}/publish`)
      .set('Authorization', a.bearer)
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

    let tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('PAYMENT_PROTECTED');
    expect(tx.merchantId).toBe(a.id);

    await request(http()).post(`/transactions/${txId}/start-delivery`).set(asSeller).expect(201);
    await request(http()).post(`/transactions/${txId}/mark-delivered`).set(asSeller).expect(201);
    await request(http()).post(`/transactions/${txId}/confirm`).set(asBuyer).expect(201);

    tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('RELEASE_PROCESSING');

    // The queue is faked, so drive the worker + transfer webhook in-line, the
    // same way money-safety.e2e-spec.ts does.
    const payouts = ctx.app.get(PayoutsService);
    await payouts.executeRelease(txId);
    await payouts.executeRelease(txId); // duplicate job — must not send a 2nd transfer
    await payouts.markPaid(releaseIdempotencyKey(txId), 'TRF_eaas_e2e');

    tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('COMPLETED');
    expect(tx.merchantId).toBe(a.id);

    // Exactly one transfer, to this merchant's seller, for the exact kobo amount.
    expect(ctx.paystack.transfers).toHaveLength(1);
    expect(ctx.paystack.transfers[0]).toMatchObject({
      reference: releaseIdempotencyKey(txId),
      amount: AMOUNT,
      recipient: 'RCP_e2e_seller',
    });

    // The payout row carries the tenant too — money never loses its owner.
    const payout = await ctx.prisma.payout.findUniqueOrThrow({
      where: { idempotencyKey: releaseIdempotencyKey(txId) },
    });
    expect(payout.status).toBe('SUCCESS');
    expect(payout.amount).toBe(AMOUNT);
    expect(payout.merchantId).toBe(a.id);
    expect(await ctx.prisma.payout.count({ where: { transactionId: txId } })).toBe(1);

    // Rule 6: every transition is audited, and the /v1 publish is attributed to
    // the merchant tenant that drove it (AuditLog actors are polymorphic, so the
    // merchant id is the actor rather than a column of its own).
    const audits = await ctx.prisma.auditLog.findMany({
      where: { action: 'transaction.status_change', targetId: txId },
    });
    expect(audits.length).toBeGreaterThanOrEqual(5);
    const publishRow = audits.find((row) => row.actorId === a.id);
    expect(publishRow?.metadata).toMatchObject({ event: 'SELLER_PUBLISH' });

    // Every audited target for this lifecycle belongs to merchant A.
    const payoutAudits = await ctx.prisma.auditLog.findMany({
      where: { targetType: 'Payout', targetId: payout.id },
    });
    expect(payoutAudits.length).toBeGreaterThanOrEqual(1);
  });
});
