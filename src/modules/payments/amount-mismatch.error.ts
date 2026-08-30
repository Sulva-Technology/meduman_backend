import { BadRequestException } from '@nestjs/common';

/**
 * The amount Paystack reports as collected does not match the amount we asked it
 * to collect. A hard money-safety stop — the transaction is NOT protected and a
 * human must reconcile. Never auto-release on a mismatched charge.
 */
export class AmountMismatchError extends BadRequestException {
  constructor(
    readonly reference: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Payment ${reference} amount mismatch: expected ${expected} kobo, got ${actual} kobo`);
  }
}
