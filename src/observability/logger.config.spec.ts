import { REDACT_PATHS, buildLoggerConfig } from './logger.config';

describe('buildLoggerConfig', () => {
  it('takes its level from LOG_LEVEL', () => {
    const cfg = buildLoggerConfig({ NODE_ENV: 'production', LOG_LEVEL: 'warn' });
    expect(cfg.pinoHttp.level).toBe('warn');
  });

  it('redacts auth + Paystack signature headers and OTP code fields', () => {
    const cfg = buildLoggerConfig({ NODE_ENV: 'production', LOG_LEVEL: 'info' });
    const paths = cfg.pinoHttp.redact.paths;
    expect(paths).toEqual(expect.arrayContaining([expect.stringContaining('authorization')]));
    expect(paths).toEqual(expect.arrayContaining([expect.stringContaining('paystack-signature')]));
    expect(REDACT_PATHS.some((p) => p.includes('code'))).toBe(true);
  });
});
