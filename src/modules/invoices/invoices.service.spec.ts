import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '@/prisma/prisma.service';
import type { TransactionsService } from '@/modules/transactions/transactions.service';
import type { NotificationsService } from '@/modules/notifications/notifications.service';
import { InvoicesService } from './invoices.service';

function makeService() {
  const invoiceCreate = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'inv-1', status: 'DRAFT', ...args.data }),
  );
  const invoiceFindUnique = jest.fn<Promise<Record<string, unknown> | null>, [unknown]>(() =>
    Promise.resolve(null),
  );
  const invoiceFindMany = jest.fn().mockResolvedValue([]);
  const invoiceUpdate = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'inv-1', ...args.data }),
  );
  const invoiceUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const invoiceFindFirst = jest.fn().mockResolvedValue(null);
  const auditCreate = jest.fn().mockResolvedValue({});

  const invoiceCounterUpsert = jest.fn().mockResolvedValue({ sellerId: 'seller-1', nextSeq: 2 });
  const lineItemFindMany = jest.fn().mockResolvedValue([]);

  const prisma = {
    invoice: {
      create: invoiceCreate,
      findUnique: invoiceFindUnique,
      findFirst: invoiceFindFirst,
      findMany: invoiceFindMany,
      update: invoiceUpdate,
      updateMany: invoiceUpdateMany,
    },
    invoiceLineItem: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: lineItemFindMany,
    },
    invoiceCounter: { upsert: invoiceCounterUpsert },
    auditLog: { create: auditCreate },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
  } as unknown as PrismaService;

  const apply = jest.fn().mockResolvedValue({});
  const createDraft = jest.fn().mockResolvedValue({ id: 'tx-1', publicLinkId: 'link-1' });
  const transactions = {
    createDraft,
    apply,
  } as unknown as TransactionsService;

  const enqueueInvoice = jest.fn().mockResolvedValue(undefined);
  const notifications = {
    enqueueInvoice,
  } as unknown as NotificationsService;

  const service = new InvoicesService(prisma, transactions, notifications);
  return {
    service,
    invoiceCreate,
    invoiceFindUnique,
    invoiceFindFirst,
    invoiceUpdate,
    invoiceUpdateMany,
    invoiceCounterUpsert,
    apply,
    createDraft,
    enqueueInvoice,
    lineItemFindMany,
  };
}

describe('InvoicesService.createDraft', () => {
  it('computes totals server-side and stores line totals; ignores any client-sent totals', async () => {
    const { service, invoiceCreate } = makeService();
    await service.createDraft('seller-1', {
      lineItems: [{ title: 'A', quantity: 2, unitPrice: 250_00 }],
      taxRatePctBp: 750,
    });
    expect(invoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subtotal: 500_00,
          taxAmount: 37_50, // 7.5% of 500_00
          total: 537_50,
          status: 'DRAFT',
          publicViewId: expect.any(String),
        }),
      }),
    );
  });
});

