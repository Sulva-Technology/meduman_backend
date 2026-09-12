import type { Server } from 'node:http';
import { ActorType, ChatPlatform, TransactionOrigin } from '@prisma/client';
import request from 'supertest';
import { ChatDialogService } from '@/modules/chat/dialog/chat-dialog.service';
import { ChatSessionService } from '@/modules/chat/session/chat-session.service';
import { ChatLinkService } from '@/modules/chat/linking/chat-link.service';
import { MerchantsService } from '@/modules/merchants/merchants.service';
import { PayoutsService, releaseIdempotencyKey } from '@/modules/payouts/payouts.service';
import { TransactionsService } from '@/modules/transactions/transactions.service';
import { authHeaders } from './utils/e2e-identity';
import type { MoneyE2EContext } from './utils/e2e-harness';

/**
 * End-to-end proof of the platform-analytics funnel, money and origin isolation
 * against a REAL database. Only Paystack / auth / Redis-queue are faked, exactly
 * as `money-safety.e2e-spec.ts` does, so these need Postgres only and SKIP when
 * no DATABASE_URL is configured.
 *
 * The load-bearing cases are 2, 3 and 4: they are the ones a status-rank
 * implementation of the funnel gets wrong, and the only ones that can prove the
 * timeline-reading design.
 */
const describeE2E = process.env.DATABASE_URL ? describe : describe.skip;

/** The chat-born seller — drives the chat dialog on TELEGRAM. */
const CHAT_SELLER = '11111111-1111-1111-1111-111111111111';
/** The web seller — drives the web controller. */
const WEB_SELLER = '22222222-2222-2222-2222-222222222222';
const BUYER = '33333333-3333-3333-3333-333333333333';
const ADMIN = '00000000-0000-4000-8000-00000000admi';
const AMOUNT = 125_000; // kobo (₦1,250.00)
const FEE = 2_500; // kobo

/** A shape the response's per-origin rows satisfy, for the assertions below. */
interface Row {
  origin: TransactionOrigin | 'ALL';
  sellers: number;
  buyers: number;
  created: number;
  published: number;
  paymentStarted: number;
  protected: number;
  delivered: number;
  released: number;
  disputed: number;
  disputeRate: number;
  protectedVolumeKobo: string;
  releasedVolumeKobo: string;
  feesKobo: string;
}

interface Body {
  from: string;
  to: string;
  platforms: Row[];
  totals: Row;
}

