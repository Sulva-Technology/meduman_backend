import { BadRequestException } from '@nestjs/common';

/** Why an OTP verification failed. Kept server-side for logs/audit. */
export enum OtpFailureReason {
  NO_ACTIVE_CODE = 'NO_ACTIVE_CODE',
  EXPIRED = 'EXPIRED',
  LOCKED = 'LOCKED',
  MISMATCH = 'MISMATCH',
}

/**
 * A failed OTP verification. The client-facing message is deliberately generic
 * (no oracle telling an attacker whether a code was wrong, expired, or locked);
 * the precise {@link OtpFailureReason} is carried for server logs and audit rows.
 */
export class OtpVerificationError extends BadRequestException {
  constructor(readonly reason: OtpFailureReason) {
    super('Invalid or expired code');
  }
}

/**
 * An OTP was requested for a transaction that is not awaiting buyer confirmation.
 * Issuing a delivery-confirmation code only makes sense in CONFIRMATION_PENDING.
 */
export class OtpNotIssuableError extends BadRequestException {
  constructor(status: string) {
    super(`Cannot issue a confirmation code while transaction is ${status}`);
  }
}
