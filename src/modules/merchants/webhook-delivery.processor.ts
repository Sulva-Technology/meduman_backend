import type { Job } from 'bullmq';
import type { WebhookDeliveryJobData } from '@/modules/queue/queue.constants';
import type { WebhookDeliveryService } from './webhook-delivery.service';

/**
 * Build the BullMQ processor for the outbound-webhook queue. Kept as a pure
 * factory (no Nest/Worker wiring) so the job→service routing is unit-testable,
 * mirroring `createPayoutProcessor`.
 */
export function createWebhookDeliveryProcessor(svc: WebhookDeliveryService) {
  return async (job: Job<WebhookDeliveryJobData>): Promise<void> => {
    await svc.deliver(job.data.eventId);
  };
}