describeE2E('Platform analytics (e2e)', () => {
  let ctx: MoneyE2EContext;

  const http = (): Server => ctx.app.getHttpServer() as Server;
  const asWebSeller = authHeaders({ sub: WEB_SELLER, email: 'web@e2e.test', appRole: 'SELLER' });
  const asBuyer = authHeaders({ sub: BUYER, email: 'buyer@e2e.test', appRole: 'BUYER' });
  const asAdmin = authHeaders({ sub: ADMIN, appRole: 'ADMIN' });

  beforeAll(async () => {
    // Loaded lazily — the harness pulls in AppModule, which validates env at
    // import time; keep that out of collection so the suite skips cleanly.
    const { createMoneyE2EApp } = await import('./utils/e2e-harness');
    ctx = await createMoneyE2EApp(process.env.PAYSTACK_SECRET_KEY ?? 'sk_test_e2e');
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    await ctx.seedUser(CHAT_SELLER, { email: 'chat@e2e.test' });
    await ctx.seedUser(WEB_SELLER, { email: 'web@e2e.test' });
    await ctx.seedUser(BUYER, { email: 'buyer@e2e.test', phone: '+2348010000000' });
    ctx.paystack.transfers = [];
    ctx.paystack.transferError = null;
    ctx.paystack.knownTransfers.clear();
  });

  // --- helpers -------------------------------------------------------------

  const txs = (): TransactionsService => ctx.app.get(TransactionsService);
  const dialog = (): ChatDialogService => ctx.app.get(ChatDialogService);
  const sessions = (): ChatSessionService => ctx.app.get(ChatSessionService);
  const links = (): ChatLinkService => ctx.app.get(ChatLinkService);

  /**
   * A window that contains everything this suite creates and is well inside the
   * configured cap, without depending on the wall clock landing anywhere in
   * particular.
   */
  function window(): { from: string; to: string } {
    const now = Date.now();
    return {
      from: new Date(now - 86_400_000).toISOString(),
      to: new Date(now + 86_400_000).toISOString(),
    };
  }

  async function analytics(range: { from: string; to: string } = window()): Promise<Body> {
    const res = await request(http())
      .get('/admin/analytics/platforms')
      .query(range)
      .set(asAdmin)
      .expect(200);
    return res.body as Body;
  }

  function row(body: Body, origin: TransactionOrigin): Row {
    const found = body.platforms.find((p) => p.origin === origin);
    if (!found) {
      throw new Error(`no ${origin} row in the response`);
    }
    return found;
  }

  /** Seller creates + publishes over HTTP. */
  async function createAndPublish(
    headers: Record<string, string>,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await request(http())
      .post('/transactions')
      .set(headers)
      .send({ title: 'Nikes', amount: AMOUNT, ...extra })
      .expect(201);
    const txId = (created.body as { id: string }).id;
    await request(http()).post(`/transactions/${txId}/publish`).set(headers).expect(201);
    return txId;
  }

  /** Buyer starts checkout and the server-verify protects it (rule 2 path). */
  async function protect(txId: string): Promise<void> {
    const init = await request(http())
      .post('/payments/initialize')
      .set(asBuyer)
      .send({ transactionId: txId })
      .expect(201);
    const reference = (init.body as { reference: string }).reference;
    ctx.paystack.verifyResult = { status: 'success', amount: AMOUNT };
    await request(http()).post(`/payments/${reference}/verify`).set(asBuyer).expect(201);
  }

  /** Drive one event through the state machine as a participant. */
  async function apply(txId: string, event: Parameters<TransactionsService['apply']>[0]['event']) {
    return txs().apply({
      transactionId: txId,
      event,
      actor: { id: BUYER, type: ActorType.USER, role: 'BUYER' },
    });
  }

  /** The bot's own identity row for the chat-born account. */
  async function seedChatIdentity(platformUserId = '900'): Promise<string> {
    const identity = await ctx.prisma.chatIdentity.create({
      data: { platform: ChatPlatform.TELEGRAM, platformUserId, userId: CHAT_SELLER },
    });
    return identity.id;
  }

  /**
   * Drive the real chat dialog — `/sell` → title → amount → description — so the
   * transaction is created exactly the way the chat worker creates it. Returns
   * the new transaction id.
   */
  async function sellViaChat(title = 'Sneakers'): Promise<string> {
    const identityId = await seedChatIdentity();
    const identity = await ctx.prisma.chatIdentity.findUniqueOrThrow({ where: { id: identityId } });
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: CHAT_SELLER } });

    let n = 0;
    const say = async (text: string) => {
      const session = await sessions().getOrCreate(identityId);
      n += 1;
      await dialog().handle(identity, user, session, {
        platform: ChatPlatform.TELEGRAM,
        providerMessageId: `m${n}`,
        from: '900',
        text,
      });
    };

    await say('/sell');
    await say(title);
    await say('5000');
    await say('skip');

    const session = await ctx.prisma.chatSession.findUniqueOrThrow({
      where: { chatIdentityId: identityId },
    });
    if (!session.transactionId) {
      throw new Error('the chat dialog did not create a transaction');
    }
    return session.transactionId;
  }

  /** Mint a merchant + its one-time sk_test key, as an admin onboarding would. */
  async function onboardMerchant(name: string): Promise<{ id: string; bearer: string }> {
    const { merchant, apiKey } = await ctx.app.get(MerchantsService).createMerchant(name);
    return { id: merchant.id, bearer: `Bearer ${apiKey}` };
  }

  // --- cases ---------------------------------------------------------------

  it('records each write site under its own origin, and only that origin', async () => {
    // 1. the web controller
    const webTx = await createAndPublish(asWebSeller);

    // 2. the chat dialog, on the seller's own platform
    const chatTx = await sellViaChat();

    // 3. the EaaS /v1 API
    const merchant = await onboardMerchant('Merchant A');
    const seller = await request(http())
      .post('/v1/sellers')
      .set('Authorization', merchant.bearer)
      .send({ businessName: 'Store A' })
      .expect(201);
    const v1 = await request(http())
      .post('/v1/transactions')
      .set('Authorization', merchant.bearer)
      .send({ sellerId: (seller.body as { id: string }).id, title: 'Widget', amount: AMOUNT })
      .expect(201);
    const eaasTx = (v1.body as { id: string }).id;

    const rows = await ctx.prisma.transaction.findMany({
      where: { id: { in: [webTx, chatTx, eaasTx] } },
      select: { id: true, origin: true },
    });
    const originOf = (id: string) => rows.find((r) => r.id === id)?.origin;
    expect(originOf(webTx)).toBe(TransactionOrigin.WEB);
    expect(originOf(chatTx)).toBe(TransactionOrigin.TELEGRAM);
    expect(originOf(eaasTx)).toBe(TransactionOrigin.EAAS);

    // And the analytics table agrees, one row each, nowhere else.
    const body = await analytics();
    expect(row(body, TransactionOrigin.WEB).created).toBe(1);
    expect(row(body, TransactionOrigin.TELEGRAM).created).toBe(1);
    expect(row(body, TransactionOrigin.EAAS).created).toBe(1);
    expect(row(body, TransactionOrigin.WHATSAPP).created).toBe(0);
    expect(row(body, TransactionOrigin.INSTAGRAM).created).toBe(0);
    expect(row(body, TransactionOrigin.MESSENGER).created).toBe(0);
    expect(row(body, TransactionOrigin.X).created).toBe(0);
    expect(body.totals.created).toBe(3);
  });

  it('a client-supplied origin is refused outright — the server owns it (rule 1)', async () => {
    // Neither create DTO has an `origin` property and the global ValidationPipe
    // runs with `forbidNonWhitelisted`, so a client cannot even smuggle the field
    // past validation — a stronger outcome than silently ignoring it.
    await request(http())
      .post('/transactions')
      .set(asWebSeller)
      .send({ title: 'Nikes', amount: AMOUNT, origin: TransactionOrigin.TELEGRAM })
      .expect(400);

    const merchant = await onboardMerchant('Merchant A');
    const seller = await request(http())
      .post('/v1/sellers')
      .set('Authorization', merchant.bearer)
      .send({ businessName: 'Store A' })
      .expect(201);
    await request(http())
      .post('/v1/transactions')
      .set('Authorization', merchant.bearer)
      .send({
        sellerId: (seller.body as { id: string }).id,
        title: 'Widget',
        amount: AMOUNT,
        origin: TransactionOrigin.EAAS,
      })
      .expect(400);

    // Nothing was created by either attempt.
    expect(await ctx.prisma.transaction.count()).toBe(0);
  });

  it('counts an abandoned payment as started but never protected (the non-linear case)', async () => {
    const txId = await createAndPublish(asWebSeller);
    await request(http())
      .post('/payments/initialize')
      .set(asBuyer)
      .send({ transactionId: txId })
      .expect(201);
    await apply(txId, { type: 'PAYMENT_ABANDONED' });

    // The transaction is back at LINK_ACTIVE — a status-rank funnel reads that as
    // "never started payment" and loses the attempt entirely.
    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('LINK_ACTIVE');

    const web = row(await analytics(), TransactionOrigin.WEB);
    expect(web.paymentStarted).toBe(1);
    expect(web.protected).toBe(0);
    expect(web.protectedVolumeKobo).toBe('0');
  });

  it('keeps a withdrawn dispute counted as protected and as disputed (the regression case)', async () => {
    const txId = await createAndPublish(asWebSeller);
    await protect(txId);
    await request(http())
      .post(`/transactions/${txId}/disputes`)
      .set(asBuyer)
      .send({ reason: 'ITEM_NOT_RECEIVED' })
      .expect(201);
    await apply(txId, { type: 'WITHDRAW_DISPUTE' });

    // No withdraw endpoint exists yet, so the dispute row is closed here to keep
    // the fixture consistent with the timeline the machine just wrote.
    await ctx.prisma.dispute.updateMany({
      where: { transactionId: txId },
      data: { status: 'CANCELLED' },
    });

    // Final state is PAYMENT_PROTECTED, so a status-based count loses the dispute.
    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('PAYMENT_PROTECTED');

    const web = row(await analytics(), TransactionOrigin.WEB);
    expect(web.protected).toBe(1);
    expect(web.disputed).toBe(1);
    expect(web.disputeRate).toBe(1);
  });

  it('stages only ever narrow: created >= published >= started >= protected >= delivered >= released', async () => {
    // A population that spans the funnel, so the inequality is not vacuous.
    await createAndPublish(asWebSeller); // published, never paid
    const paidTx = await createAndPublish(asWebSeller);
    await protect(paidTx); // protected, never delivered

    const chatTx = await sellViaChat(); // published on TELEGRAM
    await protect(chatTx);
    await request(http()).post(`/transactions/${chatTx}/start-delivery`).set(asWebSeller);
    await request(http()).post(`/transactions/${chatTx}/mark-delivered`).set(asWebSeller);

    const body = await analytics();
    for (const r of [...body.platforms, body.totals]) {
      expect(
        r.created >= r.published &&
          r.published >= r.paymentStarted &&
          r.paymentStarted >= r.protected &&
          r.protected >= r.delivered &&
          r.delivered >= r.released,
      ).toBe(true);
    }

    const web = row(body, TransactionOrigin.WEB);
    expect([web.created, web.published, web.protected, web.delivered, web.released]).toEqual([
      2, 2, 1, 0, 0,
    ]);
    // The per-origin rows sum to the totals row rather than the totals being
    // computed from a separate query.
    expect(body.totals.created).toBe(3);
    expect(body.totals.protected).toBe(2);
  });

  it('sums money once per transaction, as decimal strings, and survives JSON.stringify', async () => {
    const txId = await createAndPublish(asWebSeller, {
      feeModel: 'SELLER_PAYS',
      feeAmount: FEE,
    });
    await protect(txId);

    // Count each stage once even though the transaction visited several.
    let web = row(await analytics(), TransactionOrigin.WEB);
    expect(web.protectedVolumeKobo).toBe(String(AMOUNT));
    expect(web.releasedVolumeKobo).toBe('0');
    expect(web.feesKobo).toBe(String(FEE));

    await ctx.seedSellerRecipient(WEB_SELLER);
    await request(http()).post(`/transactions/${txId}/start-delivery`).set(asWebSeller).expect(201);
    await request(http()).post(`/transactions/${txId}/mark-delivered`).set(asWebSeller).expect(201);
    await request(http()).post(`/transactions/${txId}/confirm`).set(asBuyer).expect(201);

    const payouts = ctx.app.get(PayoutsService);
    await payouts.executeRelease(txId);
    await payouts.markPaid(releaseIdempotencyKey(txId), 'TRF_e2e');

    web = row(await analytics(), TransactionOrigin.WEB);
    expect(web.released).toBe(1);
    expect(web.releasedVolumeKobo).toBe(String(AMOUNT));

    // The BigInt trap: a kobo value over 2^53 is fine here, but a raw BigInt would
    // have thrown on the way out. Every money value is a decimal string.
    for (const r of [...(await analytics()).platforms, (await analytics()).totals]) {
      expect(typeof r.protectedVolumeKobo).toBe('string');
      expect(typeof r.releasedVolumeKobo).toBe('string');
      expect(typeof r.feesKobo).toBe('string');
      expect(r.protectedVolumeKobo).toMatch(/^\d+$/);
    }
  });

  it('treats `to` as exclusive and refuses an inverted or over-wide range', async () => {
    const txId = await createAndPublish(asWebSeller);
    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });

    const from = new Date(tx.createdAt.getTime() - 86_400_000).toISOString();
    const to = tx.createdAt.toISOString();

    // Included when the window ends after it...
    expect(
      row(await analytics({ from, to: new Date().toISOString() }), TransactionOrigin.WEB).created,
    ).toBe(1);
    // ...and excluded when `to` is exactly its creation instant — `>= from AND < to`.
    expect(row(await analytics({ from, to }), TransactionOrigin.WEB).created).toBe(0);

    await request(http())
      .get('/admin/analytics/platforms')
      .query({ from: to, to: from })
      .set(asAdmin)
      .expect(400);

    await request(http())
      .get('/admin/analytics/platforms')
      .query({ from: '2020-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' })
      .set(asAdmin)
      .expect(400);

    // A missing bound is a 400 rather than a silent default.
    await request(http())
      .get('/admin/analytics/platforms')
      .query({ from })
      .set(asAdmin)
      .expect(400);
  });

  it('leaves recorded history alone when a chat account is linked to a web account', async () => {
    const txId = await sellViaChat('Sneakers');

    const minted = await request(http()).post('/chat/link-code').set(asWebSeller).expect(201);
    const code = (minted.body as { code: string }).code;
    const identity = await ctx.prisma.chatIdentity.findFirstOrThrow({
      where: { userId: CHAT_SELLER },
    });
    await links().consume(identity, code);

    // The person moved: the transaction now belongs to the web account...
    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.sellerId).toBe(WEB_SELLER);
    // ...but where it happened did not. Origin is a record of the past.
    expect(tx.origin).toBe(TransactionOrigin.TELEGRAM);

    const body = await analytics();
    expect(row(body, TransactionOrigin.TELEGRAM).created).toBe(1);
    expect(row(body, TransactionOrigin.WEB).created).toBe(0);
  });
});
