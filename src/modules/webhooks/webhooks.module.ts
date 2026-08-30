import { Module } from '@nestjs/common';
import { PaymentsModule } from '@/modules/payments/payments.module';
import { PayoutsModule } from '@/modules/payouts/payouts.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * Webhooks: Paystack webhook receiver. Verifies HMAC-SHA512 signature
 * (x-paystack-signature) against the raw body BEFORE trusting anything, then
 * dedupes and dispatches to payments/payouts.
 */
@Module({
  imports: [PaymentsModule, PayoutsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
