import { Injectable, type OnModuleDestroy, type OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Runtime Prisma client. Connects via DATABASE_URL (pooled / pgbouncer).
 * Migrations use DIRECT_URL and are run by the Prisma CLI, not this client.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected (pooled DATABASE_URL)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
