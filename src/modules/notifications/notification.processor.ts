import type { Job } from 'bullmq';
import type { NotificationsService } from './notifications.service';
import {
  INVOICE_DELIVERY_JOB,
  OTP_NOTIFICATION_JOB,
  type InvoiceDeliveryJobData,
  type OtpNotificationJobData,
} from '@/modules/queue/queue.constants';

/**
 * Build the BullMQ processor for the notification queue. Pure factory (no
 * Nest/Worker wiring) so job→service routing is unit-testable. The worker
 * entrypoint instantiates the BullMQ Worker with this function.
 */
export function createNotificationProcessor(notifications: NotificationsService) {
  return async function process(
    job: Job<OtpNotificationJobData | InvoiceDeliveryJobData>,
  ): Promise<void> {
    if (job.name === OTP_NOTIFICATION_JOB) {
      await notifications.deliverOtpCode(job.data as OtpNotificationJobData);
    } else if (job.name === INVOICE_DELIVERY_JOB) {
      await notifications.deliverInvoice(job.data as InvoiceDeliveryJobData);
    }
  };
}
