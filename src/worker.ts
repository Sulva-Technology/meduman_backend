import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger } from 'nestjs-pino';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { AppModule } from './app.module';
import type { Env } from './config/env.validation';
import { initSentry } from './observability/sentry';
import { PayoutsService } from './modules/payouts/payouts.service';
import { NotificationsService } from './modules/notifications/notifications.service';
import { createPayoutProcessor } from './modules/queue/payout.processor';
import { createNotificationProcessor } from './modules/notifications/notification.processor';
import { ChatInboundService } from './modules/chat/gateway/chat-inbound.service';
import { ChatOutboundService } from './modules/chat/outbound/chat-outbound.service';
import { createChatProcessor } from './modules/chat/chat.processor';
import { WebhookDeliveryService } from './modules/merchants/webhook-delivery.service';
import { createWebhookDeliveryProcessor } from './modules/merchants/webhook-delivery.processor';
import {
  CHAT_QUEUE,
  NOTIFICATION_QUEUE,
  PAYOUT_QUEUE,
  REDIS_CONNECTION,
  WEBHOOK_OUT_QUEUE,
} from './modules/queue/queue.constants';

/**
 * Background worker entrypoint (Render background worker). Runs the BullMQ
 * processors — currently the payout/release queue. NO HTTP server. Uses the
 * application context (DI available) without listening on a port.
 */
async function bootstrapWorker(): Promise<void> {
  initSentry({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV });
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));
  app.enableShutdownHooks();
  const logger = app.get(PinoLogger);

  const payouts = app.get(PayoutsService);
  const notifications = app.get(NotificationsService);
  const connection = app.get<Redis>(REDIS_CONNECTION);
  const config: ConfigService<Env, true> = app.get(ConfigService);
  const prefix = config.get('QUEUE_PREFIX', { infer: true });

  const worker = new Worker(PAYOUT_QUEUE, createPayoutProcessor(payouts), {
    connection,
    prefix,
    concurrency: 5,
  });

  worker.on('completed', (job) => logger.log(`release job ${job.id} completed`));
  worker.on('failed', (job, err) =>
    logger.error(`release job ${job?.id} failed: ${err.message}`, err.stack),
  );

  const notificationWorker = new Worker(
    NOTIFICATION_QUEUE,
    createNotificationProcessor(notifications),
    { connection, prefix, concurrency: 10 },
  );

  notificationWorker.on('failed', (job, err) =>
    logger.error(`notification job ${job?.id} failed: ${err.message}`, err.stack),
  );

  const chatInbound = app.get(ChatInboundService);
  const chatOutbound = app.get(ChatOutboundService);
  const chatWorker = new Worker(CHAT_QUEUE, createChatProcessor(chatInbound, chatOutbound), {
    connection,
    prefix,
    concurrency: 10,
  });

  chatWorker.on('failed', (job, err) =>
    logger.error(`chat job ${job?.id} failed: ${err.message}`, err.stack),
  );

  const webhookDelivery = app.get(WebhookDeliveryService);
  const webhookWorker = new Worker(
    WEBHOOK_OUT_QUEUE,
    createWebhookDeliveryProcessor(webhookDelivery),
    { connection, prefix, concurrency: 10 },
  );

  webhookWorker.on('failed', (job, err) =>
    logger.error(`webhook delivery job ${job?.id} failed: ${err.message}`, err.stack),
  );

  logger.log('Worker started — processing release + notification + chat + webhook-out queues');

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`${signal} received — draining worker`);
    await worker.close();
    await notificationWorker.close();
    await chatWorker.close();
    await webhookWorker.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrapWorker();
