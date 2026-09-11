import { Test } from '@nestjs/testing';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/modules/audit/audit.service';
import { AccountMergeService } from './account-merge.service';
import { LinkMergeCollisionError, LinkMergeInFlightError } from './linking.errors';

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
      providers: [
        AccountMergeService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
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

describe('AccountMergeService.merge', () => {
  // Uses a fake transaction client so the re-parenting contract is asserted
  // without a database. The e2e suite covers real persistence (Task 11).
  let service: AccountMergeService;
  let db: ReturnType<typeof makeTxClient>;
  let audit: { log: jest.Mock };

  function makeTxClient() {
    const updateMany = () => jest.fn().mockResolvedValue({ count: 2 });
    return {
      sellerProfile: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      transaction: { findFirst: jest.fn().mockResolvedValue(null), updateMany: updateMany() },
      invoice: { findFirst: jest.fn().mockResolvedValue(null), updateMany: updateMany() },
      payout: { findFirst: jest.fn().mockResolvedValue(null), updateMany: updateMany() },
      chatIdentity: { updateMany: updateMany() },
      notification: { updateMany: updateMany() },
      dispute: { updateMany: updateMany() },
      evidence: { updateMany: updateMany() },
      profile: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      user: {
        findUniqueOrThrow: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            roleFlags: where.id === 'src' ? ['SELLER'] : ['BUYER'],
            phone: where.id === 'src' ? '+2348000000000' : null,
          }),
        ),
        update: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
  }

  beforeEach(async () => {
    db = makeTxClient();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountMergeService,
        {
          provide: PrismaService,
          useValue: { $transaction: (fn: (c: unknown) => unknown) => fn(db) },
        },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(AccountMergeService);
  });

  it('re-parents identities, money rows, and functional participant refs', async () => {
    await service.merge('src', 'tgt');

    expect(db.chatIdentity.updateMany).toHaveBeenCalledWith({
      where: { userId: 'src' },
      data: { userId: 'tgt' },
    });
    expect(db.transaction.updateMany).toHaveBeenCalledWith({
      where: { sellerId: 'src' },
      data: { sellerId: 'tgt' },
    });
    expect(db.transaction.updateMany).toHaveBeenCalledWith({
      where: { buyerId: 'src' },
      data: { buyerId: 'tgt' },
    });
    expect(db.payout.updateMany).toHaveBeenCalledWith({
      where: { sellerId: 'src' },
      data: { sellerId: 'tgt' },
    });
    expect(db.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'src' },
      data: { userId: 'tgt' },
    });
    // Functional, not cosmetic: these back participant/ownership checks, so a
    // dispute raised in chat must stay visible to the merged account.
    expect(db.dispute.updateMany).toHaveBeenCalledWith({
      where: { openedBy: 'src' },
      data: { openedBy: 'tgt' },
    });
    expect(db.evidence.updateMany).toHaveBeenCalledWith({
      where: { uploadedBy: 'src' },
      data: { uploadedBy: 'tgt' },
    });
  });

  it('NEVER rewrites audit or timeline actors — rule 6 history is immutable', async () => {
    await service.merge('src', 'tgt');
    // The client exposes no timelineEvent model at all, so any attempt to rewrite
    // history would throw rather than silently pass.
    expect(db).not.toHaveProperty('timelineEvent');
    // The only audit interaction is ONE new row, written through AuditService with
    // the merge's own transaction client — never an update of existing history.
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledTimes(1);
    const [entry, client] = audit.log.mock.calls[0];
    expect(entry.action).toBe('chat.account_linked');
    expect(entry.metadata.sourceUserId).toBe('src');
    expect(client).toBe(db);
  });

  it('tombstones the absorbed account instead of deleting it', async () => {
    await service.merge('src', 'tgt');
    const tombstone = db.user.update.mock.calls.find(
      (c: [{ where: { id: string } }]) => c[0].where.id === 'src',
    );
    expect(tombstone[0].data).toEqual({
      status: 'DEACTIVATED',
      mergedIntoUserId: 'tgt',
      mergedAt: expect.any(Date),
    });
  });

  it('unions role flags and fills a missing phone without overwriting one', async () => {
    await service.merge('src', 'tgt');
    const survivor = db.user.update.mock.calls.find(
      (c: [{ where: { id: string } }]) => c[0].where.id === 'tgt',
    );
    expect(survivor[0].data.roleFlags.set.sort()).toEqual(['BUYER', 'SELLER']);
    expect(survivor[0].data.phone).toBe('+2348000000000');
  });

  it('moves the source profile when the target has none', async () => {
    db.profile.findUnique
      .mockResolvedValueOnce({ userId: 'src', city: 'Lagos' })
      .mockResolvedValueOnce(null);
    await service.merge('src', 'tgt');
    expect(db.profile.update).toHaveBeenCalledWith({
      where: { userId: 'src' },
      data: { userId: 'tgt' },
    });
  });

  it('merges profiles field-wise and deletes the source when both exist', async () => {
    db.profile.findUnique
      .mockResolvedValueOnce({ userId: 'src', city: 'Lagos', bio: 'from chat' })
      .mockResolvedValueOnce({ userId: 'tgt', city: 'Abuja', bio: null });
    await service.merge('src', 'tgt');
    // The survivor's own values always win; only its nulls are filled.
    expect(db.profile.update).toHaveBeenCalledWith({
      where: { userId: 'tgt' },
      data: expect.objectContaining({ city: 'Abuja', bio: 'from chat' }),
    });
    expect(db.profile.delete).toHaveBeenCalledWith({ where: { userId: 'src' } });
  });

  it('refuses and writes nothing on a hard collision', async () => {
    db.sellerProfile.findUnique.mockResolvedValue({ id: 'sp' });
    await expect(service.merge('src', 'tgt')).rejects.toThrow(LinkMergeCollisionError);
    expect(db.chatIdentity.updateMany).not.toHaveBeenCalled();
  });

  it('refuses without writing when a payout is in flight', async () => {
    db.payout.findFirst.mockResolvedValue({ id: 'po-1' });
    await expect(service.merge('src', 'tgt')).rejects.toThrow(LinkMergeInFlightError);
    expect(db.chatIdentity.updateMany).not.toHaveBeenCalled();
  });

  it('admits an admin-overridden SELLER_PROFILE_CONFLICT and merges', async () => {
    db.sellerProfile.findUnique.mockResolvedValue({ id: 'sp' });
    await expect(
      service.merge('src', 'tgt', { overrideCollision: 'SELLER_PROFILE_CONFLICT' }),
    ).resolves.toBeDefined();
    expect(db.chatIdentity.updateMany).toHaveBeenCalled();
  });

  it('NEVER lets an override admit a SELF_TRANSACTION_CONFLICT', async () => {
    db.transaction.findFirst.mockResolvedValue({ id: 'tx-1' });
    await expect(
      service.merge('src', 'tgt', { overrideCollision: 'SELLER_PROFILE_CONFLICT' }),
    ).rejects.toThrow(LinkMergeCollisionError);
    expect(db.chatIdentity.updateMany).not.toHaveBeenCalled();
  });
});
