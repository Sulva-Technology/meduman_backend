import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuditLog, Payout } from '@prisma/client';
import type { Env } from '@/config/env.validation';
import { Roles } from '@/modules/auth';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { AnalyticsService } from '@/modules/analytics/analytics.service';
import type { PlatformAnalyticsResponse } from '@/modules/analytics/analytics.types';
import { PlatformAnalyticsQueryDto } from '@/modules/analytics/dto/platform-analytics.dto';
import { PayoutsService, releaseIdempotencyKey } from '@/modules/payouts/payouts.service';
import { AdminService } from './admin.service';
import { AdminListDisputesDto, AdminListTransactionsDto } from './dto/admin-list.dto';

/** Admin console reads. Every route requires the ADMIN app role. */
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly payouts: PayoutsService,
    private readonly analytics: AnalyticsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Per-platform funnel + money over a date range. Read-only — no audit row.
   *
   * The range is bounded because the query scans a cohort of transactions and
   * probes each one's timeline: an unbounded window is a scan whose cost the
   * caller chooses. Ordering and width are checked here rather than in the DTO
   * because the width cap comes from config.
   */
  @Get('analytics/platforms')
  async platformAnalytics(
    @Query() q: PlatformAnalyticsQueryDto,
  ): Promise<PlatformAnalyticsResponse> {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (from >= to) {
      throw new BadRequestException('`from` must be earlier than `to`');
    }
    const maxDays = this.config.get('ANALYTICS_MAX_RANGE_DAYS', { infer: true });
    if (to.getTime() - from.getTime() > maxDays * 86_400_000) {
      throw new BadRequestException(`Range must not exceed ${maxDays} days`);
    }
    return this.analytics.getPlatformMetrics(from, to);
  }

  @Get('transactions')
  transactions(@Query() q: AdminListTransactionsDto) {
    return this.admin.listTransactions(q);
  }

  @Get('disputes')
  disputes(@Query() q: AdminListDisputesDto) {
    return this.admin.listDisputes(q);
  }

  @Get('transactions/:id/audit')
  audit(@Param('id', new ParseUUIDPipe()) id: string): Promise<AuditLog[]> {
    return this.admin.getAuditForTx(id);
  }

  /**
   * Re-send a payout whose transfer failed or was reversed. The only admin route
   * here that moves money, so it is deliberately narrow: it re-sends the payout
   * already authorized for this transaction and cannot create a new one, cannot
   * touch a settled or in-flight payout, and is refused while a dispute is open.
   */
  @Post('transactions/:id/payout/retry')
  retryPayout(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() claims: SupabaseJwtClaims,
  ): Promise<Payout> {
    return this.payouts.retryTransfer(releaseIdempotencyKey(id), claims.sub);
  }
}
