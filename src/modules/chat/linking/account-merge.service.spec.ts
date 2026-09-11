import { Test } from '@nestjs/testing';
import { PrismaService } from '@/prisma/prisma.service';
import { AccountMergeService } from './account-merge.service';

const SOURCE = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';

describe('AccountMergeService guards', () => {
  let service: AccountMergeService;
  let prisma: {
    sellerProfile: { findUnique: jest.Mock };
    transaction: { findFirst: jest.Mock };
    invoice: { findFirst: jest.Mock };
    payout: { findFirst: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      sellerProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      transaction: { findFirst: jest.fn().mockResolvedValue(null) },
      invoice: { findFirst: jest.fn().mockResolvedValue(null) },
      payout: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [AccountMergeService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(AccountMergeService);
  });

  it('returns null when neither side owns a seller profile', async () => {
    await expect(service.detectCollision(SOURCE, TARGET)).resolves.toBeNull();
  });

  it('flags SELLER_PROFILE_CONFLICT when both sides own one', async () => {
    prisma.sellerProfile.findUnique.mockResolvedValue({ id: 'sp-1' });
    await expect(service.detectCollision(SOURCE, TARGET)).resolves.toBe('SELLER_PROFILE_CONFLICT');
  });

  it('allows the merge when only the source owns one', async () => {
    prisma.sellerProfile.findUnique
      .mockResolvedValueOnce({ id: 'sp-source' })
      .mockResolvedValueOnce(null);
    await expect(service.detectCollision(SOURCE, TARGET)).resolves.toBeNull();
  });

  it('flags SELF_TRANSACTION_CONFLICT when one would be both buyer and seller', async () => {
    prisma.transaction.findFirst.mockResolvedValue({ id: 'tx-1' });
    await expect(service.detectCollision(SOURCE, TARGET)).resolves.toBe(
      'SELF_TRANSACTION_CONFLICT',
    );
  });

  it('flags SELF_TRANSACTION_CONFLICT when the conflict is on an invoice', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 'inv-1' });
    await expect(service.detectCollision(SOURCE, TARGET)).resolves.toBe(
      'SELF_TRANSACTION_CONFLICT',
    );
  });

  it('treats a PENDING or PROCESSING payout as in flight', async () => {
    prisma.payout.findFirst.mockResolvedValue({ id: 'po-1' });
    await expect(service.hasInFlightPayout([SOURCE, TARGET])).resolves.toBe(true);
    const where = prisma.payout.findFirst.mock.calls[0][0].where;
    expect(where.status.in).toEqual(['PENDING', 'PROCESSING']);
  });

  it('is not in flight when every payout is terminal', async () => {
    prisma.payout.findFirst.mockResolvedValue(null);
    await expect(service.hasInFlightPayout([SOURCE, TARGET])).resolves.toBe(false);
  });
});
