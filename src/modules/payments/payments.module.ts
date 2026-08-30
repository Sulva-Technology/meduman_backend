import { Module } from '@nestjs/common';
import { TransactionsModule } from '@/modules/transactions/transactions.module';
import { InvoicesModule } from '@/modules/invoices/invoices.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Payments: Paystack collection + server-side verify.
 * Payment status changes ONLY from a signed webhook or a server-side verify
 * call — NEVER from a client callback (money rule 2).
 */
@Module({
  imports: [TransactionsModule, InvoicesModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
