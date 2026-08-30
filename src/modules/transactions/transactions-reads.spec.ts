import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '@/prisma/prisma.service';
import type { OutboundEventsService } from '@/modules/outbound-events/outbound-events.service';
import { TransactionsService } from './transactions.service';

const stubOutbound = {
  recordForTransition: () => Promise.resolve(null),
  dispatch: () => Promise.resolve(),
} as unknown as OutboundEventsService;

/**
 * Read-side money-safety tests: the public pay-page projection must not leak and
 * must be gated by status; the dashboard list must always scope to the caller.
 */

const publicRow = {
  publicLinkId: 'abc123',
  title: 'Nike Air',
  description: 'Size 42',
  amount: 5_000_00,
  currency: 'NGN',
  feeModel: 'BUYER_PAYS',
  feeAmount: 250_00,
  status: 'LINK_ACTIVE',
  // Fields that MUST NOT appear in the public projection:
  id: 'tx-uuid',
  buyerId: 'buyer-uuid',
  sellerId: 'seller-uuid',
  seller: {
    fullName: 'Ada Seller',
    sellerProfile: {
      businessName: 'Ada Store',
      trustLevel: 'TRUSTED',
      verificationStatus: 'VERIFIED',
    },
  },
};

function prismaWith(overrides: Record<string, unknown>): TransactionsService {
  const prisma = {
    transaction: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      ...overrides,
    },
  };
  return new TransactionsService(prisma as unknown as PrismaService, stubOutbound);
}

describe('TransactionsService.getPublicByLinkId', () => {
  it('returns only the allow-listed projection (no ids, no buyer)', async () => {
    const service = prismaWith({ findUnique: jest.fn().mockResolvedValue(publicRow) });

    const view = await service.getPublicByLinkId('abc123');

    expect(view).toEqual({
      publicLinkId: 'abc123',
      title: 'Nike Air',
      description: 'Size 42',
      amount: 5_000_00,
      currency: 'NGN',
      feeModel: 'BUYER_PAYS',
      feeAmount: 250_00,
      status: 'LINK_ACTIVE',
      seller: { displayName: 'Ada Store', trustLevel: 'TRUSTED', verified: true },
    });
    // Explicitly assert the sensitive fields did not leak through.
    const asRecord = view as unknown as Record<string, unknown>;
    expect(asRecord).not.toHaveProperty('id');
    expect(asRecord).not.toHaveProperty('buyerId');
    expect(asRecord).not.toHaveProperty('sellerId');
  });

  it('404s for a transaction not in a payable status (no info leak)', async () => {
    const service = prismaWith({
      findUnique: jest.fn().mockResolvedValue({ ...publicRow, status: 'PAYMENT_PROTECTED' }),
    });

    await expect(service.getPublicByLinkId('abc123')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s for an unknown link', async () => {
    const service = prismaWith({ findUnique: jest.fn().mockResolvedValue(null) });
    await expect(service.getPublicByLinkId('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TransactionsService.listForUser', () => {
  it('scopes a buyer view to their buyerId', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = prismaWith({ findMany });

    await service.listForUser('me-uuid', { role: 'buyer' });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { buyerId: 'me-uuid' } }),
    );
  });

  it('scopes a seller view to their sellerId and applies the status filter', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = prismaWith({ findMany });

    await service.listForUser('me-uuid', { role: 'seller', status: 'COMPLETED' });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sellerId: 'me-uuid', status: 'COMPLETED' } }),
    );
  });

  it('emits a nextCursor only when a full extra page row is fetched', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: `tx-${i}` }));
    const service = prismaWith({ findMany: jest.fn().mockResolvedValue(rows) });

    const page = await service.listForUser('me-uuid', { role: 'buyer', limit: 20 });

    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe('tx-19');
  });
});
