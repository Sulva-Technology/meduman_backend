import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

/** Platform activity analytics. Read-only — no controllers here; the admin
 * routes live on the admin controller. `PrismaModule` is `@Global()`, so
 * `PrismaService` is injectable without an import. */
@Module({
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
