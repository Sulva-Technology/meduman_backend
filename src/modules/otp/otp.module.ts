import { Module } from '@nestjs/common';
import { TransactionsModule } from '@/modules/transactions/transactions.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';

/**
 * OTP: issue + verify one-time codes for buyer delivery confirmation (release
 * step-up). Drives BUYER_CONFIRM through the state machine on a valid code and
 * enqueues the idempotent release. See PRODUCTION_READINESS §7 for the
 * (out-of-band) delivery channel that still needs wiring.
 *
 * AuditService + QueueService come from their @Global modules; only the
 * (non-global) TransactionsModule needs importing.
 */
@Module({
  imports: [TransactionsModule, NotificationsModule],
  controllers: [OtpController],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}
