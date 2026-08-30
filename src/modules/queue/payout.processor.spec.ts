import type { PayoutsService } from '@/modules/payouts/payouts.service';
import { createPayoutProcessor } from './payout.processor';
import { RELEASE_JOB } from './queue.constants';

describe('createPayoutProcessor', () => {
  it('routes a release job to the idempotent executeRelease', async () => {
    const payouts = { executeRelease: jest.fn().mockResolvedValue({}) };
    const processor = createPayoutProcessor(payouts as unknown as PayoutsService);

    await processor({ name: RELEASE_JOB, data: { transactionId: 'tx-1' } } as never);

    expect(payouts.executeRelease).toHaveBeenCalledWith('tx-1');
  });

  it('ignores unknown job names without touching payouts', async () => {
    const payouts = { executeRelease: jest.fn() };
    const processor = createPayoutProcessor(payouts as unknown as PayoutsService);

    await processor({ name: 'something-else', data: {} } as never);

    expect(payouts.executeRelease).not.toHaveBeenCalled();
  });
});
