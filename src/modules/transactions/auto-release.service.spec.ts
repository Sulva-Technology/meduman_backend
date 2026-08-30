import type { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import type { PrismaService } from '@/prisma/prisma.service';
import type { QueueService } from '@/modules/queue/queue.service';
import { AutoReleaseService } from './auto-release.service';
import type { TransactionsService } from './transactions.service';

const HOURS = 72;
const now = new Date('2026-07-29T12:00:00Z');
const longAgo = new Date('2026-07-25T12:00:00Z'); // > 72h before now
const recent = new Date('2026-07-29T06:00:00Z'); // 6h before now

function makeDeps(candidates: Array<Record<string, unknown>>) {
  const prisma = {
    transaction: { findMany: jest.fn().mockResolvedValue(candidates) },
  };
  const transactions = { apply: jest.fn().mockResolvedValue({}) };
  const queue = { enqueueRelease: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: () => HOURS,
  } as unknown as ConfigService<Env, true>;
  return {
    service: new AutoReleaseService(
      prisma as unknown as PrismaService,
      transactions as unknown as TransactionsService,
      queue as unknown as QueueService,
      config,
    ),
    spies: { prisma, transactions, queue },
  };
}

const candidate = (id: string, enteredAt: Date) => ({
  id,
  status: 'CONFIRMATION_PENDING',
  releaseRule: 'AUTO_AFTER_WINDOW',
  timeline: [{ createdAt: enteredAt, newState: 'CONFIRMATION_PENDING' }],
});

describe('AutoReleaseService.scanAndRelease', () => {
  it('auto-confirms and enqueues release for a transaction past its window', async () => {
    const { service, spies } = makeDeps([candidate('tx-1', longAgo)]);

    const result = await service.scanAndRelease(now);

    expect(spies.transactions.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx-1',
        event: { type: 'AUTO_CONFIRM' },
        context: { autoConfirmWindowElapsed: true },
      }),
    );
    expect(spies.queue.enqueueRelease).toHaveBeenCalledWith('tx-1');
    expect(result.released).toBe(1);
  });

  it('leaves a transaction still inside its window untouched', async () => {
    const { service, spies } = makeDeps([candidate('tx-1', recent)]);

    const result = await service.scanAndRelease(now);

    expect(spies.transactions.apply).not.toHaveBeenCalled();
    expect(spies.queue.enqueueRelease).not.toHaveBeenCalled();
    expect(result.released).toBe(0);
  });

  it('skips a transaction with no recorded CONFIRMATION_PENDING entry', async () => {
    const { service, spies } = makeDeps([
      {
        id: 'tx-1',
        status: 'CONFIRMATION_PENDING',
        releaseRule: 'AUTO_AFTER_WINDOW',
        timeline: [],
      },
    ]);

    await service.scanAndRelease(now);

    expect(spies.transactions.apply).not.toHaveBeenCalled();
  });

  it('does not enqueue a release when the transition is refused (e.g. dispute open), and keeps scanning', async () => {
    const { service, spies } = makeDeps([candidate('tx-1', longAgo), candidate('tx-2', longAgo)]);
    spies.transactions.apply
      .mockRejectedValueOnce(new Error('dispute open'))
      .mockResolvedValueOnce({});

    const result = await service.scanAndRelease(now);

    expect(spies.queue.enqueueRelease).toHaveBeenCalledTimes(1);
    expect(spies.queue.enqueueRelease).toHaveBeenCalledWith('tx-2');
    expect(result.released).toBe(1);
  });
});
