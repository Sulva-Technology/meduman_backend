import { Body, Controller, ForbiddenException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ActorType, OtpPurpose, type Transaction } from '@prisma/client';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { TransactionsService } from '@/modules/transactions/transactions.service';
import { QueueService } from '@/modules/queue/queue.service';
import { OtpService } from './otp.service';
import { VerifyOtpDto } from './dto/verify-otp.dto';

/**
 * OTP step-up for buyer delivery confirmation. Two steps:
 *  1. `POST /transactions/:id/otp` — issue a code. The plaintext is delivered
 *     OUT-OF-BAND (SMS / WhatsApp / bot) by the delivery layer and is never
 *     returned in the HTTP response, so the buyer's own client can't read it.
 *  2. `POST /transactions/:id/confirm-otp` — submit the code. On a valid code we
 *     drive BUYER_CONFIRM (server-owned, money rule 1) and enqueue the idempotent
 *     release off-request.
 *
 * NOTE: the delivery channel is a separate seam (see PRODUCTION_READINESS §7).
 * Until it is wired, `issue` persists a code but nothing sends it.
 */
@Controller('transactions')
export class OtpController {
  constructor(
    private readonly otp: OtpService,
    private readonly transactions: TransactionsService,
    private readonly queue: QueueService,
  ) {}

  /** Buyer requests a delivery-confirmation code. Returns only its id + expiry. */
  // Tight limit: issuing codes is costly (SMS) and shouldn't be spammable.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post(':id/otp')
  async request(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ otpId: string; expiresAt: Date }> {
    const tx = await this.transactions.getById(id);
    if (tx.buyerId !== claims.sub) {
      throw new ForbiddenException('Only the buyer can request a confirmation code');
    }

    const { otpId, expiresAt } = await this.otp.issue({
      transactionId: id,
      purpose: OtpPurpose.DELIVERY_CONFIRMATION,
      actor: { id: claims.sub, type: ActorType.USER, role: 'BUYER' },
    });

    // The plaintext `code` is intentionally dropped here — delivery is out-of-band.
    return { otpId, expiresAt };
  }

  /** Buyer submits the code; on success confirm delivery and enqueue release. */
  // Blunt brute-force at the edge; the per-code attempt cap is the primary guard.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/confirm-otp')
  async confirm(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: VerifyOtpDto,
  ): Promise<Transaction> {
    const tx = await this.transactions.getById(id);
    if (tx.buyerId !== claims.sub) {
      throw new ForbiddenException('Only the buyer can confirm this transaction');
    }

    const actor = { id: claims.sub, type: ActorType.USER, role: 'BUYER' };

    // Verify first — throws (fail-closed) on any invalid/expired/locked code.
    await this.otp.verify({
      transactionId: id,
      purpose: OtpPurpose.DELIVERY_CONFIRMATION,
      code: dto.code,
      actor,
    });

    const updated = await this.transactions.apply({
      transactionId: id,
      event: { type: 'BUYER_CONFIRM' },
      actor,
      reason: 'buyer confirmed via OTP',
    });

    await this.queue.enqueueRelease(id);
    return updated;
  }
}
