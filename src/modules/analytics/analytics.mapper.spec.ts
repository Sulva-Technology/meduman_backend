import { TransactionOrigin } from '@prisma/client';
import { toPlatformAnalyticsResponse, type PlatformMetrics } from './analytics.mapper';

function metrics(over: Partial<PlatformMetrics> = {}): PlatformMetrics {
  return {
    origin: TransactionOrigin.WEB,
    sellers: 0n,
    buyers: 0n,
    created: 0n,
    published: 0n,
    paymentStarted: 0n,
    protected: 0n,
    delivered: 0n,
    released: 0n,
    disputed: 0n,
    protectedVolumeKobo: 0n,
    releasedVolumeKobo: 0n,
    feesKobo: 0n,
    ...over,
  };
}

describe('toPlatformAnalyticsResponse', () => {
  it('zero-fills every origin so the table shape is constant', () => {
    const res = toPlatformAnalyticsResponse([metrics({ origin: TransactionOrigin.TELEGRAM })]);
    expect(res.platforms).toHaveLength(7);
    const web = res.platforms.find((p) => p.origin === TransactionOrigin.WEB);
    expect(web?.created).toBe(0);
    expect(web?.protectedVolumeKobo).toBe('0');
  });

  it('serializes counts as numbers and money as decimal strings', () => {
    const res = toPlatformAnalyticsResponse([
      metrics({ created: 12n, protectedVolumeKobo: 5000000n, feesKobo: 75000n }),
    ]);
    const web = res.platforms.find((p) => p.origin === TransactionOrigin.WEB)!;
    expect(web.created).toBe(12);
    expect(typeof web.created).toBe('number');
    expect(web.protectedVolumeKobo).toBe('5000000');
    expect(typeof web.protectedVolumeKobo).toBe('string');
    expect(web.feesKobo).toBe('75000');
  });

  it('survives JSON.stringify with non-empty volume — the case that 500s a naive impl', () => {
    const res = toPlatformAnalyticsResponse([
      metrics({ protectedVolumeKobo: 9007199254740993n }), // > Number.MAX_SAFE_INTEGER
    ]);
    expect(() => JSON.stringify(res)).not.toThrow();
    const web = res.platforms.find((p) => p.origin === TransactionOrigin.WEB)!;
    // A JSON number would have silently lost the last digit.
    expect(web.protectedVolumeKobo).toBe('9007199254740993');
  });

  it('computes disputeRate as a fraction, 4dp, and 0 when nothing was protected', () => {
    const res = toPlatformAnalyticsResponse([
      metrics({ protected: 1000n, disputed: 21n }),
      metrics({ origin: TransactionOrigin.X, protected: 0n, disputed: 0n }),
    ]);
    expect(res.platforms.find((p) => p.origin === TransactionOrigin.WEB)!.disputeRate).toBe(0.021);
    expect(res.platforms.find((p) => p.origin === TransactionOrigin.X)!.disputeRate).toBe(0);
  });

  it('totals every origin, summing money as bigint (no precision loss)', () => {
    const res = toPlatformAnalyticsResponse([
      metrics({ created: 2n, protectedVolumeKobo: 9007199254740993n }),
      metrics({ origin: TransactionOrigin.EAAS, created: 3n, protectedVolumeKobo: 7n }),
    ]);
    expect(res.totals.created).toBe(5);
    expect(res.totals.protectedVolumeKobo).toBe('9007199254741000');
    expect(res.totals.origin).toBe('ALL');
  });

  it('totals re-derive disputeRate rather than summing the per-origin rates', () => {
    const res = toPlatformAnalyticsResponse([
      metrics({ protected: 10n, disputed: 1n }),
      metrics({ origin: TransactionOrigin.EAAS, protected: 10n, disputed: 0n }),
    ]);
    // 1/20, not 0.1 + 0 = 0.2.
    expect(res.totals.disputeRate).toBe(0.05);
  });
});
