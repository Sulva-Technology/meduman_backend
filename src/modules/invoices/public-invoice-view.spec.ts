import { toPublicInvoiceView, type InvoiceForPublicView } from './public-invoice-view';

const row: InvoiceForPublicView = {
  number: 'INV-0001',
  status: 'SENT',
  issueDate: new Date('2026-08-01'),
  dueDate: null,
  currency: 'NGN',
  buyerName: 'Ada',
  subtotal: 500_00,
  taxAmount: 37_50,
  total: 537_50,
  notes: null,
  terms: null,
  lineItems: [{ title: 'A', description: null, quantity: 2, unitPrice: 250_00, lineTotal: 500_00 }],
  transaction: { publicLinkId: 'link-1' },
  seller: { fullName: 'Seller Co', sellerProfile: { businessName: 'Biz', badgeSlug: 'biz' } },
};

describe('toPublicInvoiceView', () => {
  it('projects only allow-listed fields (prefers business name, exposes pay link)', () => {
    const view = toPublicInvoiceView(row);
    expect(view).toEqual({
      number: 'INV-0001',
      status: 'SENT',
      issueDate: row.issueDate,
      dueDate: null,
      currency: 'NGN',
      buyerName: 'Ada',
      lineItems: [
        { title: 'A', description: null, quantity: 2, unitPrice: 250_00, lineTotal: 500_00 },
      ],
      subtotal: 500_00,
      taxAmount: 37_50,
      total: 537_50,
      notes: null,
      terms: null,
      sellerName: 'Biz',
      sellerBadgeSlug: 'biz',
      payLinkId: 'link-1',
    });
  });

  it('never leaks internal identifiers', () => {
    const view = toPublicInvoiceView(row) as unknown as Record<string, unknown>;
    for (const forbidden of ['transactionId', 'sellerId', 'buyerId', 'id', 'publicViewId']) {
      expect(view).not.toHaveProperty(forbidden);
    }
  });
});
