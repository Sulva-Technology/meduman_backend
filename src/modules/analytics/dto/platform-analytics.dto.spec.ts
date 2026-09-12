import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PlatformAnalyticsQueryDto } from './platform-analytics.dto';

function validate(raw: Record<string, unknown>) {
  return validateSync(plainToInstance(PlatformAnalyticsQueryDto, raw));
}

describe('PlatformAnalyticsQueryDto', () => {
  it('accepts an ISO range', () => {
    expect(validate({ from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' })).toHaveLength(0);
  });

  it('rejects a missing bound', () => {
    expect(validate({ from: '2026-09-01T00:00:00Z' }).length).toBeGreaterThan(0);
    expect(validate({ to: '2026-10-01T00:00:00Z' }).length).toBeGreaterThan(0);
  });

  it('rejects a non-ISO value', () => {
    expect(validate({ from: 'last tuesday', to: '2026-10-01T00:00:00Z' }).length).toBeGreaterThan(
      0,
    );
  });
});
