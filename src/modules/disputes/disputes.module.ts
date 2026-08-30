import { Module } from '@nestjs/common';
import { TransactionsModule } from '@/modules/transactions/transactions.module';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';

/**
 * Disputes: raise/resolve. An OPEN dispute freezes automated release for its
 * transaction (money rule 5) — enforced in the state machine; this module
 * creates the dispute row and drives the matching transition.
 */
@Module({
  imports: [TransactionsModule],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
