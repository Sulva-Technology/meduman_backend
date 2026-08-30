import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatPlatform, NotificationChannel, NotificationStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '@/prisma/prisma.service';
import { QueueService } from '@/modules/queue/queue.service';
import {
  INVOICE_DELIVERY_JOB,
  NOTIFICATION_QUEUE_TOKEN,
  OTP_NOTIFICATION_JOB,
  type InvoiceDeliveryJobData,
  type OtpNotificationJobData,
} from '@/modules/queue/queue.constants';
import {
  NOTIFICATION_SENDER,
  OTP_TEMPLATE_KEY,
  type NotificationSender,
} from './notification-sender';

/** Which notification channel a chat platform delivers on. */
const PLATFORM_CHANNEL: Record<ChatPlatform, NotificationChannel> = {
  [ChatPlatform.TELEGRAM]: NotificationChannel.TELEGRAM,
  [ChatPlatform.WHATSAPP]: NotificationChannel.WHATSAPP,
  [ChatPlatform.INSTAGRAM]: NotificationChannel.INSTAGRAM,
  [ChatPlatform.MESSENGER]: NotificationChannel.MESSENGER,
  [ChatPlatform.X]: NotificationChannel.IN_APP,
};

/**
 * Outbound notifications. For OTP: the producer (`enqueueOtpCode`) runs in the
 * HTTP request and only enqueues; the consumer (`deliverOtpCode`) runs in the
 * worker, resolves the recipient, sends via the pluggable transport, and records
 * a Notification row. The plaintext code lives only in the transient job — the
 * persisted row carries non-secret metadata only.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(NOTIFICATION_QUEUE_TOKEN)
    private readonly queue: Queue<OtpNotificationJobData | InvoiceDeliveryJobData>,
    @Inject(NOTIFICATION_SENDER) private readonly sender: NotificationSender,
    private readonly prisma: PrismaService,
    private readonly chatQueue: QueueService,
  ) {}

  /** The caller's own notifications, newest first (non-secret projection). */
  async listForUser(userId: string, status?: NotificationStatus) {
    return this.prisma.notification.findMany({
      where: { userId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        channel: true,
        templateKey: true,
        payload: true,
        status: true,
        readAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Mark one notification read. Ownership-scoped via `updateMany` so a
   * wrong-owner id is a silent no-op, never a cross-user write or existence leak.
   */
  async markRead(userId: string, id: string): Promise<{ ok: true }> {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  /** Enqueue delivery of an issued OTP code. jobId dedupes repeat sends. */
  async enqueueOtpCode(data: OtpNotificationJobData): Promise<void> {
    await this.queue.add(OTP_NOTIFICATION_JOB, data, {
      jobId: `otp:${data.otpId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      // Remove on completion so the plaintext code is not retained in Redis; cap
      // retained failures for the same reason.
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  /** Worker-side delivery: send the code and record the outcome (no plaintext). */
  async deliverOtpCode(data: OtpNotificationJobData): Promise<void> {
    const tx = await this.prisma.transaction.findUnique({
      where: { id: data.transactionId },
      include: { buyer: true },
    });
    if (!tx?.buyerId) {
      this.logger.warn(`OTP delivery skipped — no buyer on transaction ${data.transactionId}`);
      return;
    }

    // Prefer the buyer's chat surface (the whole point of the bot). The plaintext
    // code rides only the transient chat-outbound job — the persisted row keeps
    // non-secret metadata only, exactly like the SMS path.
    const chatIdentity = await this.prisma.chatIdentity.findFirst({
      where: { userId: tx.buyerId },
      orderBy: { createdAt: 'asc' },
    });
    if (chatIdentity) {
      const channel = PLATFORM_CHANNEL[chatIdentity.platform];
      await this.prisma.notification.create({
        data: {
          userId: tx.buyerId,
          channel,
          templateKey: OTP_TEMPLATE_KEY,
          payload: { transactionId: data.transactionId, otpId: data.otpId, purpose: data.purpose },
          status: NotificationStatus.SENT,
          sentAt: new Date(),
        },
      });
      await this.chatQueue.enqueueChatOutbound({
        userId: tx.buyerId,
        templateKey: OTP_TEMPLATE_KEY,
        data: { code: data.code, transactionId: data.transactionId },
      });
      return;
    }

    const channel = NotificationChannel.SMS;
    const notification = await this.prisma.notification.create({
      data: {
        userId: tx.buyerId,
        channel,
        templateKey: OTP_TEMPLATE_KEY,
        // NON-secret metadata only — never the code.
        payload: { transactionId: data.transactionId, otpId: data.otpId, purpose: data.purpose },
        status: NotificationStatus.PENDING,
      },
    });

    const to = tx.buyer?.phone;
    if (!to) {
      this.logger.warn(`OTP delivery failed — buyer ${tx.buyerId} has no phone`);
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { status: NotificationStatus.FAILED },
      });
      return; // Unroutable — a retry won't help.
    }

    try {
      await this.sender.send({
        channel,
        to,
        templateKey: OTP_TEMPLATE_KEY,
        data: { code: data.code, transactionId: data.transactionId },
      });
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { status: NotificationStatus.SENT, sentAt: new Date() },
      });
    } catch (err) {
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { status: NotificationStatus.FAILED },
      });
      throw err; // Let BullMQ retry a transient transport failure.
    }
  }

  /** Enqueue delivery of a sent invoice. jobId dedupes repeat sends. */
  async enqueueInvoice(data: InvoiceDeliveryJobData): Promise<void> {
    await this.queue.add(INVOICE_DELIVERY_JOB, data, {
      jobId: `invoice:${data.invoiceId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  /**
   * Worker-side invoice delivery. Prefers the buyer's chat surface when the
   * invoice is linked to a known chat user; otherwise emails the buyerEmail via
   * the pluggable sender. Records a Notification row only when a buyer user id is
   * known (the row requires a userId).
   */
  async deliverInvoice(data: InvoiceDeliveryJobData): Promise<void> {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: data.invoiceId } });
    if (!invoice) {
      this.logger.warn(`Invoice delivery skipped — ${data.invoiceId} not found`);
      return;
    }
    const payload = {
      invoiceId: invoice.id,
      number: invoice.number,
      total: invoice.total,
      publicViewId: invoice.publicViewId,
    };

    if (invoice.buyerId) {
      const chatIdentity = await this.prisma.chatIdentity.findFirst({
        where: { userId: invoice.buyerId },
        orderBy: { createdAt: 'asc' },
      });
      if (chatIdentity) {
        await this.chatQueue.enqueueChatOutbound({
          userId: invoice.buyerId,
          templateKey: 'invoice.sent',
          data: payload,
        });
        return;
      }
    }

    const to = invoice.buyerEmail;
    if (!to) {
      this.logger.warn(`Invoice ${invoice.id} has no deliverable contact — skipped`);
      return;
    }
    await this.sender.send({
      channel: NotificationChannel.EMAIL,
      to,
      templateKey: 'invoice.sent',
      data: payload,
    });
    if (invoice.buyerId) {
      await this.prisma.notification.create({
        data: {
          userId: invoice.buyerId,
          channel: NotificationChannel.EMAIL,
          templateKey: 'invoice.sent',
          payload,
          status: NotificationStatus.SENT,
          sentAt: new Date(),
        },
      });
    }
  }
}
