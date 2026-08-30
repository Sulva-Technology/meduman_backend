import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { Dispute } from '@prisma/client';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import { Roles } from '@/modules/auth/decorators/roles.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { DisputesService } from './disputes.service';
import { RaiseDisputeDto } from './dto/raise-dispute.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';

@Controller()
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  /** Buyer or seller raises a dispute on a transaction (freezes release). */
  @Post('transactions/:transactionId/disputes')
  async raise(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('transactionId', new ParseUUIDPipe()) transactionId: string,
    @Body() dto: RaiseDisputeDto,
  ): Promise<Dispute> {
    return this.disputes.raise({
      transactionId,
      openedBy: claims.sub,
      role: claims.appRole ?? 'BUYER',
      reason: dto.reason,
      ...(dto.description ? { description: dto.description } : {}),
      ...(dto.desiredOutcome ? { desiredOutcome: dto.desiredOutcome } : {}),
    });
  }

  /** Admin resolves a dispute for the seller (release) or buyer (refund). */
  @Roles('ADMIN')
  @Post('disputes/:id/resolve')
  async resolve(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ResolveDisputeDto,
  ): Promise<Dispute> {
    return this.disputes.resolve({
      disputeId: id,
      resolvedBy: claims.sub,
      outcome: dto.outcome,
      ...(dto.resolution ? { resolution: dto.resolution } : {}),
    });
  }
}
