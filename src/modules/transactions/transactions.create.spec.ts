import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '@/prisma/prisma.service';
import type { OutboundEventsService } from '@/modules/outbound-events/outbound-events.service';
import { TransactionsService } from './transactions.service';

const stubOutbound = {
  recordForTransition: () => Promise.resolve(null),
  dispatch: () => Promise.resolve(),
} as unknown as OutboundEventsService;

function makePrisma(existing: Record<string, unknown> | null = null) {
  const prisma = {
    transaction: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'tx-1', status: 'DRAFT', ...data }),
        ),
      findUnique: jest.fn().mockResolvedValue(existing),
    },
  };
  return { prisma: prisma as unknown as PrismaService, spy: prisma.transaction };
}

describe('TransactionsService.createDraft', () => {
  it('creates a DRAFT owned by the seller with an unguessable public link id and integer kobo amount', async () => {
    const { prisma, spy } = makePrisma();
    const service = new TransactionsService(prisma, stubOutbound);

    const tx = await service.createDraft({
      sellerId: 'seller-1',
      title: 'Sneakers',
      amount: 1500000,
    });

    const data = spy.create.mock.calls[0][0].data;
    expect(data.sellerId).toBe('seller-1');
    expect(data.title).toBe('Sneakers');
    expect(data.amount).toBe(1500000);
    expect(data.status).toBe('DRAFT');
    expect(typeof data.publicLinkId).toBe('string');
    expect((data.publicLinkId as string).length).toBeGreaterThanOrEqual(16);
    expect(tx.id).toBe('tx-1');
  });

  it('passes through release rule and fee model when provided', async () => {
    const { prisma, spy } = makePrisma();
    const service = new TransactionsService(prisma, stubOutbound);

    await service.createDraft({
      sellerId: 'seller-1',
      title: 'Service',
      amount: 500000,
      releaseRule: 'AUTO_AFTER_WINDOW',
      feeModel: 'SELLER_PAYS',
      feeAmount: 25000,
    });

    const data = spy.create.mock.calls[0][0].data;
    expect(data.releaseRule).toBe('AUTO_AFTER_WINDOW');
    expect(data.feeModel).toBe('SELLER_PAYS');
    expect(data.feeAmount).toBe(25000);
  });
});

describe('TransactionsService.getById', () => {
  it('returns the row when found', async () => {
    const { prisma } = makePrisma({ id: 'tx-1', sellerId: 'seller-1' });
    const service = new TransactionsService(prisma, stubOutbound);

    await expect(service.getById('tx-1')).resolves.toEqual(expect.objectContaining({ id: 'tx-1' }));
  });

  it('throws NotFound when missing', async () => {
    const { prisma } = makePrisma(null);
    const service = new TransactionsService(prisma, stubOutbound);

    await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
