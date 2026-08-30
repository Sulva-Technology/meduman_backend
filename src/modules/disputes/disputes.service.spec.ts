import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ActorType, DisputeReason, DisputeStatus } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import type { TransactionsService } from '@/modules/transactions/transactions.service';
import type { QueueService } from '@/modules/queue/queue.service';
import { DisputesService } from './disputes.service';

function makeDeps(dispute: Record<string, unknown> | null = null, otherOpenCount = 0) {
  const prisma = {
    dispute: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'disp-1', status: DisputeStatus.OPEN, ...data }),
        ),
      findUnique: jest.fn().mockResolvedValue(dispute),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'disp-1', ...dispute, ...data }),
        ),
      count: jest.fn().mockResolvedValue(otherOpenCount),
    },
  };
  const transactions = { apply: jest.fn().mockResolvedValue({}) };
  const queue = { enqueueRelease: jest.fn().mockResolvedValue(undefined) };
  return {
    prisma: prisma as unknown as PrismaService,
    transactions: transactions as unknown as TransactionsService,
    queue: queue as unknown as QueueService,
    spies: { prisma, transactions, queue },
  };
}

describe('DisputesService.raise', () => {
  it('drives RAISE_DISPUTE through the machine, then records the OPEN dispute', async () => {
    const { prisma, transactions, queue, spies } = makeDeps();
    const service = new DisputesService(prisma, transactions, queue);

    const dispute = await service.raise({
      transactionId: 'tx-1',
      openedBy: 'user-1',
      role: 'BUYER',
      reason: DisputeReason.ITEM_NOT_RECEIVED,
      description: 'never arrived',
    });

    expect(spies.transactions.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx-1',
        event: { type: 'RAISE_DISPUTE' },
        actor: expect.objectContaining({ id: 'user-1', type: ActorType.USER, role: 'BUYER' }),
      }),
    );
    expect(spies.prisma.dispute.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          transactionId: 'tx-1',
          openedBy: 'user-1',
          reason: DisputeReason.ITEM_NOT_RECEIVED,
          status: DisputeStatus.OPEN,
        }),
      }),
    );
    expect(dispute.status).toBe(DisputeStatus.OPEN);
  });

  it('does not record a dispute if the state machine rejects the transition', async () => {
    const { prisma, transactions, queue, spies } = makeDeps();
    spies.transactions.apply.mockRejectedValue(new Error('illegal transition'));
    const service = new DisputesService(prisma, transactions, queue);

    await expect(
      service.raise({
        transactionId: 'tx-1',
        openedBy: 'user-1',
        reason: DisputeReason.FRAUD,
      }),
    ).rejects.toThrow('illegal transition');
    expect(spies.prisma.dispute.create).not.toHaveBeenCalled();
  });
});

describe('DisputesService.resolve', () => {
  const openDispute = {
    id: 'disp-1',
    transactionId: 'tx-1',
    status: DisputeStatus.OPEN,
  };

  it('resolves for the seller: enters release excluding this dispute, marks RESOLVED_RELEASE', async () => {
    const { prisma, transactions, queue, spies } = makeDeps(openDispute, 0);
    const service = new DisputesService(prisma, transactions, queue);

    await service.resolve({ disputeId: 'disp-1', resolvedBy: 'admin-1', outcome: 'RELEASE' });

    expect(spies.transactions.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx-1',
        event: { type: 'RESOLVE_DISPUTE_FOR_SELLER' },
        actor: expect.objectContaining({ type: ActorType.ADMIN }),
        context: { hasOpenDispute: false },
      }),
    );
    expect(spies.prisma.dispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'disp-1' },
        data: expect.objectContaining({
          status: DisputeStatus.RESOLVED_RELEASE,
          resolvedBy: 'admin-1',
        }),
      }),
    );
    // Seller-favour resolution enters RELEASE_PROCESSING → enqueue the payout.
    expect(spies.queue.enqueueRelease).toHaveBeenCalledWith('tx-1');
  });

  it('resolves for the buyer: drives refund, marks RESOLVED_REFUND', async () => {
    const { prisma, transactions, queue, spies } = makeDeps(openDispute, 0);
    const service = new DisputesService(prisma, transactions, queue);

    await service.resolve({ disputeId: 'disp-1', resolvedBy: 'admin-1', outcome: 'REFUND' });

    expect(spies.transactions.apply).toHaveBeenCalledWith(
      expect.objectContaining({ event: { type: 'RESOLVE_DISPUTE_FOR_BUYER' } }),
    );
    expect(spies.prisma.dispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: DisputeStatus.RESOLVED_REFUND }),
      }),
    );
    // Buyer-favour resolution refunds — nothing to release.
    expect(spies.queue.enqueueRelease).not.toHaveBeenCalled();
  });

  it('flags a still-open sibling dispute so release stays frozen', async () => {
    const { prisma, transactions, queue, spies } = makeDeps(openDispute, 1);
    const service = new DisputesService(prisma, transactions, queue);

    await service.resolve({ disputeId: 'disp-1', resolvedBy: 'admin-1', outcome: 'RELEASE' });

    expect(spies.transactions.apply).toHaveBeenCalledWith(
      expect.objectContaining({ context: { hasOpenDispute: true } }),
    );
  });

  it('throws NotFound for an unknown dispute', async () => {
    const { prisma, transactions, queue } = makeDeps(null);
    const service = new DisputesService(prisma, transactions, queue);

    await expect(
      service.resolve({ disputeId: 'nope', resolvedBy: 'admin-1', outcome: 'RELEASE' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to resolve an already-resolved dispute (never re-drives the machine)', async () => {
    const { prisma, transactions, queue, spies } = makeDeps({
      ...openDispute,
      status: DisputeStatus.RESOLVED_REFUND,
    });
    const service = new DisputesService(prisma, transactions, queue);

    await expect(
      service.resolve({ disputeId: 'disp-1', resolvedBy: 'admin-1', outcome: 'RELEASE' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(spies.transactions.apply).not.toHaveBeenCalled();
  });
});
