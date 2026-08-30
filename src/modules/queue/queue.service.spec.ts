import type { Queue } from 'bullmq';
import { QueueService } from './queue.service';
import {
  CHAT_INBOUND_JOB,
  CHAT_OUTBOUND_JOB,
  RELEASE_JOB,
  WEBHOOK_DELIVER_JOB,
  type ChatInboundJobData,
  type ChatOutboundJobData,
  type ReleaseJobData,
  type WebhookDeliveryJobData,
} from './queue.constants';

function makeService() {
  const payoutAdd = jest.fn().mockResolvedValue({});
  const chatAdd = jest.fn().mockResolvedValue({});
  const webhookOutAdd = jest.fn().mockResolvedValue({});
  const service = new QueueService(
    { add: payoutAdd } as unknown as Queue<ReleaseJobData>,
    { add: chatAdd } as unknown as Queue<ChatInboundJobData | ChatOutboundJobData>,
    { add: webhookOutAdd } as unknown as Queue<WebhookDeliveryJobData>,
  );
  return { service, payoutAdd, chatAdd, webhookOutAdd };
}

describe('QueueService.enqueueRelease', () => {
  it('adds a release job whose jobId dedupes repeat enqueues for the same transaction', async () => {
    const { service, payoutAdd } = makeService();

    await service.enqueueRelease('tx-1');

    expect(payoutAdd).toHaveBeenCalledTimes(1);
    const [jobName, data, opts] = payoutAdd.mock.calls[0];
    expect(jobName).toBe(RELEASE_JOB);
    expect(data).toEqual({ transactionId: 'tx-1' });
    expect(opts).toEqual(
      expect.objectContaining({
        jobId: 'release:tx-1',
        attempts: expect.any(Number),
        backoff: expect.objectContaining({ type: 'exponential' }),
      }),
    );
  });

  it('retries more than once so a transient Paystack/DB blip does not strand a release', async () => {
    const { service, payoutAdd } = makeService();

    await service.enqueueRelease('tx-1');

    expect(payoutAdd.mock.calls[0][2].attempts).toBeGreaterThan(1);
  });
});

describe('QueueService chat queue', () => {
  it('enqueues an inbound message with a dedupe jobId on (platform, messageId)', async () => {
    const { service, chatAdd } = makeService();

    await service.enqueueChatInbound({
      platform: 'TELEGRAM',
      providerMessageId: 'msg:9',
      from: '555',
      text: '/help',
    });

    const [jobName, , opts] = chatAdd.mock.calls[0];
    expect(jobName).toBe(CHAT_INBOUND_JOB);
    expect(opts).toEqual(
      expect.objectContaining({ jobId: 'chat-in:TELEGRAM:msg:9', removeOnComplete: true }),
    );
  });

  it('enqueues a transient outbound push (removeOnComplete so an OTP code is not retained)', async () => {
    const { service, chatAdd } = makeService();

    await service.enqueueChatOutbound({
      userId: 'user-1',
      templateKey: 'otp.delivery_confirmation',
      data: { code: '123456' },
    });

    const [jobName, , opts] = chatAdd.mock.calls[0];
    expect(jobName).toBe(CHAT_OUTBOUND_JOB);
    expect(opts).toEqual(expect.objectContaining({ removeOnComplete: true }));
  });
});

describe('QueueService.enqueueWebhookDelivery', () => {
  it('adds a delivery job whose jobId dedupes repeat enqueues for the same event', async () => {
    const { service, webhookOutAdd } = makeService();

    await service.enqueueWebhookDelivery('evt-1');

    expect(webhookOutAdd).toHaveBeenCalledTimes(1);
    const [jobName, data, opts] = webhookOutAdd.mock.calls[0];
    expect(jobName).toBe(WEBHOOK_DELIVER_JOB);
    expect(data).toEqual({ eventId: 'evt-1' });
    expect(opts).toEqual(
      expect.objectContaining({
        jobId: 'webhook:evt-1',
        attempts: expect.any(Number),
        backoff: expect.objectContaining({ type: 'exponential' }),
        removeOnFail: false,
      }),
    );
  });
});
