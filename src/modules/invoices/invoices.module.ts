import { Module } from '@nestjs/common';
import { TransactionsModule } from '@/modules/transactions/transactions.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';
import { PublicInvoicesController } from './public-invoices.controller';

/**
 * Invoices: seller-issued invoices that mint one protected Transaction on send
 * and derive PAID from the protect path (never from a client). The server owns
 * number, status, every money total, and the publicViewId.
 *
 * PrismaService comes from the @Global PrismaModule; the service's two other
 * deps (TransactionsService, NotificationsService) are imported here — the same
 * pair OtpModule imports. No cycle: neither of those modules imports Invoices.
 */
@Module({
  imports: [TransactionsModule, NotificationsModule],
  controllers: [InvoicesController, PublicInvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
