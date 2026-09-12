import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of two hex strings. Returns false (never throws) when
 * lengths differ, so a mismatched candidate can't leak timing about the stored
 * hash. Shared by the OTP and chat-link verify paths.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
