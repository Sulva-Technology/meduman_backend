import { createHmac, randomInt } from 'node:crypto';

/**
 * Link-code crypto primitives. Pure and dependency-free (Node crypto only), so
 * the security-critical bits are unit-testable in isolation — the same posture
 * as otp.crypto.ts.
 *
 * The plaintext is shown once to an authenticated web caller and typed by the
 * user into chat. It is NEVER stored or logged; only a keyed HMAC-SHA256 is
 * persisted (schema: `ChatLinkRequest.codeHash`). A plain digest of an 8-char
 * code is brute-forceable from a DB leak, so the hash is keyed with a server
 * secret — exactly the OTP reasoning.
 */

/**
 * Excludes 0/O and 1/I. The code is read off one screen and typed into another,
 * and those are the pairs users get wrong.
 */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A cryptographically-random code from LINK_CODE_ALPHABET. Uniform, no modulo bias. */
export function generateLinkCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += LINK_CODE_ALPHABET[randomInt(0, LINK_CODE_ALPHABET.length)];
  }
  return code;
}

/** Keyed HMAC-SHA256 of the code, hex-encoded. Deterministic per (code, secret). */
export function hashLinkCode(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code).digest('hex');
}

/**
 * Normalize user-typed input before hashing. The alphabet is uppercase-only and
 * the code crosses two input surfaces, so case and stray whitespace must not
 * decide whether a valid code works.
 */
export function normalizeLinkCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}
