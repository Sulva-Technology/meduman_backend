import { NotificationStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { PrismaService } from '@/prisma/prisma.service';
import type { QueueService } from '@/modules/queue/queue.service';
import type { NotificationSender } from './notification-sender';
import { NotificationsService } from './notifications.service';
import {
  OTP_NOTIFICATION_JOB,
  type InvoiceDeliveryJobData,
  type OtpNotificationJobData,
} from '@/modules/queue/queue.constants';

const JOB: OtpNotificationJobData = {
  transactionId: 'tx-1',
  otpId: 'otp-1',
  code: '123456',
  purpose: 'DELIVERY_CONFIRMATION',
};

function makeDeps(opts: { buyerPhone?: string | null; chatIdentity?: unknown } = {}) {
  const add = jest.fn().mockResolvedValue({});
  const queue = { add } as unknown as Queue<OtpNotificationJobData | InvoiceDeliveryJobData>;

  const send = jest.fn().mockResolvedValue(undefined);
  const sender = { send } as unknown as NotificationSender;

  const txFindUnique = jest.fn().mockResolvedValue({
    id: 'tx-1',
    buyerId: 'buyer-1',
    buyer: {
      id: 'buyer-1',
      phone: opts.buyerPhone === undefined ? '+2348012345678' : opts.buyerPhone,
    },
  });
  const notificationCreate = jest
    .fn()
    .mockImplementation(({ data }) => Promise.resolve({ id: 'ntf-1', ...data }));
  const notificationUpdate = jest.fn().mockResolvedValue({});
  const chatIdentityFindFirst = jest.fn().mockResolvedValue(opts.chatIdentity ?? null);

  const prisma = {
    transaction: { findUnique: txFindUnique },
    notification: { create: notificationCreate, update: notificationUpdate },
    chatIdentity: { findFirst: chatIdentityFindFirst },
  } as unknown as PrismaService;

  const enqueueChatOutbound = jest.fn().mockResolvedValue(undefined);
  const chatQueue = { enqueueChatOutbound } as unknown as QueueService;

  const service = new NotificationsService(queue, sender, prisma, chatQueue);
  return { service, add, send, notificationCreate, notificationUpdate, enqueueChatOutbound };
}

describe('NotificationsService.enqueueOtpCode', () => {
  it('enqueues the code on a dedupe jobId and does not retain it after completion', async () => {
    const { service, add } = makeDeps();

    await service.enqueueOtpCode(JOB);

    expect(add).toHaveBeenCalledWith(
      OTP_NOTIFICATION_JOB,
      JOB,
      expect.objectContaining({ jobId: 'otp:otp-1', removeOnComplete: true }),
    );
  });
});

describe('NotificationsService.deliverOtpCode', () => {
  it('sends the code to the buyer and records a Notification row WITHOUT the plaintext', async () => {
    const { service, send, notificationCreate, notificationUpdate } = makeDeps();

    await service.deliverOtpCode(JOB);

    // The transport receives the code...
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '+2348012345678',
        data: expect.objectContaining({ code: '123456' }),
      }),
    );
    // ...but the persisted row never contains it.
    const created = notificationCreate.mock.calls[0][0].data;
    expect(JSON.stringify(created)).not.toContain('123456');
    expect(notificationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: NotificationStatus.SENT }),
      }),
    );
  });

  it('routes the code to the buyer chat surface (not SMS) when a ChatIdentity exists', async () => {
    const { service, send, enqueueChatOutbound, notificationCreate } = makeDeps({
      chatIdentity: { id: 'ci-1', platform: 'TELEGRAM', platformUserId: '999' },
    });

    await service.deliverOtpCode(JOB);

    // Chat path taken: enqueued to the chat queue, SMS transport untouched.
    expect(send).not.toHaveBeenCalled();
    expect(enqueueChatOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'buyer-1',
        templateKey: 'otp.delivery_confirmation',
        data: expect.objectContaining({ code: '123456' }),
      }),
    );
    // The persisted row still carries no plaintext code.
    const created = notificationCreate.mock.calls[0][0].data;
    expect(JSON.stringify(created)).not.toContain('123456');
    expect(created.channel).toBe('TELEGRAM');
  });

  it('marks the notification FAILED and does not throw when the buyer has no phone', async () => {
    const { service, send, notificationUpdate } = makeDeps({ buyerPhone: null });

    await expect(service.deliverOtpCode(JOB)).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(notificationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: NotificationStatus.FAILED }),
      }),
    );
  });

  it('marks FAILED and rethrows when the transport fails, so the job retries', async () => {
    const { service, send, notificationUpdate } = makeDeps();
    send.mockRejectedValueOnce(new Error('provider down'));

    await expect(service.deliverOtpCode(JOB)).rejects.toThrow('provider down');

    expect(notificationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: NotificationStatus.FAILED }),
      }),
    );
  });
});
