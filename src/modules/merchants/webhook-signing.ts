import { createHmac } from 'node:crypto';

/** HMAC-SHA256 over "<timestamp>.<rawBody>", hex. The merchant recomputes to verify. */
export function signPayload(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
}

/** Stripe-style signature header value. */
export function buildSignatureHeader(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return `t=${timestampSeconds},v1=${signPayload(secret, timestampSeconds, rawBody)}`;
}
