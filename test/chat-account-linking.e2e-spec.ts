import type { Server } from 'node:http';
import request from 'supertest';
import { ChatLinkService } from '@/modules/chat/linking/chat-link.service';
import { authHeaders } from './utils/e2e-identity';
import type { MoneyE2EContext } from './utils/e2e-harness';

/**
 * End-to-end proof that linking a chat account to a web account cannot move money
 * (or un-freeze it) behind the six rules. Real database, real state machine, real
 * merge transaction; only Paystack / auth / Redis are faked, exactly as
 * `money-safety.e2e-spec.ts` does. Skips without DATABASE_URL.
 */
const describeE2E = process.env.DATABASE_URL ? describe : describe.skip;

/** The chat-born throwaway — absorbed by the merge (the SOURCE). */
const CHAT_SELLER = '11111111-1111-1111-1111-111111111111';
/** The real signed-up account that mints the code (the TARGET). */
const WEB_USER = '22222222-2222-2222-2222-222222222222';
/** A third party, on neither side of the merge. */
const BUYER = '33333333-3333-3333-3333-333333333333';
const AMOUNT = 125_000; // kobo (₦1,250.00)

describeE2E('Chat account linking (e2e)', () => {
  let ctx: MoneyE2EContext;

  const http = (): Server => ctx.app.getHttpServer() as Server;
  const asChatSeller = authHeaders({ sub: CHAT_SELLER, appRole: 'SELLER' });
  const asWebUser = authHeaders({ sub: WEB_USER, appRole: 'SELLER' });
  const asBuyer = authHeaders({ sub: BUYER, appRole: 'BUYER' });
  const asAdmin = authHeaders({ sub: '00000000-0000-4000-8000-00000000admi', appRole: 'ADMIN' });

  const links = (): ChatLinkService => ctx.app.get(ChatLinkService);

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
    await ctx.seedUser(WEB_USER, { email: 'web@e2e.test' });
    await ctx.seedUser(BUYER, { email: 'buyer@e2e.test' });
    ctx.paystack.transfers = [];
    ctx.paystack.transferError = null;
    ctx.paystack.knownTransfers.clear();
  });

  /** The bot's own identity row for the chat-born account. */
  async function seedChatIdentity(platformUserId = '900'): Promise<string> {
    const identity = await ctx.prisma.chatIdentity.create({
      data: { platform: 'TELEGRAM', platformUserId, userId: CHAT_SELLER },
    });
    return identity.id;
  }

  /** Web side mints; chat side types it in. */
  async function mintCode(): Promise<string> {
    const res = await request(http()).post('/chat/link-code').set(asWebUser).expect(201);
    return (res.body as { code: string }).code;
  }

  async function consume(identityId: string, code: string) {
    const identity = await ctx.prisma.chatIdentity.findUniqueOrThrow({
      where: { id: identityId },
    });
    return links().consume(identity, code);
  }

  async function requestRow() {
    return ctx.prisma.chatLinkRequest.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Seller creates + publishes; buyer server-verifies → PAYMENT_PROTECTED. */
  async function driveToProtected(sellerHeaders: Record<string, string>): Promise<string> {
    const created = await request(http())
      .post('/transactions')
      .set(sellerHeaders)
      .send({ title: 'Nikes', amount: AMOUNT })
      .expect(201);
    const txId = (created.body as { id: string }).id;

    await request(http()).post(`/transactions/${txId}/publish`).set(sellerHeaders).expect(201);

    const init = await request(http())
      .post('/payments/initialize')
      .set(asBuyer)
      .send({ transactionId: txId })
      .expect(201);
    const reference = (init.body as { reference: string }).reference;

    ctx.paystack.verifyResult = { status: 'success', amount: AMOUNT };
    await request(http()).post(`/payments/${reference}/verify`).set(asBuyer).expect(201);

    return txId;
  }

  it('Rule 1: a protected transaction survives the merge with its status unchanged', async () => {
    const txId = await driveToProtected(asChatSeller);
    const identityId = await seedChatIdentity();
    // Snapshot before the merge — the merge must not append or rewrite history.
    const timelineBefore = await ctx.prisma.timelineEvent.count({ where: { transactionId: txId } });

    const code = await mintCode();
    await expect(consume(identityId, code)).resolves.toEqual({
      status: 'LINKED',
      platform: 'TELEGRAM',
    });

    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.sellerId).toBe(WEB_USER);
    expect(tx.status).toBe('PAYMENT_PROTECTED');

    // The absorbed account is a TOMBSTONE, never a hard delete (legal retention).
    const source = await ctx.prisma.user.findUniqueOrThrow({ where: { id: CHAT_SELLER } });
    expect(source.status).toBe('DEACTIVATED');
    expect(source.mergedIntoUserId).toBe(WEB_USER);
    expect(source.mergedAt).not.toBeNull();

    // No money moved and no history was rewritten by the merge itself.
    expect(await ctx.prisma.payout.count({ where: { transactionId: txId } })).toBe(0);
    expect(await ctx.prisma.timelineEvent.count({ where: { transactionId: txId } })).toBe(
      timelineBefore,
    );

    // The merge is auditable (rule 6): one new row, naming what moved.
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'chat.account_linked', targetId: WEB_USER },
    });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toMatchObject({ sourceUserId: CHAT_SELLER });
  });

  it('Rule 5: an open dispute still freezes release after the merge', async () => {
    // Drive to CONFIRMATION_PENDING, then dispute it — the state where the buyer's
    // confirm is the only path to release.
    const created = await request(http())
      .post('/transactions')
      .set(asChatSeller)
      .send({ title: 'Nikes', amount: AMOUNT })
      .expect(201);
    const txId = (created.body as { id: string }).id;
    await request(http()).post(`/transactions/${txId}/publish`).set(asChatSeller).expect(201);
    const init = await request(http())
      .post('/payments/initialize')
      .set(asBuyer)
      .send({ transactionId: txId })
      .expect(201);
    ctx.paystack.verifyResult = { status: 'success', amount: AMOUNT };
    await request(http())
      .post(`/payments/${(init.body as { reference: string }).reference}/verify`)
      .set(asBuyer)
      .expect(201);
    await request(http())
      .post(`/transactions/${txId}/start-delivery`)
      .set(asChatSeller)
      .expect(201);
    await request(http())
      .post(`/transactions/${txId}/mark-delivered`)
      .set(asChatSeller)
      .expect(201);
    await request(http())
      .post(`/transactions/${txId}/disputes`)
      .set(asBuyer)
      .send({ reason: 'ITEM_NOT_RECEIVED' })
      .expect(201);

    const identityId = await seedChatIdentity();
    const code = await mintCode();
    await expect(consume(identityId, code)).resolves.toMatchObject({ status: 'LINKED' });

    // The dispute moved to the surviving account (it backs a participant check)...
    const dispute = await ctx.prisma.dispute.findFirstOrThrow({ where: { transactionId: txId } });
    expect(dispute.status).toBe('OPEN');
    expect(dispute.openedBy).toBe(BUYER);

    // ...and the freeze still holds: no release, no payout, status untouched.
    await request(http()).post(`/transactions/${txId}/confirm`).set(asBuyer).expect(409);
    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe('DISPUTED');
    expect(await ctx.prisma.payout.count({ where: { transactionId: txId } })).toBe(0);
  });

  it('Rule 6: a SELLER_PROFILE_CONFLICT parks for review and writes nothing', async () => {
    // Two payout destinations — the one case this code refuses to decide alone.
    await ctx.seedSellerRecipient(CHAT_SELLER, 'RCP_chat');
    await ctx.seedSellerRecipient(WEB_USER, 'RCP_web');
    const identityId = await seedChatIdentity();

    const code = await mintCode();
    await expect(consume(identityId, code)).resolves.toEqual({
      status: 'PENDING_REVIEW',
      reason: 'SELLER_PROFILE_CONFLICT',
    });

    // No partial merge: every row still belongs to its original owner.
    const identity = await ctx.prisma.chatIdentity.findUniqueOrThrow({ where: { id: identityId } });
    expect(identity.userId).toBe(CHAT_SELLER);
    await expect(
      ctx.prisma.user.findUniqueOrThrow({ where: { id: CHAT_SELLER } }),
    ).resolves.toMatchObject({ status: 'ACTIVE', mergedIntoUserId: null });

    // Both destinations are intact — neither was silently chosen.
    const profiles = await ctx.prisma.sellerProfile.findMany({
      where: { userId: { in: [CHAT_SELLER, WEB_USER] } },
      orderBy: { providerRecipientCode: 'asc' },
    });
    expect(profiles.map((p) => p.providerRecipientCode)).toEqual(['RCP_chat', 'RCP_web']);

    const row = await requestRow();
    expect(row.status).toBe('PENDING_REVIEW');
    expect(row.conflictReason).toBe('SELLER_PROFILE_CONFLICT');
  });

  it('Rule 1: a SELF_TRANSACTION_CONFLICT is not admin-resolvable', async () => {
    // Chat-born account is the seller; the web account it would merge into is the
    // buyer. Merged, one user is both sides of the same escrow — structurally
    // invalid, so no profile choice can rescue it.
    const txId = await driveToProtected(asChatSeller);
    await ctx.prisma.transaction.update({ where: { id: txId }, data: { buyerId: WEB_USER } });

    const identityId = await seedChatIdentity();
    const code = await mintCode();
    await expect(consume(identityId, code)).resolves.toEqual({
      status: 'PENDING_REVIEW',
      reason: 'SELF_TRANSACTION_CONFLICT',
    });

    const row = await requestRow();

    await request(http())
      .post(`/admin/chat/link-requests/${row.id}/resolve`)
      .set(asAdmin)
      .send({ outcome: 'COMPLETE', keepProfile: 'TARGET' })
      .expect(409);

    // Nothing merged, and the request is still parked.
    await expect(
      ctx.prisma.user.findUniqueOrThrow({ where: { id: CHAT_SELLER } }),
    ).resolves.toMatchObject({ mergedIntoUserId: null });
    expect((await requestRow()).status).toBe('PENDING_REVIEW');

    // Rejecting is the only way out.
    await request(http())
      .post(`/admin/chat/link-requests/${row.id}/resolve`)
      .set(asAdmin)
      .send({ outcome: 'REJECT' })
      .expect(201);
    expect((await requestRow()).status).toBe('REJECTED');
  });

  it('Rule 4: an in-flight payout defers the link, then the same code works', async () => {
    const txId = await driveToProtected(asChatSeller);
    const payout = await ctx.prisma.payout.create({
      data: {
        transactionId: txId,
        sellerId: CHAT_SELLER,
        idempotencyKey: `release:${txId}`,
        amount: AMOUNT,
        status: 'PENDING',
      },
    });
    const identityId = await seedChatIdentity();

    const code = await mintCode();
    await expect(consume(identityId, code)).resolves.toEqual({ status: 'RETRY' });

    // Refused WITHOUT consuming: the code is live and nothing was re-parented —
    // the transfer destination is read from the seller profile at send time.
    expect((await requestRow()).status).toBe('PENDING');
    const identity = await ctx.prisma.chatIdentity.findUniqueOrThrow({ where: { id: identityId } });
    expect(identity.userId).toBe(CHAT_SELLER);

    // Once the transfer is terminal, the very same code links.
    await ctx.prisma.payout.update({ where: { id: payout.id }, data: { status: 'SUCCESS' } });
    await expect(consume(identityId, code)).resolves.toMatchObject({ status: 'LINKED' });
    expect(
      (await ctx.prisma.chatIdentity.findUniqueOrThrow({ where: { id: identityId } })).userId,
    ).toBe(WEB_USER);
  });

  it('a link code cannot be replayed', async () => {
    const identityId = await seedChatIdentity();
    const code = await mintCode();

    await expect(consume(identityId, code)).resolves.toMatchObject({ status: 'LINKED' });
    // Second attempt is the same generic failure as any bad code — no oracle.
    await expect(consume(identityId, code)).resolves.toEqual({ status: 'INVALID' });

    // Exactly one merge ever ran.
    const merges = await ctx.prisma.auditLog.count({
      where: { action: 'chat.account_linked', targetId: WEB_USER },
    });
    expect(merges).toBe(1);
  });

  it('an expired code fails generically and merges nothing', async () => {
    const identityId = await seedChatIdentity();
    const code = await mintCode();
    await ctx.prisma.chatLinkRequest.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(consume(identityId, code)).resolves.toEqual({ status: 'INVALID' });

    await expect(
      ctx.prisma.user.findUniqueOrThrow({ where: { id: CHAT_SELLER } }),
    ).resolves.toMatchObject({ mergedIntoUserId: null });
  });

  it('Rule 6: an admin COMPLETE leaves exactly one payout destination', async () => {
    await ctx.seedSellerRecipient(CHAT_SELLER, 'RCP_chat');
    await ctx.seedSellerRecipient(WEB_USER, 'RCP_web');
    const identityId = await seedChatIdentity();

    const code = await mintCode();
    await consume(identityId, code);
    const row = await requestRow();
    expect(row.status).toBe('PENDING_REVIEW');

    await request(http())
      .post(`/admin/chat/link-requests/${row.id}/resolve`)
      .set(asAdmin)
      .send({ outcome: 'COMPLETE', keepProfile: 'TARGET' })
      .expect(201);

    // The admin's ruling is the decision the guard refused to make: the surviving
    // account keeps its own destination and the absorbed one is gone.
    const profiles = await ctx.prisma.sellerProfile.findMany({
      where: { userId: { in: [CHAT_SELLER, WEB_USER] } },
    });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ userId: WEB_USER, providerRecipientCode: 'RCP_web' });

    // The identity moved and the request is closed with the actor recorded.
    expect(
      (await ctx.prisma.chatIdentity.findUniqueOrThrow({ where: { id: identityId } })).userId,
    ).toBe(WEB_USER);
    const resolved = await requestRow();
    expect(resolved.status).toBe('COMPLETED');
    expect(resolved.resolvedBy).toBe('00000000-0000-4000-8000-00000000admi');

    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'chat.link_request_completed', targetId: row.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe('00000000-0000-4000-8000-00000000admi');
  });
});
