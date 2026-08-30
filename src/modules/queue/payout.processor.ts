import type { Job } from 'bullmq';
import type { PayoutsService } from '@/modules/payouts/payouts.service';
import { RELEASE_JOB, type ReleaseJobData } from './queue.constants';

/**
 * Build the BullMQ processor for the payout queue. Kept as a pure factory (no
 * Nest/Worker wiring) so the job→service routing is unit-testable. The worker
 * entrypoint instantiates the BullMQ Worker with this function.
 */
export function createPayoutProcessor(payouts: PayoutsService) {
  return async function process(job: Job<ReleaseJobData>): Promise<void> {
    if (job.name === RELEASE_JOB) {
      await payouts.executeRelease(job.data.transactionId);
    }
  };
}
