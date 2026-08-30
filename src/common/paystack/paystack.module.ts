import { Global, Module } from '@nestjs/common';
import { PaystackService } from './paystack.service';

/**
 * Shared Paystack client. Global so payments/, payouts/, webhooks/ and users/
 * (seller subaccounts) all inject the one configured client.
 */
@Global()
@Module({
  providers: [PaystackService],
  exports: [PaystackService],
})
export class PaystackModule {}
