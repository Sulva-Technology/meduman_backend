import { Module } from '@nestjs/common';
import { OutboundEventsModule } from '@/modules/outbound-events/outbound-events.module';
import { TransactionsService } from './transactions.service';
import { AutoReleaseService } from './auto-release.service';
import { TransactionsController } from './transactions.controller';
import { PublicTransactionsController } from './public-transactions.controller';

/**
 * Transactions: the server-owned state machine. Sole owner of TransactionStatus.
 * Never trusts client-supplied status or amount. Every transition -> audit log.
 *
 * The pure machine lives in ./state-machine (no HTTP/Prisma/Paystack). The
 * TransactionsService is the thin persistence wrapper around it.
 * TODO(next): controller (create/init, mark-delivered, confirm), OTP release.
 */
@Module({
  imports: [OutboundEventsModule],
  controllers: [TransactionsController, PublicTransactionsController],
  providers: [TransactionsService, AutoReleaseService],
  exports: [TransactionsService, AutoReleaseService],
})
export class TransactionsModule {}
