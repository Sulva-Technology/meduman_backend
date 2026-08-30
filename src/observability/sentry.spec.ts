import { shouldEnableSentry } from './sentry';

describe('shouldEnableSentry', () => {
  it('is false when no DSN is configured', () => {
    expect(shouldEnableSentry(undefined)).toBe(false);
    expect(shouldEnableSentry('')).toBe(false);
  });

  it('is true when a DSN is present', () => {
    expect(shouldEnableSentry('https://abc@o1.ingest.sentry.io/123')).toBe(true);
  });
});
