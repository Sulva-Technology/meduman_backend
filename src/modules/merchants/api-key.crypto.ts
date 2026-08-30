import { createHmac, randomBytes } from 'node:crypto';

/** Full secret + its public prefix. Prefix is safe to store/log; plaintext is not. */
export function generateApiKey(livemode: boolean): { plaintext: string; prefix: string } {
  const tag = livemode ? 'sk_live_' : 'sk_test_';
  const body = randomBytes(20).toString('hex'); // 40 hex chars
  return { plaintext: `${tag}${body}`, prefix: `${tag}${body.slice(0, 6)}` };
}

/** Keyed HMAC-SHA256 of the full secret, hex. The stored lookup key — never plaintext. */
export function hashApiKey(plaintext: string, secret: string): string {
  return createHmac('sha256', secret).update(plaintext).digest('hex');
}
