import { decryptSecret, encryptSecret, generateWebhookSecret } from './webhook-secret.crypto';

const KEY = 'unit-webhook-signing-key-000000000000';

describe('webhook-secret.crypto', () => {
  it('generates a whsec_-prefixed secret, unique per call', () => {
    const a = generateWebhookSecret();
    expect(a.startsWith('whsec_')).toBe(true);
    expect(a).not.toEqual(generateWebhookSecret());
  });

  it('round-trips encrypt→decrypt with the same key', () => {
    const secret = generateWebhookSecret();
    const enc = encryptSecret(secret, KEY);
    expect(enc).not.toContain(secret); // ciphertext, not plaintext
    expect(enc.split(':')).toHaveLength(3);
    expect(decryptSecret(enc, KEY)).toBe(secret);
  });

  it('fails to decrypt with a different key', () => {
    const enc = encryptSecret('whsec_abc', KEY);
    expect(() => decryptSecret(enc, 'a-different-key-000000000000000000')).toThrow();
  });
});
