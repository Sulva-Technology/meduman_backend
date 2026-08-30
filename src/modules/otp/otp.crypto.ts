import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * OTP crypto primitives. Pure and dependency-free (only Node's crypto), so the
 * security-critical bits — cryptographic randomness, keyed hashing, constant-time
 * comparison — are unit-testable in isolation.
 *
 * We NEVER store or log the plaintext code. Only the keyed HMAC hash is persisted
 * (schema: `OtpCode.codeHash`). A plain digest of a 6-digit code is trivially
 * brute-forced from a DB leak, so the hash is keyed with a server secret.
 */

/**
 * A cryptographically-random decimal code of exactly `length` digits. Uses
 * `crypto.randomInt` per digit (uniform, no modulo bias); leading zeros are kept,
 * so "004215" is a valid 6-digit code.
 */
export function generateNumericCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += randomInt(0, 10).toString();
  }
  return code;
}

/** Keyed HMAC-SHA256 of the code, hex-encoded. Deterministic per (code, secret). */
export function hashCode(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code).digest('hex');
}

/**
 * Constant-time comparison of two hex strings. Returns false (never throws) when
 * lengths differ, so a mismatched candidate can't leak timing about the stored hash.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
