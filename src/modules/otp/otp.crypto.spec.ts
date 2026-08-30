import { generateNumericCode, hashCode, timingSafeEqualHex } from './otp.crypto';

describe('generateNumericCode', () => {
  it('returns a string of exactly the requested length', () => {
    expect(generateNumericCode(6)).toHaveLength(6);
    expect(generateNumericCode(4)).toHaveLength(4);
  });

  it('returns only decimal digits (leading zeros preserved)', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateNumericCode(6)).toMatch(/^[0-9]{6}$/);
    }
  });

  it('does not return the same code every call', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateNumericCode(6)));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('hashCode', () => {
  const secret = 'test-otp-secret';

  it('is deterministic for the same code + secret', () => {
    expect(hashCode('123456', secret)).toBe(hashCode('123456', secret));
  });

  it('differs for a different code', () => {
    expect(hashCode('123456', secret)).not.toBe(hashCode('123457', secret));
  });

  it('differs for a different secret (keyed, not plain digest)', () => {
    expect(hashCode('123456', secret)).not.toBe(hashCode('123456', 'other-secret'));
  });

  it('never contains the plaintext code', () => {
    expect(hashCode('123456', secret)).not.toContain('123456');
  });
});

describe('timingSafeEqualHex', () => {
  it('is true for identical hex strings', () => {
    const h = hashCode('123456', 's');
    expect(timingSafeEqualHex(h, h)).toBe(true);
  });

  it('is false for different hex strings', () => {
    expect(timingSafeEqualHex(hashCode('1', 's'), hashCode('2', 's'))).toBe(false);
  });

  it('is false (never throws) when lengths differ', () => {
    expect(timingSafeEqualHex('abcd', 'ab')).toBe(false);
  });
});
