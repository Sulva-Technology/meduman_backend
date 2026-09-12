import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import type { AnalyticsService } from '@/modules/analytics/analytics.service';
import type { AdminService } from './admin.service';
import type { PayoutsService } from '@/modules/payouts/payouts.service';
import { AdminController } from './admin.controller';

function makeController(maxDays = 366) {
  const getPlatformMetrics = jest.fn().mockResolvedValue({ platforms: [], totals: {} });
  const controller = new AdminController(
    {} as unknown as AdminService,
    {} as unknown as PayoutsService,
    { getPlatformMetrics } as unknown as AnalyticsService,
    {
      get: (_key: keyof Env) => maxDays,
    } as unknown as ConfigService<Env, true>,
  );
  return { controller, getPlatformMetrics };
}

describe('AdminController.platformAnalytics', () => {
  it('passes a valid range through to the service', async () => {
    const { controller, getPlatformMetrics } = makeController();
    await controller.platformAnalytics({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
    });
    expect(getPlatformMetrics).toHaveBeenCalledWith(
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-10-01T00:00:00.000Z'),
    );
  });

  it('rejects an inverted range', async () => {
    const { controller, getPlatformMetrics } = makeController();
    await expect(
      controller.platformAnalytics({
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(getPlatformMetrics).not.toHaveBeenCalled();
  });

  it('rejects a zero-width range', async () => {
    const { controller } = makeController();
    await expect(
      controller.platformAnalytics({
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a range wider than the configured cap', async () => {
    const { controller, getPlatformMetrics } = makeController(30);
    await expect(
      controller.platformAnalytics({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(getPlatformMetrics).not.toHaveBeenCalled();
  });

  it('accepts a range exactly at the cap', async () => {
    const { controller, getPlatformMetrics } = makeController(30);
    await controller.platformAnalytics({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z', // exactly 30 days
    });
    expect(getPlatformMetrics).toHaveBeenCalled();
  });
});
