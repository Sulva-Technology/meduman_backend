import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  CHAT_INBOUND_JOB,
  CHAT_OUTBOUND_JOB,
  CHAT_QUEUE_TOKEN,
  PAYOUT_QUEUE_TOKEN,
  RELEASE_JOB,
  WEBHOOK_DELIVER_JOB,
  WEBHOOK_OUT_QUEUE_TOKEN,
  type ChatInboundJobData,
  type ChatOutboundJobData,
  type ReleaseJobData,
  type WebhookDeliveryJobData,
} from './queue.constants';

/**
 * Producer side of the background queues. The only way release / chat work
 * leaves an HTTP request: callers enqueue, the worker executes. Long/retryable
 * work never runs inside a request.
 */
@Injectable()
export class QueueService {
  constructor(
    @Inject(PAYOUT_QUEUE_TOKEN) private readonly payoutQueue: Queue<ReleaseJobData>,
    @Inject(CHAT_QUEUE_TOKEN)
    private readonly chatQueue: Queue<ChatInboundJobData | ChatOutboundJobData>,
    @Inject(WEBHOOK_OUT_QUEUE_TOKEN)
    private readonly webhookOutQueue: Queue<WebhookDeliveryJobData>,
  ) {}

  /**
   * Enqueue the release for a transaction. The `jobId` is deterministic so BullMQ
   * dedupes repeat enqueues while a job is live — an extra idempotency layer on
   * top of the payout's unique idempotencyKey (money rule 4). Retries with
   * exponential backoff so a transient provider/DB blip doesn't strand a release.
   */
  async enqueueRelease(transactionId: string): Promise<void> {
    await this.payoutQueue.add(
      RELEASE_JOB,
      { transactionId },
      {
        jobId: `release:${transactionId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  /**
   * Enqueue a parsed inbound chat message for the dialog. `jobId` is the
   * (platform, providerMessageId) pair so a re-delivered webhook that slipped
   * past the DB dedupe is still collapsed to one run.
   */
  async enqueueChatInbound(data: ChatInboundJobData): Promise<void> {
    await this.chatQueue.add(CHAT_INBOUND_JOB, data, {
      jobId: `chat-in:${data.platform}:${data.providerMessageId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  /**
   * Enqueue an outbound push to a chat user. Transient (removeOnComplete) so a
   * plaintext OTP code carried in `data` is never retained in Redis.
   */
  async enqueueChatOutbound(data: ChatOutboundJobData): Promise<void> {
    await this.chatQueue.add(CHAT_OUTBOUND_JOB, data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  /** Enqueue delivery of one outbound event. jobId dedupes repeat enqueues of the
   *  same event; retries with backoff. removeOnFail keeps dead jobs for inspection. */
  async enqueueWebhookDelivery(eventId: string): Promise<void> {
    await this.webhookOutQueue.add(
      WEBHOOK_DELIVER_JOB,
      { eventId },
      {
        jobId: `webhook:${eventId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}
