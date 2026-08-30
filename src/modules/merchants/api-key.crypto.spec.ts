import { generateApiKey, hashApiKey } from './api-key.crypto';

describe('api-key.crypto', () => {
  it('generates a prefixed secret whose prefix matches the mode', () => {
    const live = generateApiKey(true);
    expect(live.plaintext.startsWith('sk_live_')).toBe(true);
    expect(live.prefix.startsWith('sk_live_')).toBe(true);
    expect(live.plaintext.startsWith(live.prefix)).toBe(true);
    const test = generateApiKey(false);
    expect(test.plaintext.startsWith('sk_test_')).toBe(true);
  });

  it('produces unique secrets across calls', () => {
    expect(generateApiKey(true).plaintext).not.toEqual(generateApiKey(true).plaintext);
  });

  it('hashes deterministically per (plaintext, secret) and differs by secret', () => {
    expect(hashApiKey('sk_test_abc', 's1')).toEqual(hashApiKey('sk_test_abc', 's1'));
    expect(hashApiKey('sk_test_abc', 's1')).not.toEqual(hashApiKey('sk_test_abc', 's2'));
  });
});
