/** Pure, dependency-free invoice money math. All values are integer kobo. */

export interface LineInput {
  quantity: number;
  unitPrice: number; // kobo
}

export interface InvoiceTotals {
  subtotal: number; // kobo
  taxAmount: number; // kobo
  total: number; // kobo
}

/** A line's total is unit price times quantity. Integer kobo in, integer kobo out. */
export function computeLineTotal(line: LineInput): number {
  return line.unitPrice * line.quantity;
}

/**
 * Sum the lines into a subtotal, apply the optional basis-point tax rate
 * (750 bp = 7.5%), and return subtotal/tax/total. Tax rounds half-up to whole
 * kobo via Math.round on the single division — never a float in the stored value.
 */
export function computeTotals(lines: LineInput[], taxRatePctBp: number | null): InvoiceTotals {
  const subtotal = lines.reduce((sum, line) => sum + computeLineTotal(line), 0);
  const taxAmount = taxRatePctBp == null ? 0 : Math.round((subtotal * taxRatePctBp) / 10_000);
  return { subtotal, taxAmount, total: subtotal + taxAmount };
}
