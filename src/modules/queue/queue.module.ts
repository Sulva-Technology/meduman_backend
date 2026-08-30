import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Env } from '@/config/env.validation';
import { QueueService } from './queue.service';
import {
  CHAT_QUEUE,
  CHAT_QUEUE_TOKEN,
  NOTIFICATION_QUEUE,
  NOTIFICATION_QUEUE_TOKEN,
  PAYOUT_QUEUE,
  PAYOUT_QUEUE_TOKEN,
  REDIS_CONNECTION,
  WEBHOOK_OUT_QUEUE,
  WEBHOOK_OUT_QUEUE_TOKEN,
} from './queue.constants';

/**
 * Central BullMQ registration + shared Redis connection. Global so any module
 * can inject QueueService to enqueue. The same connection factory is used by the
 * worker entrypoint (worker.ts) to run the processors. Retryable work runs here,
 * never inside an HTTP request.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Redis(config.get('REDIS_URL', { infer: true }), {
          // BullMQ requires this to be null on the connection it uses.
          maxRetriesPerRequest: null,
          ...(config.get('REDIS_TLS', { infer: true }) ? { tls: {} } : {}),
        }),
    },
    {
      provide: PAYOUT_QUEUE_TOKEN,
      inject: [REDIS_CONNECTION, ConfigService],
      useFactory: (connection: Redis, config: ConfigService<Env, true>) =>
        new Queue(PAYOUT_QUEUE, {
          connection,
          prefix: config.get('QUEUE_PREFIX', { infer: true }),
        }),
    },
    {
      provide: NOTIFICATION_QUEUE_TOKEN,
      inject: [REDIS_CONNECTION, ConfigService],
      useFactory: (connection: Redis, config: ConfigService<Env, true>) =>
        new Queue(NOTIFICATION_QUEUE, {
          connection,
          prefix: config.get('QUEUE_PREFIX', { infer: true }),
        }),
    },
    {
      provide: CHAT_QUEUE_TOKEN,
      inject: [REDIS_CONNECTION, ConfigService],
      useFactory: (connection: Redis, config: ConfigService<Env, true>) =>
        new Queue(CHAT_QUEUE, {
          connection,
          prefix: config.get('QUEUE_PREFIX', { infer: true }),
        }),
    },
    {
      provide: WEBHOOK_OUT_QUEUE_TOKEN,
      inject: [REDIS_CONNECTION, ConfigService],
      useFactory: (connection: Redis, config: ConfigService<Env, true>) =>
        new Queue(WEBHOOK_OUT_QUEUE, {
          connection,
          prefix: config.get('QUEUE_PREFIX', { infer: true }),
        }),
    },
    QueueService,
  ],
  exports: [
    QueueService,
    PAYOUT_QUEUE_TOKEN,
    NOTIFICATION_QUEUE_TOKEN,
    CHAT_QUEUE_TOKEN,
    WEBHOOK_OUT_QUEUE_TOKEN,
    REDIS_CONNECTION,
  ],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(
    @Inject(PAYOUT_QUEUE_TOKEN) private readonly payoutQueue: Queue,
    @Inject(NOTIFICATION_QUEUE_TOKEN) private readonly notificationQueue: Queue,
    @Inject(CHAT_QUEUE_TOKEN) private readonly chatQueue: Queue,
    @Inject(WEBHOOK_OUT_QUEUE_TOKEN) private readonly webhookOutQueue: Queue,
    @Inject(REDIS_CONNECTION) private readonly connection: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.payoutQueue.close();
    await this.notificationQueue.close();
    await this.chatQueue.close();
    await this.webhookOutQueue.close();
    this.connection.disconnect();
  }
}
