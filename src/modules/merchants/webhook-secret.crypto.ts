import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 32-byte AES key derived from the configured secret string. */
function deriveKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

/** A fresh signing secret shared with the merchant. Returned once, then encrypted. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(20).toString('hex')}`;
}

/** AES-256-GCM. Output "iv:tag:ciphertext" hex. Never store the plaintext. */
export function encryptSecret(plaintext: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decryptSecret(enc: string, key: string): string {
  const parts = enc.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted secret format');
  }
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(key), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString(
    'utf8',
  );
}
