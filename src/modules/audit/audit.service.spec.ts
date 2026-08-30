import { ActorType } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from './audit.service';

function makePrisma() {
  const create = jest.fn().mockResolvedValue({});
  const prisma = { auditLog: { create } } as unknown as PrismaService;
  return { prisma, create };
}

describe('AuditService.log', () => {
  it('appends a row with the given actor/action/target', async () => {
    const { prisma, create } = makePrisma();
    const service = new AuditService(prisma);

    await service.log({
      actorId: 'admin-1',
      actorType: ActorType.ADMIN,
      action: 'payout.release',
      targetType: 'Payout',
      targetId: 'po-1',
      reason: 'manual release',
      metadata: { amount: 125000 },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-1',
        actorType: ActorType.ADMIN,
        action: 'payout.release',
        targetType: 'Payout',
        targetId: 'po-1',
        reason: 'manual release',
        metadata: { amount: 125000 },
      }),
    });
  });

  it('defaults actor to SYSTEM and nulls optional fields for an automated event', async () => {
    const { prisma, create } = makePrisma();
    const service = new AuditService(prisma);

    await service.log({
      action: 'transaction.expired',
      targetType: 'Transaction',
      targetId: 'tx-9',
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: null,
        actorType: ActorType.SYSTEM,
        reason: null,
        targetId: 'tx-9',
      }),
    });
  });

  it('writes through a supplied transaction client so it joins the caller’s $transaction', async () => {
    const { prisma } = makePrisma();
    const txCreate = jest.fn().mockResolvedValue({});
    const txClient = { auditLog: { create: txCreate } };
    const service = new AuditService(prisma);

    await service.log({ action: 'x', targetType: 'Transaction' }, txClient);

    expect(txCreate).toHaveBeenCalledTimes(1);
  });
});
