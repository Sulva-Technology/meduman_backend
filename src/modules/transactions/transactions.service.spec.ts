import { ActorType } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '@/prisma/prisma.service';
import type { OutboundEventsService } from '@/modules/outbound-events/outbound-events.service';
import { TransactionsService } from './transactions.service';
import { TransitionRejectedError } from './transition-rejected.error';
import { RejectionReason } from './state-machine';

/** Stub outbound-events collaborator for specs that don't care about emission. */
const stubOutbound = {
  recordForTransition: () => Promise.resolve(null),
  dispatch: () => Promise.resolve(),
} as unknown as OutboundEventsService;

/**
 * A fake Prisma. `$transaction(cb)` runs the callback with a transactional `db`
 * whose write methods are jest mocks, so we can assert what got written — and,
 * critically, that NOTHING gets written when the machine rejects.
 */
function makePrisma(txRow: Record<string, unknown> | null) {
  const txClient = {
    transaction: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...txRow, status: 'LINK_ACTIVE' }),
    },
    timelineEvent: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    transaction: {
      findUnique: jest.fn().mockResolvedValue(txRow),
    },
    $transaction: jest.fn(async (cb: (db: typeof txClient) => Promise<unknown>) => cb(txClient)),
  };
  return { prisma: prisma as unknown as PrismaService, txClient, spies: prisma };
}

const draftRow = {
  id: 'tx-1',
  status: 'DRAFT',
  releaseRule: 'BUYER_CONFIRMATION',
  disputes: [],
};

const actor = { id: 'user-1', type: ActorType.USER, role: 'SELLER' };

