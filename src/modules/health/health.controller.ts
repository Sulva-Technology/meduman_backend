import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { PrismaService } from '@/prisma/prisma.service';
import { REDIS_CONNECTION } from '@/modules/queue/queue.constants';

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  /** Liveness — the process is up. No dependency checks. */
  @Public()
  @Get()
  check(): { status: 'ok'; service: string; timestamp: string } {
    return {
      status: 'ok',
      service: 'meduman-backend',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness — the process can serve traffic: Postgres and Redis both answer.
   * Returns 503 if either dependency is down so the platform stops routing to it.
   */
  @Public()
  @Get('ready')
  async ready(): Promise<{ status: 'ready'; db: boolean; redis: boolean }> {
    const [db, redis] = await Promise.all([this.pingDb(), this.pingRedis()]);
    if (!db || !redis) {
      throw new ServiceUnavailableException({ status: 'error', db, redis });
    }
    return { status: 'ready', db, redis };
  }

  private async pingDb(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async pingRedis(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
