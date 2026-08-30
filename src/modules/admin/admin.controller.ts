import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuditLog, Payout } from '@prisma/client';
import { Roles } from '@/modules/auth';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
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
  ) {}

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