describe('InvoicesService.edit', () => {
  it('recomputes totals on a tax-only edit (no new lines) against the current lines', async () => {
    const { service, invoiceFindUnique, invoiceUpdate, lineItemFindMany } = makeService();
    invoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      sellerId: 'seller-1',
      status: 'DRAFT',
      taxRatePctBp: null,
    });
    lineItemFindMany.mockResolvedValue([{ quantity: 1, unitPrice: 1_000_00 }]);

    await service.edit('seller-1', 'inv-1', { taxRatePctBp: 750 });

    // Recomputed against the invoice's current lines (fetched because none supplied).
    expect(lineItemFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { invoiceId: 'inv-1' } }),
    );
    expect(invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taxRatePctBp: 750,
          subtotal: 1_000_00,
          taxAmount: 75_00, // 7.5% of 1_000_00
          total: 1_075_00,
        }),
      }),
    );
  });

  it('rejects editing a non-DRAFT invoice', async () => {
    const { service, invoiceFindUnique } = makeService();
    invoiceFindUnique.mockResolvedValue({ id: 'inv-1', sellerId: 'seller-1', status: 'SENT' });
    await expect(service.edit('seller-1', 'inv-1', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-owner', async () => {
    const { service, invoiceFindUnique } = makeService();
    invoiceFindUnique.mockResolvedValue({ id: 'inv-1', sellerId: 'seller-1', status: 'DRAFT' });
    await expect(service.edit('someone-else', 'inv-1', {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('InvoicesService.void', () => {
  it('rejects voiding a PAID invoice', async () => {
    const { service, invoiceFindUnique } = makeService();
    invoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      sellerId: 'seller-1',
      status: 'PAID',
      transactionId: 'tx-1',
    });
    await expect(service.void('seller-1', 'inv-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cancels the linked transaction when voiding a sent invoice', async () => {
    const { service, invoiceFindUnique, invoiceUpdate, apply } = makeService();
    invoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      sellerId: 'seller-1',
      status: 'SENT',
      transactionId: 'tx-1',
    });
    await service.void('seller-1', 'inv-1');
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-1', event: { type: 'CANCEL' } }),
    );
    expect(invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VOID' }) }),
    );
  });
});

describe('InvoicesService.getById', () => {
  it('404s a missing invoice', async () => {
    const { service } = makeService();
    await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('InvoicesService.send', () => {
  it('mints one protected tx, allocates the number, flips to SENT, and enqueues delivery', async () => {
    const { service, invoiceFindUnique, invoiceUpdateMany, createDraft, apply, enqueueInvoice } =
      makeService();
    invoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      sellerId: 'seller-1',
      status: 'DRAFT',
      total: 537_50,
      transactionId: null,
      number: '',
      currency: 'NGN',
      lineItems: [],
    });

    await service.send('seller-1', 'inv-1');

    expect(createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ sellerId: 'seller-1', amount: 537_50 }),
    );
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-1', event: { type: 'SELLER_PUBLISH' } }),
    );
    expect(invoiceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-1', status: 'DRAFT' },
        data: expect.objectContaining({
          status: 'SENT',
          number: 'INV-0001',
          transactionId: 'tx-1',
        }),
      }),
    );
    expect(enqueueInvoice).toHaveBeenCalledWith({ invoiceId: 'inv-1' });
  });

  it('is idempotent: re-sending an already-SENT invoice mints no second transaction', async () => {
    const { service, invoiceFindUnique, createDraft } = makeService();
    invoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      sellerId: 'seller-1',
      status: 'SENT',
      total: 537_50,
      transactionId: 'tx-1',
      number: 'INV-0001',
      currency: 'NGN',
      lineItems: [],
    });

    await service.send('seller-1', 'inv-1');

    expect(createDraft).not.toHaveBeenCalled();
  });

  it('refuses to send an invoice with a zero total', async () => {
    const { service, invoiceFindUnique } = makeService();
    invoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      sellerId: 'seller-1',
      status: 'DRAFT',
      total: 0,
      transactionId: null,
      number: '',
      currency: 'NGN',
      lineItems: [],
    });

    await expect(service.send('seller-1', 'inv-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('InvoicesService.getPublicView', () => {
  it('marks a SENT invoice VIEWED and returns VIEWED status', async () => {
    const { service, invoiceFindUnique, invoiceUpdateMany } = makeService();
    invoiceFindUnique.mockResolvedValueOnce({
      id: 'inv-1',
      status: 'SENT',
      number: 'INV-0001',
      issueDate: new Date('2026-08-01'),
      dueDate: null,
      currency: 'NGN',
      buyerName: 'Ada',
      subtotal: 500_00,
      taxAmount: 0,
      total: 500_00,
      notes: null,
      terms: null,
      publicViewId: 'pv-1',
      lineItems: [],
      transaction: { publicLinkId: 'link-1' },
      seller: { fullName: 'S', sellerProfile: null },
    });

    const view = await service.getPublicView('pv-1');

    expect(invoiceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'SENT' }),
        data: expect.objectContaining({ status: 'VIEWED' }),
      }),
    );
    expect(view.status).toBe('VIEWED');
    expect(view.payLinkId).toBe('link-1');
  });

  it('404s a DRAFT invoice and never marks it viewed', async () => {
    const { service, invoiceFindUnique, invoiceUpdateMany } = makeService();
    invoiceFindUnique.mockResolvedValueOnce({
      id: 'inv-1',
      status: 'DRAFT',
      publicViewId: 'pv-1',
      lineItems: [],
      transaction: null,
      seller: null,
    });

    await expect(service.getPublicView('pv-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(invoiceUpdateMany).not.toHaveBeenCalled();
  });

  it('404s a missing invoice', async () => {
    const { service, invoiceFindUnique } = makeService();
    invoiceFindUnique.mockResolvedValueOnce(null);

    await expect(service.getPublicView('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('InvoicesService.remind', () => {
  it('re-delivers a SENT invoice', async () => {
    const { service, invoiceFindUnique, enqueueInvoice } = makeService();
    invoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      sellerId: 'seller-1',
      status: 'SENT',
      number: 'INV-0001',
    });

    await service.remind('seller-1', 'inv-1');

    expect(enqueueInvoice).toHaveBeenCalledWith({ invoiceId: 'inv-1' });
  });

  it('writes an audit row', async () => {
    const { service, invoiceFindUnique } = makeService();
    invoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      sellerId: 'seller-1',
      status: 'SENT',
      number: 'INV-0001',
    });

    const prisma = (service as unknown as { prisma: { auditLog: { create: jest.Mock } } }).prisma;

    await service.remind('seller-1', 'inv-1');

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'invoice.reminded', targetId: 'inv-1' }),
      }),
    );
  });

  it('rejects reminding a DRAFT invoice', async () => {
    const { service, invoiceFindUnique, enqueueInvoice } = makeService();
    invoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      sellerId: 'seller-1',
      status: 'DRAFT',
      number: '',
    });

    await expect(service.remind('seller-1', 'inv-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(enqueueInvoice).not.toHaveBeenCalled();
  });

  it('rejects reminding a PAID invoice', async () => {
    const { service, invoiceFindUnique, enqueueInvoice } = makeService();
    invoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      sellerId: 'seller-1',
      status: 'PAID',
      number: 'INV-0001',
    });

    await expect(service.remind('seller-1', 'inv-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(enqueueInvoice).not.toHaveBeenCalled();
  });

  it('rejects a non-owner', async () => {
    const { service, invoiceFindUnique } = makeService();
    invoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      sellerId: 'seller-1',
      status: 'SENT',
      number: 'INV-0001',
    });

    await expect(service.remind('someone-else', 'inv-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('InvoicesService.scanOverdue', () => {
  it('flips past-due SENT/VIEWED invoices to OVERDUE', async () => {
    const { service, invoiceUpdateMany } = makeService();
    invoiceUpdateMany.mockResolvedValue({ count: 3 });

    const count = await service.scanOverdue();

    expect(invoiceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['SENT', 'VIEWED'] },
          dueDate: { lt: expect.any(Date) },
        }),
        data: expect.objectContaining({ status: 'OVERDUE' }),
      }),
    );
    expect(count).toBe(3);
  });
});

describe('InvoicesService.markPaidByTransaction', () => {
  it('flips a SENT invoice to PAID for the linked transaction', async () => {
    const { service, invoiceUpdateMany, invoiceFindFirst } = makeService();
    invoiceUpdateMany.mockResolvedValue({ count: 1 });
    invoiceFindFirst.mockResolvedValue({ id: 'inv-1' });

    await service.markPaidByTransaction('tx-1');

    const arg = invoiceUpdateMany.mock.calls[0][0];
    expect(arg.where.transactionId).toBe('tx-1');
    expect(arg.where.status).toEqual({ in: ['SENT', 'VIEWED', 'OVERDUE'] });
    expect(arg.data.status).toBe('PAID');
  });

  it('no-op when the transaction has no invoice', async () => {
    const { service, invoiceUpdateMany } = makeService();
    invoiceUpdateMany.mockResolvedValue({ count: 0 });

    await expect(service.markPaidByTransaction('tx-none')).resolves.toBeUndefined();
  });
});
