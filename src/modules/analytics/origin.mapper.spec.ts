import { ChatPlatform, TransactionOrigin } from '@prisma/client';
import { ALL_ORIGINS, toTransactionOrigin } from './origin.mapper';

describe('origin mapper', () => {
  it('lists every origin so the response can be zero-filled', () => {
    expect(ALL_ORIGINS).toHaveLength(7);
    expect(new Set(ALL_ORIGINS).size).toBe(7);
    expect(ALL_ORIGINS).toEqual(expect.arrayContaining(Object.values(TransactionOrigin)));
  });

  it('maps each chat platform to the origin of the same name', () => {
    expect(toTransactionOrigin(ChatPlatform.TELEGRAM)).toBe(TransactionOrigin.TELEGRAM);
    expect(toTransactionOrigin(ChatPlatform.WHATSAPP)).toBe(TransactionOrigin.WHATSAPP);
    expect(toTransactionOrigin(ChatPlatform.INSTAGRAM)).toBe(TransactionOrigin.INSTAGRAM);
    expect(toTransactionOrigin(ChatPlatform.MESSENGER)).toBe(TransactionOrigin.MESSENGER);
    expect(toTransactionOrigin(ChatPlatform.X)).toBe(TransactionOrigin.X);
  });

  it('is total — every ChatPlatform has an origin, and none maps to WEB or EAAS', () => {
    for (const platform of Object.values(ChatPlatform)) {
      const origin = toTransactionOrigin(platform);
      expect(origin).toBeDefined();
      // A chat platform's origin is never WEB (that would lose the platform) and
      // never EAAS (that is the tenant path, not a chat surface).
      expect(origin).not.toBe(TransactionOrigin.WEB);
      expect(origin).not.toBe(TransactionOrigin.EAAS);
    }
  });
});