describe('TransactionsService.apply — permitted transition', () => {
  it('writes status + timeline + audit inside a single Prisma transaction', async () => {
    const { prisma, txClient, spies } = makePrisma(draftRow);
    const service = new TransactionsService(prisma, stubOutbound);

    await service.apply({ transactionId: 'tx-1', event: { type: 'SELLER_PUBLISH' }, actor });

    expect(spies.$transaction).toHaveBeenCalledTimes(1);
    expect(txClient.transaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-1', status: 'DRAFT' },
      data: { status: 'LINK_ACTIVE' },
    });
    expect(txClient.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          transactionId: 'tx-1',
          oldState: 'DRAFT',
          newState: 'LINK_ACTIVE',
          actorId: 'user-1',
          actorRole: 'SELLER',
        }),
      }),
    );
    expect(txClient.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: 'user-1',
          actorType: ActorType.USER,
          action: 'transaction.status_change',
          targetType: 'Transaction',
          targetId: 'tx-1',
        }),
      }),
    );
  });

  it('guards against a concurrent transition — if updateMany hits 0 rows nothing else is written', async () => {
    const { prisma, txClient } = makePrisma(draftRow);
    txClient.transaction.updateMany.mockResolvedValue({ count: 0 });
    const service = new TransactionsService(prisma, stubOutbound);

    await expect(
      service.apply({ transactionId: 'tx-1', event: { type: 'SELLER_PUBLISH' }, actor }),
    ).rejects.toBeInstanceOf(TransitionRejectedError);

    expect(txClient.timelineEvent.create).not.toHaveBeenCalled();
    expect(txClient.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('TransactionsService.apply — rejected transition writes nothing', () => {
  it('throws TransitionRejectedError and never opens a Prisma transaction', async () => {
    const { prisma, spies } = makePrisma({ ...draftRow, status: 'COMPLETED' });
    const service = new TransactionsService(prisma, stubOutbound);

    await expect(
      service.apply({ transactionId: 'tx-1', event: { type: 'SELLER_PUBLISH' }, actor }),
    ).rejects.toMatchObject({ reason: RejectionReason.TERMINAL_STATE });

    expect(spies.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a client-sourced payment event without writing anything', async () => {
    const { prisma, spies } = makePrisma({ ...draftRow, status: 'PAYMENT_PENDING' });
    const service = new TransactionsService(prisma, stubOutbound);

    await expect(
      service.apply({
        transactionId: 'tx-1',
        event: { type: 'PAYMENT_VERIFIED', source: 'CLIENT' },
        actor,
      }),
    ).rejects.toMatchObject({ reason: RejectionReason.CLIENT_SOURCE_FORBIDDEN });

    expect(spies.$transaction).not.toHaveBeenCalled();
  });

  it('derives hasOpenDispute from loaded disputes and blocks release', async () => {
    const { prisma, spies } = makePrisma({
      id: 'tx-1',
      status: 'CONFIRMATION_PENDING',
      releaseRule: 'BUYER_CONFIRMATION',
      disputes: [{ status: 'OPEN' }],
    });
    const service = new TransactionsService(prisma, stubOutbound);

    await expect(
      service.apply({ transactionId: 'tx-1', event: { type: 'BUYER_CONFIRM' }, actor }),
    ).rejects.toMatchObject({ reason: RejectionReason.DISPUTE_OPEN });

    expect(spies.$transaction).not.toHaveBeenCalled();
  });
});

describe('TransactionsService.apply — missing transaction', () => {
  it('throws NotFoundException', async () => {
    const { prisma } = makePrisma(null);
    const service = new TransactionsService(prisma, stubOutbound);

    await expect(
      service.apply({ transactionId: 'nope', event: { type: 'SELLER_PUBLISH' }, actor }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TransactionsService merchant scoping', () => {
  it('createDraft persists merchantId when supplied', async () => {
    const create = jest.fn().mockResolvedValue({ id: 't1' });
    const prisma = { transaction: { create } } as unknown as PrismaService;
    const svc = new TransactionsService(prisma, stubOutbound);
    await svc.createDraft({ sellerId: 's1', title: 'x', amount: 1000, merchantId: 'm1' });
    expect(create.mock.calls[0][0].data.merchantId).toBe('m1');
  });

  it('getByIdForMerchant 404s a transaction owned by another merchant', async () => {
    const prisma = {
      transaction: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const svc = new TransactionsService(prisma, stubOutbound);
    await expect(svc.getByIdForMerchant('m1', 't1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listForMerchant filters by merchantId', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { transaction: { findMany } } as unknown as PrismaService;
    const svc = new TransactionsService(prisma, stubOutbound);
    await svc.listForMerchant('m1', {});
    expect(findMany.mock.calls[0][0].where).toMatchObject({ merchantId: 'm1' });
  });
});

describe('TransactionsService emits outbound events', () => {
  interface OutboundMock {
    recordForTransition: jest.Mock;
    dispatch: jest.Mock;
  }

  function build(outbound: OutboundMock, txRow: Record<string, unknown>) {
    const db = {
      transaction: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ...txRow, status: 'PAYMENT_PROTECTED' }),
      },
      timelineEvent: { create: jest.fn() },
      auditLog: { create: jest.fn() },
      outboundEvent: { create: jest.fn().mockResolvedValue({ id: 'ev1' }) },
    };
    const prisma = {
      transaction: { findUnique: jest.fn().mockResolvedValue({ ...txRow, disputes: [] }) },
      $transaction: jest.fn((fn: (txDb: typeof db) => Promise<unknown>) => fn(db)),
    } as unknown as PrismaService;
    return {
      svc: new TransactionsService(prisma, outbound as unknown as OutboundEventsService),
      db,
    };
  }

  it('records + dispatches an event for a merchant-owned PAYMENT_VERIFIED', async () => {
    const outbound: OutboundMock = {
      recordForTransition: jest.fn().mockResolvedValue('ev1'),
      dispatch: jest.fn().mockResolvedValue(undefined),
    };
    const txRow = {
      id: 't1',
      status: 'PAYMENT_PENDING',
      amount: 1000,
      currency: 'NGN',
      title: 'X',
      releaseRule: 'BUYER_CONFIRMATION',
      merchantId: 'm1',
    };
    const { svc } = build(outbound, txRow);
    await svc.apply({
      transactionId: 't1',
      event: { type: 'PAYMENT_VERIFIED', source: 'WEBHOOK' },
      actor: { type: ActorType.SYSTEM },
    });
    expect(outbound.recordForTransition).toHaveBeenCalled();
    expect(outbound.dispatch).toHaveBeenCalledWith('ev1');
  });

  it('does not dispatch when recordForTransition returns null (first-party/no map)', async () => {
    const outbound: OutboundMock = {
      recordForTransition: jest.fn().mockResolvedValue(null),
      dispatch: jest.fn(),
    };
    const txRow = {
      id: 't1',
      status: 'PAYMENT_PENDING',
      amount: 1000,
      currency: 'NGN',
      title: 'X',
      releaseRule: 'BUYER_CONFIRMATION',
      merchantId: null,
    };
    const { svc } = build(outbound, txRow);
    await svc.apply({
      transactionId: 't1',
      event: { type: 'PAYMENT_VERIFIED', source: 'WEBHOOK' },
      actor: { type: ActorType.SYSTEM },
    });
    expect(outbound.dispatch).not.toHaveBeenCalled();
  });
});
