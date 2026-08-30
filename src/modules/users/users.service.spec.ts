import { BadRequestException } from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { UsersService } from './users.service';

/**
 * Fake Prisma exposing only `user.upsert`. The mirror is created on first
 * request and updated on later ones — a single upsert covers both, so the
 * tests assert on the exact args passed to it.
 */
function makePrisma() {
  const prisma = {
    user: {
      upsert: jest
        .fn()
        .mockImplementation(({ create }: { create: Record<string, unknown> }) =>
          Promise.resolve({ status: UserStatus.ACTIVE, roleFlags: [], ...create }),
        ),
    },
  };
  return { prisma: prisma as unknown as PrismaService, spy: prisma.user.upsert };
}

const sellerClaims: SupabaseJwtClaims = {
  sub: '11111111-1111-1111-1111-111111111111',
  email: 'seller@example.com',
  phone: '+2348000000000',
  role: 'authenticated',
  appRole: 'SELLER',
  raw: { sub: '11111111-1111-1111-1111-111111111111', user_metadata: { full_name: 'Ada Seller' } },
};

describe('UsersService.syncFromClaims', () => {
  it('creates the mirror keyed by the Supabase subject with claim identity fields', async () => {
    const { prisma, spy } = makePrisma();
    const service = new UsersService(prisma);

    await service.syncFromClaims(sellerClaims);

    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0];
    expect(arg.where).toEqual({ id: sellerClaims.sub });
    expect(arg.create).toEqual(
      expect.objectContaining({
        id: sellerClaims.sub,
        email: 'seller@example.com',
        phone: '+2348000000000',
        fullName: 'Ada Seller',
        roleFlags: [UserRole.SELLER],
      }),
    );
  });

  it('keeps email/phone/fullName in sync on update but never overwrites server-owned roleFlags or status', async () => {
    const { prisma, spy } = makePrisma();
    const service = new UsersService(prisma);

    await service.syncFromClaims(sellerClaims);

    const arg = spy.mock.calls[0][0];
    expect(arg.update).toEqual(
      expect.objectContaining({
        email: 'seller@example.com',
        phone: '+2348000000000',
        fullName: 'Ada Seller',
      }),
    );
    expect(arg.update).not.toHaveProperty('roleFlags');
    expect(arg.update).not.toHaveProperty('status');
  });

  it('maps an unknown/absent app role to no role flags on create', async () => {
    const { prisma, spy } = makePrisma();
    const service = new UsersService(prisma);

    await service.syncFromClaims({ ...sellerClaims, appRole: 'ADMIN' });

    expect(spy.mock.calls[0][0].create.roleFlags).toEqual([]);
  });

  it('omits fullName entirely when no name claim is present (never nulls an existing name)', async () => {
    const { prisma, spy } = makePrisma();
    const service = new UsersService(prisma);

    await service.syncFromClaims({ ...sellerClaims, raw: { sub: sellerClaims.sub } });

    expect(spy.mock.calls[0][0].create).not.toHaveProperty('fullName');
    expect(spy.mock.calls[0][0].update).not.toHaveProperty('fullName');
  });

  it('rejects a subject with no email — the mirror requires a unique email', async () => {
    const { prisma, spy } = makePrisma();
    const service = new UsersService(prisma);

    const { email: _email, ...noEmailClaims } = sellerClaims;
    await expect(service.syncFromClaims(noEmailClaims)).rejects.toBeInstanceOf(BadRequestException);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns the upserted user row', async () => {
    const { prisma } = makePrisma();
    const service = new UsersService(prisma);

    const user = await service.syncFromClaims(sellerClaims);

    expect(user).toEqual(expect.objectContaining({ id: sellerClaims.sub }));
  });
});
