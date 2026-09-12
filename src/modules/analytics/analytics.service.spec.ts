import { Test } from '@nestjs/testing';
import { TransactionOrigin } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService.getPlatformMetrics', () => {
  let service: AnalyticsService;
  let prisma: { $queryRaw: jest.Mock };

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      providers: [AnalyticsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(AnalyticsService);
  });

  it('returns all seven origins zero-filled when nothing is in range', async () => {
    const res = await service.getPlatformMetrics(
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    );
    expect(res.platforms).toHaveLength(7);
    expect(res.totals.created).toBe(0);
    expect(res.from).toBe('2026-09-01T00:00:00.000Z');
    expect(res.to).toBe('2026-10-01T00:00:00.000Z');
  });

  it('maps a real row, converting bigint to number and money to string', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        origin: TransactionOrigin.TELEGRAM,
        sellers: 4n,
        buyers: 9n,
        created: 10n,
        published: 10n,
        paymentStarted: 8n,
        protected: 6n,
        delivered: 5n,
        released: 4n,
        disputed: 1n,
        protectedVolumeKobo: 1200000n,
        releasedVolumeKobo: 800000n,
        feesKobo: 18000n,
      },
    ]);
    const res = await service.getPlatformMetrics(new Date(0), new Date());
    const tg = res.platforms.find((p) => p.origin === TransactionOrigin.TELEGRAM)!;
    expect(tg.protected).toBe(6);
    expect(tg.protectedVolumeKobo).toBe('1200000');
    expect(tg.disputeRate).toBe(0.1666);
    expect(res.totals.protected).toBe(6);
  });

  it('is JSON-serializable with a non-empty volume row', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        origin: TransactionOrigin.WEB,
        sellers: 1n,
        buyers: 1n,
        created: 1n,
        published: 1n,
        paymentStarted: 1n,
        protected: 1n,
        delivered: 0n,
        released: 1n,
        disputed: 0n,
        protectedVolumeKobo: 9007199254740993n,
        releasedVolumeKobo: 1n,
        feesKobo: 0n,
      },
    ]);
    const res = await service.getPlatformMetrics(new Date(0), new Date());
    expect(() => JSON.stringify(res)).not.toThrow();
  });

  it('passes the window through with an exclusive upper bound', async () => {
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-09-08T00:00:00Z');
    await service.getPlatformMetrics(from, to);
    // `$queryRaw` is called with ONE argument — the `Sql` object built by
    // `Prisma.sql` — not with (strings, ...values). The window is the first two
    // interpolations; the stage constants follow.
    const sql = prisma.$queryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(sql.values.slice(0, 2)).toEqual([from, to]);
  });
});
