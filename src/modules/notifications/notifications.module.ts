import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NOTIFICATION_SENDER } from './notification-sender';
import { LogNotificationSender } from './log-notification.sender';
import { createNotificationSender } from './notification-sender.factory';

/**
 * Outbound notification delivery (OTP codes today). The transport is pluggable
 * via NOTIFICATION_SENDER: the WhatsApp Cloud API when its credential set is
 * complete, otherwise the log stub — so an unconfigured deploy still boots and
 * behaves as before. The notification Queue comes from the @Global QueueModule.
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    // Always constructed: it is both the default transport and the fallback for
    // messages WhatsApp has no approved template for (invoice email).
    LogNotificationSender,
    {
      provide: NOTIFICATION_SENDER,
      inject: [ConfigService, LogNotificationSender],
      useFactory: (config: ConfigService<Env, true>, fallback: LogNotificationSender) =>
        createNotificationSender(config, fallback),
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
