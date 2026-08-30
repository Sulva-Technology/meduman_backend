import { computeLineTotal, computeTotals } from './invoice.compute';

describe('invoice.compute', () => {
  it('computes a line total as unitPrice * quantity (kobo)', () => {
    expect(computeLineTotal({ unitPrice: 250_00, quantity: 3 })).toBe(750_00);
  });

  it('sums subtotal across lines with no tax when rate is null', () => {
    const totals = computeTotals(
      [
        { unitPrice: 250_00, quantity: 2 }, // 500_00
        { unitPrice: 100_00, quantity: 1 }, // 100_00
      ],
      null,
    );
    expect(totals).toEqual({ subtotal: 600_00, taxAmount: 0, total: 600_00 });
  });

  it('applies a basis-point tax rate with integer rounding (7.5% VAT)', () => {
    // subtotal 1_000_00 kobo, 750 bp = 7.5% -> tax 75_00, total 1_075_00
    const totals = computeTotals([{ unitPrice: 1_000_00, quantity: 1 }], 750);
    expect(totals).toEqual({ subtotal: 1_000_00, taxAmount: 75_00, total: 1_075_00 });
  });

  it('rounds tax half-up to whole kobo', () => {
    // subtotal 333_33 kobo, 750bp = 7.5% -> 333_33 * 750 / 10_000 = 2499.975 -> rounds to 2500 kobo
    const totals = computeTotals([{ unitPrice: 333_33, quantity: 1 }], 750);
    expect(totals.taxAmount).toBe(2500);
    expect(totals.total).toBe(333_33 + 2500);
  });

  it('returns zero totals for an empty invoice', () => {
    expect(computeTotals([], null)).toEqual({ subtotal: 0, taxAmount: 0, total: 0 });
  });
});
