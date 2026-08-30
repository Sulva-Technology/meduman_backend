import { Module } from '@nestjs/common';
import { PayoutsModule } from '@/modules/payouts/payouts.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/** Admin console: read-only queues + audit trail, plus the failed-payout retry.
 * Dispute resolution (the other money-moving admin action) stays in the disputes
 * module. */
@Module({
  imports: [PayoutsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
