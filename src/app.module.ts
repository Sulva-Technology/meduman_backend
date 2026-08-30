import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from './config/config.module';
import { buildLoggerConfig } from './observability/logger.config';
import type { Env } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { PaystackModule } from './common/paystack/paystack.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { PayoutsModule } from './modules/payouts/payouts.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { OtpModule } from './modules/otp/otp.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { StorageModule } from './modules/storage/storage.module';
import { EvidenceModule } from './modules/evidence/evidence.module';
import { AuditModule } from './modules/audit/audit.module';
import { AdminModule } from './modules/admin/admin.module';
import { WaitlistModule } from './modules/waitlist/waitlist.module';
import { QueueModule } from './modules/queue/queue.module';
import { ChatModule } from './modules/chat/chat.module';
import { MerchantsModule } from './modules/merchants/merchants.module';
import { OutboundEventsModule } from './modules/outbound-events/outbound-events.module';

@Module({
  imports: [
    // infra
    AppConfigModule,
    // Structured JSON logging (pino) with secret redaction + request correlation ids.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        buildLoggerConfig({
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
          LOG_LEVEL: config.get('LOG_LEVEL', { infer: true }),
        }),
    }),
    // Global rate limit: 100 requests / 60s per IP (webhooks are @SkipThrottle).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    PaystackModule,
    QueueModule,
    // domain
    AuthModule,
    UsersModule,
    TransactionsModule,
    PaymentsModule,
    InvoicesModule,
    PayoutsModule,
    WebhooksModule,
    DisputesModule,
    OtpModule,
    NotificationsModule,
    StorageModule,
    EvidenceModule,
    AuditModule,
    AdminModule,
    WaitlistModule,
    ChatModule,
    MerchantsModule,
    OutboundEventsModule,
    // ops
    HealthModule,
  ],
  providers: [
    // Global rate-limiting guard (opt out per-route with @SkipThrottle).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
