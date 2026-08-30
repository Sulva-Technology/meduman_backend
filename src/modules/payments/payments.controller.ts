import { BadRequestException, Body, Controller, Param, Post } from '@nestjs/common';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { PaymentsService } from './payments.service';
import { InitializePaymentDto } from './dto/initialize-payment.dto';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Buyer initiates checkout — returns the Paystack authorization URL. */
  @Post('initialize')
  async initialize(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Body() dto: InitializePaymentDto,
  ): Promise<{ authorizationUrl: string; reference: string }> {
    if (!claims.email) {
      throw new BadRequestException('A buyer email is required to start a payment');
    }
    const result = await this.payments.initializeCollection({
      transactionId: dto.transactionId,
      publicLinkId: dto.publicLinkId,
      buyerId: claims.sub,
      email: claims.email,
    });
    return { authorizationUrl: result.authorizationUrl, reference: result.reference };
  }

  /**
   * Server-side verify (money rule 2). Called when the buyer returns from
   * Paystack — this triggers a server-to-Paystack verify, NOT a trusted client
   * status. Safe to call repeatedly (idempotent).
   */
  @Post(':reference/verify')
  async verify(@Param('reference') reference: string): Promise<{ status: string }> {
    const payment = await this.payments.verifyAndProtect(reference, 'SERVER_VERIFY');
    return { status: payment.status };
  }
}
