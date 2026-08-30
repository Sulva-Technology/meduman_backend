import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { PrismaService } from '@/prisma/prisma.service';
import { HealthController } from './health.controller';

function makeController(opts: { dbOk?: boolean; redisOk?: boolean } = {}) {
  const prisma = {
    $queryRaw:
      opts.dbOk === false
        ? jest.fn().mockRejectedValue(new Error('down'))
        : jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  } as unknown as PrismaService;
  const redis = {
    ping:
      opts.redisOk === false
        ? jest.fn().mockRejectedValue(new Error('down'))
        : jest.fn().mockResolvedValue('PONG'),
  } as unknown as Redis;
  return new HealthController(prisma, redis);
}

describe('HealthController.check (liveness)', () => {
  it('returns ok status', () => {
    const res = makeController().check();
    expect(res.status).toBe('ok');
    expect(res.service).toBe('meduman-backend');
    expect(typeof res.timestamp).toBe('string');
  });
});

describe('HealthController.ready (readiness)', () => {
  it('reports ready when Postgres and Redis both answer', async () => {
    const res = await makeController({ dbOk: true, redisOk: true }).ready();
    expect(res).toEqual(expect.objectContaining({ status: 'ready', db: true, redis: true }));
  });

  it('returns 503 when the database is unreachable', async () => {
    await expect(makeController({ dbOk: false }).ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('returns 503 when Redis is unreachable', async () => {
    await expect(makeController({ redisOk: false }).ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
