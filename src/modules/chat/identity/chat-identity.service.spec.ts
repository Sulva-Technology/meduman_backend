import { ChatPlatform } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import type { AuditService } from '@/modules/audit/audit.service';
import { ChatIdentityService } from './chat-identity.service';
import type { SupabaseAdminAuthClient } from './supabase-admin';

function makeConfig() {
  return { get: () => 'chat.meduman.test' } as never;
}

function makeDeps(opts: { existing?: unknown; createRaces?: boolean } = {}) {
  const identityFindUnique = jest.fn().mockResolvedValue(opts.existing ?? null);
  const userUpsert = jest.fn().mockResolvedValue({ id: 'auth-1' });
  const identityCreate = jest.fn();
  if (opts.createRaces) {
    identityCreate.mockRejectedValue({ code: 'P2002' });
  } else {
    identityCreate.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'ci-1', ...data, user: { id: data.userId } }),
    );
  }

  const $transaction = jest
    .fn()
    .mockImplementation((fn: (db: unknown) => unknown) =>
      fn({ user: { upsert: userUpsert }, chatIdentity: { create: identityCreate } }),
    );

  const prisma = {
    chatIdentity: { findUnique: identityFindUnique },
    $transaction,
  } as unknown as PrismaService;

  const createUser = jest.fn().mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
  const supabase = {
    auth: { admin: { createUser } },
  } as unknown as SupabaseAdminAuthClient;

  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;

  const service = new ChatIdentityService(prisma, makeConfig(), audit, supabase);
  return { service, identityFindUnique, identityCreate, createUser };
}

describe('ChatIdentityService.resolveOrCreate', () => {
  it('mints exactly one auth user and one identity on first contact', async () => {
    const { service, createUser, identityCreate } = makeDeps();

    const result = await service.resolveOrCreate(ChatPlatform.TELEGRAM, '999', 'Ada');

    expect(createUser).toHaveBeenCalledTimes(1);
    expect(identityCreate).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(true);
    // Synthetic email is deterministic and platform-scoped.
    const email = createUser.mock.calls[0][0].email;
    expect(email).toBe('chat+telegram-999@chat.meduman.test');
  });

  it('returns the existing identity without minting a new auth user', async () => {
    const { service, createUser } = makeDeps({
      existing: { id: 'ci-1', user: { id: 'auth-1' } },
    });

    const result = await service.resolveOrCreate(ChatPlatform.TELEGRAM, '999');

    expect(createUser).not.toHaveBeenCalled();
    expect(result.created).toBe(false);
  });

  it('adopts the race winner when a concurrent first contact collides (P2002)', async () => {
    const { service } = makeDeps({ createRaces: true });
    // First lookup returns null (before create), post-collision lookup returns winner.
    (
      service as unknown as { prisma: { chatIdentity: { findUnique: jest.Mock } } }
    ).prisma.chatIdentity.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'ci-winner', user: { id: 'auth-winner' } });

    const result = await service.resolveOrCreate(ChatPlatform.TELEGRAM, '999');

    expect(result.created).toBe(false);
    expect(result.identity.id).toBe('ci-winner');
  });
});
