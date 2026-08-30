import type { Server } from 'node:http';
import { InvoiceStatus, TransactionStatus } from '@prisma/client';
import request from 'supertest';
import { InvoicesService } from '@/modules/invoices/invoices.service';
import type { CreateInvoiceDto } from '@/modules/invoices/dto/create-invoice.dto';
import { authHeaders } from './utils/e2e-identity';
import type { MoneyE2EContext } from './utils/e2e-harness';

/**
 * End-to-end proof of the invoicing money-safety invariants against a REAL
 * database. Only external seams (Paystack, auth, Redis/queue) are faked. These
 * need a throwaway Postgres — set DATABASE_URL to a TEST database and run
 * `npm run test:e2e`. They SKIP when no DATABASE_URL is configured so an
 * unconfigured CI stays green.
 */
const describeE2E = process.env.DATABASE_URL ? describe : describe.skip;

const SELLER = '11111111-1111-1111-1111-111111111111';
const BUYER = '22222222-2222-2222-2222-222222222222';
// Two lines: 2 x ₦500 + 1 x ₦250 = ₦1,250.00 (125,000 kobo). No tax.
const LINE_ITEMS = [
  { title: 'Sneakers', quantity: 2, unitPrice: 50_000 },
  { title: 'Laces', quantity: 1, unitPrice: 25_000 },
];
const TOTAL = 125_000; // server-computed kobo total

describeE2E('Invoicing money-safety (e2e)', () => {
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
  });

  /** Create a DRAFT invoice over HTTP and return its id. */
  async function createDraftInvoice(): Promise<string> {
    const created = await request(http())
      .post('/invoices')
      .set(asSeller)
      .send({ lineItems: LINE_ITEMS })
      .expect(201);
    return (created.body as { id: string }).id;
  }

  /**
   * Drive the linked transaction to PAYMENT_PROTECTED the SAME way the core
   * money-safety e2e does: buyer initializes collection, then a server-side
   * verify (trusted source) protects. This is the ONLY path that flips an
   * invoice to PAID — there is no client-facing "mark paid".
   */
  async function protectInvoiceTx(txId: string): Promise<string> {
    const init = await request(http())
      .post('/payments/initialize')
      .set(asBuyer)
      .send({ transactionId: txId })
      .expect(201);
    const reference = (init.body as { reference: string }).reference;

    ctx.paystack.verifyResult = { status: 'success', amount: TOTAL };
    await request(http()).post(`/payments/${reference}/verify`).set(asBuyer).expect(201);
    return reference;
  }

  it('send mints exactly one protected Transaction + one pay link (amount = server total)', async () => {
    const id = await createDraftInvoice();

    const sent = await request(http()).post(`/invoices/${id}/send`).set(asSeller).expect(201);
    const body = sent.body as { status: string; transactionId: string | null; total: number };

    expect(body.status).toBe(InvoiceStatus.SENT);
    expect(body.transactionId).toBeTruthy();
    expect(body.total).toBe(TOTAL);

    // Exactly one Transaction, linked, live on a pay link, at the frozen total.
    const txs = await ctx.prisma.transaction.findMany({ where: { sellerId: SELLER } });
    expect(txs).toHaveLength(1);
    const tx = txs[0]!;
    expect(tx.id).toBe(body.transactionId);
    expect(tx.status).toBe(TransactionStatus.LINK_ACTIVE);
    expect(tx.publicLinkId).toBeTruthy();
    expect(tx.amount).toBe(TOTAL);
  });

  it('server owns totals — client-sent subtotal/taxAmount/total are ignored', async () => {
    // Bypass the DTO whitelist (which would reject the extra fields outright) and
    // hand the service bogus money fields directly — it must recompute, not trust.
    const bogus = {
      lineItems: LINE_ITEMS,
      subtotal: 1,
      taxAmount: 1,
      total: 1,
    } as unknown as CreateInvoiceDto;

    const invoice = await ctx.app.get(InvoicesService).createDraft(SELLER, bogus);

    const persisted = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(persisted.subtotal).toBe(TOTAL);
    expect(persisted.taxAmount).toBe(0);
    expect(persisted.total).toBe(TOTAL);
    // And never the bogus client numbers.
    expect(persisted.total).not.toBe(1);
  });

  it('an invoice becomes PAID only via the protect path — never a client call', async () => {
    const id = await createDraftInvoice();
    const sent = await request(http()).post(`/invoices/${id}/send`).set(asSeller).expect(201);
    const txId = (sent.body as { transactionId: string }).transactionId;

    // Before any protect event: sent, but NOT paid.
    let invoice = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(invoice.status).toBe(InvoiceStatus.SENT);
    expect(invoice.paidAt).toBeNull();

    await protectInvoiceTx(txId);

    // The signed/server-verify protect derived PAID — not a client request.
    invoice = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(invoice.status).toBe(InvoiceStatus.PAID);
    expect(invoice.paidAt).not.toBeNull();

    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe(TransactionStatus.PAYMENT_PROTECTED);
  });

  it('idempotent PAID and send — no double transaction, no regression', async () => {
    const id = await createDraftInvoice();
    const sent = await request(http()).post(`/invoices/${id}/send`).set(asSeller).expect(201);
    const txId = (sent.body as { transactionId: string }).transactionId;

    // A second send on an already-sent invoice mints no second transaction.
    const resent = await request(http()).post(`/invoices/${id}/send`).set(asSeller).expect(201);
    expect((resent.body as { transactionId: string }).transactionId).toBe(txId);
    expect(await ctx.prisma.transaction.count({ where: { sellerId: SELLER } })).toBe(1);

    const reference = await protectInvoiceTx(txId);

    // Re-run the protect path on the same reference: verify is an idempotent
    // no-op on an already-SUCCESS payment, so nothing double-counts.
    await request(http()).post(`/payments/${reference}/verify`).set(asBuyer).expect(201);

    const invoice = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(invoice.status).toBe(InvoiceStatus.PAID);
    const successPayments = await ctx.prisma.payment.findMany({
      where: { transactionId: txId, status: 'SUCCESS' },
    });
    expect(successPayments).toHaveLength(1);
    expect(await ctx.prisma.transaction.count({ where: { sellerId: SELLER } })).toBe(1);
  });

  it('voiding a sent-but-unpaid invoice cancels its Transaction', async () => {
    const id = await createDraftInvoice();
    const sent = await request(http()).post(`/invoices/${id}/send`).set(asSeller).expect(201);
    const txId = (sent.body as { transactionId: string }).transactionId;

    await request(http()).post(`/invoices/${id}/void`).set(asSeller).expect(201);

    const invoice = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(invoice.status).toBe(InvoiceStatus.VOID);
    expect(invoice.voidedAt).not.toBeNull();

    const tx = await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.status).toBe(TransactionStatus.CANCELLED);
  });
});
