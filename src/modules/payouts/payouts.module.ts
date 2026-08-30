import { Module } from '@nestjs/common';
import { TransactionsModule } from '@/modules/transactions/transactions.module';
import { PayoutsService } from './payouts.service';

/**
 * Payouts: idempotent release execution (money rules 3 & 4). One payout per
 * transaction (unique idempotencyKey); a duplicate release or retried job never
 * double-pays. Authorized only from RELEASE_PROCESSING; completed via the signed
 * transfer webhook. Runs off a BullMQ queue, never inside an HTTP request.
 */
@Module({
  imports: [TransactionsModule],
  providers: [PayoutsService],
  exports: [PayoutsService],
})
export class PayoutsModule {}
