import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { AppModule } from './app.module';
import type { Env } from './config/env.validation';
import { initSentry } from './observability/sentry';
import { buildCorsOptions } from './config/cors.config';
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
 * Optional in-process worker mode, enabled by `RUN_EMBEDDED_WORKER=true`.
 *
 * Starts the SAME four BullMQ Workers that `worker.ts` runs — payout/release,
 * notification, chat, webhook-out — with the same queue names, processor
 * functions and concurrency, but from the ALREADY-CREATED HTTP app context.
 * No second `NestFactory` context is created, so there is exactly one Prisma
 * pool, one shared Redis connection and one set of providers. `worker.ts` is
 * untouched and remains the standalone entrypoint for a real deployed worker.
 *
 * Turn this on ONLY when no separate worker service is running: two consumers on
 * the same queue both process jobs (each job still runs once — BullMQ hands a
 * job to a single worker — but the point of a dedicated worker is isolation from
 * HTTP traffic). Job idempotency (rule 4) makes an accidental overlap safe
 * against double-payment, not against duplicated side effects.
 *
 * Note on shutdown: `worker.ts` closes its Workers and then the app. Here Nest's
 * own shutdown hook (`app.enableShutdownHooks()`, already on for the HTTP server)
 * fires on the same signal and runs `QueueModule.onApplicationShutdown()`, which
 * closes the Queue producers and disconnects the shared Redis connection. Our
 * handler closes the Workers first as intended, but the two run concurrently, so
 * a long in-flight job can lose its connection mid-drain. Workers are stopped
 * gracefully; anything interrupted is re-delivered and must be idempotent.
 */
function startEmbeddedWorkers(app: INestApplication, logger: Logger): void {
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

  logger.log(
    'Embedded worker started — processing release + notification + chat + webhook-out queues in-process',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`${signal} received — draining embedded worker`);
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

/**
 * API web service entrypoint (Render web service).
 * Raw body is preserved for webhook signature verification.
 */
async function bootstrap(): Promise<void> {
  initSentry({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV });

  const app = await NestFactory.create(AppModule, {
    // Keep the raw request body so Paystack webhook HMAC can be verified.
    rawBody: true,
    // Buffer early logs until the pino logger is attached below.
    bufferLogs: true,
  });
  // Use pino as the application logger (structured JSON + redaction).
  app.useLogger(app.get(Logger));

  const config: ConfigService<Env, true> = app.get(ConfigService);
  const port = config.get('PORT', { infer: true });
  app.use(helmet());
  app.enableCors(
    buildCorsOptions(
      config.get('FRONTEND_ORIGIN', { infer: true }),
      config.get('NODE_ENV', { infer: true }),
    ),
  );
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();

  await app.listen(port);
  app.get(Logger).log(`API listening on :${port}`);

  if (config.get('RUN_EMBEDDED_WORKER', { infer: true })) {
    startEmbeddedWorkers(app, app.get(Logger));
  }
}

void bootstrap();
