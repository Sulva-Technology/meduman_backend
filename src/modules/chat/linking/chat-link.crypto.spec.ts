import {
  LINK_CODE_ALPHABET,
  generateLinkCode,
  hashLinkCode,
  normalizeLinkCode,
} from './chat-link.crypto';
import { timingSafeEqualHex } from '@/common/crypto/timing-safe';

describe('chat-link crypto', () => {
  it('excludes the character pairs users confuse when retyping', () => {
    // The code crosses two input surfaces — read off a web page, typed into chat.
    expect(LINK_CODE_ALPHABET).not.toMatch(/[0O1I]/);
    expect(LINK_CODE_ALPHABET).toHaveLength(32);
  });

  it('generates a code of the requested length from the alphabet only', () => {
    const code = generateLinkCode(8);
    expect(code).toHaveLength(8);
    for (const ch of code) {
      expect(LINK_CODE_ALPHABET).toContain(ch);
    }
  });

  it('generates distinct codes', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateLinkCode(8)));
    // 32^8 is ~1.1e12; 200 draws colliding would mean the generator is broken.
    expect(codes.size).toBe(200);
  });

  it('hashes deterministically per (code, secret) and differs per secret', () => {
    expect(hashLinkCode('ABCD2345', 'secret-a')).toBe(hashLinkCode('ABCD2345', 'secret-a'));
    expect(hashLinkCode('ABCD2345', 'secret-a')).not.toBe(hashLinkCode('ABCD2345', 'secret-b'));
  });

  it('normalizes case and whitespace so retyping cannot decide validity', () => {
    expect(normalizeLinkCode('  abcd2345 ')).toBe('ABCD2345');
    expect(normalizeLinkCode('abcd 2345')).toBe('ABCD2345');
  });

  it('compares hex in constant time, returning false on a length mismatch', () => {
    const h = hashLinkCode('ABCD2345', 'secret-a');
    expect(timingSafeEqualHex(h, h)).toBe(true);
    expect(timingSafeEqualHex(h, hashLinkCode('ZZZZ9999', 'secret-a'))).toBe(false);
    expect(timingSafeEqualHex(h, 'ab')).toBe(false);
  });
});
