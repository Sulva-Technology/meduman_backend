import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/modules/audit/audit.service';
import { AccountMergeService } from './account-merge.service';
import { ChatLinkService } from './chat-link.service';
import { hashLinkCode } from './chat-link.crypto';
import { LinkMergeCollisionError, LinkMergeInFlightError } from './linking.errors';

const SECRET = 'test-chat-link-hash-secret-0123456789abcdef';
const USER = '22222222-2222-2222-2222-222222222222';

const config = {
  get: (key: string) => {
    const map: Record<string, unknown> = {
      CHAT_LINK_HASH_SECRET: SECRET,
      CHAT_LINK_CODE_LENGTH: 8,
      CHAT_LINK_CODE_TTL_SECONDS: 600,
      CHAT_LINK_MAX_ATTEMPTS: 5,
    };
    return map[key];
  },
};

describe('ChatLinkService.mint', () => {
  let service: ChatLinkService;
  let prisma: {
    chatLinkRequest: { updateMany: jest.Mock; create: jest.Mock };
  };
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    prisma = {
      chatLinkRequest: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'req-1', ...data }),
        ),
      },
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatLinkService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: AuditService, useValue: audit },
        { provide: AccountMergeService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(ChatLinkService);
  });

  it('stores only the keyed hash, never the plaintext', async () => {
    const { code } = await service.mint(USER);
    const stored = prisma.chatLinkRequest.create.mock.calls[0][0].data;
    expect(stored.codeHash).toBe(hashLinkCode(code, SECRET));
    expect(JSON.stringify(stored)).not.toContain(code);
  });

  it('supersedes any earlier pending code so only one is live', async () => {
    await service.mint(USER);
    expect(prisma.chatLinkRequest.updateMany).toHaveBeenCalledWith({
      where: { targetUserId: USER, status: 'PENDING' },
      data: { status: 'CANCELLED', resolvedAt: expect.any(Date) },
    });
  });

  it('expires the code after the configured TTL', async () => {
    const { expiresAt } = await service.mint(USER);
    const deltaMs = expiresAt.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(590_000);
    expect(deltaMs).toBeLessThanOrEqual(600_000);
  });

  it('audits the mint without the plaintext', async () => {
    const { code } = await service.mint(USER);
    const entry = audit.log.mock.calls[0][0];
    expect(entry.action).toBe('chat.link_code_minted');
    expect(JSON.stringify(entry)).not.toContain(code);
  });
});

const IDENTITY = { id: 'id-1', userId: 'src-user', platform: 'TELEGRAM', platformUserId: '555' };

describe('ChatLinkService.consume', () => {
  let service: ChatLinkService;
  let prisma: { chatLinkRequest: { update: jest.Mock; findUnique: jest.Mock } };
  let merge: {
    detectCollision: jest.Mock;
    hasInFlightPayout: jest.Mock;
    merge: jest.Mock;
  };
  let audit: { log: jest.Mock };

  function pendingRequest(over: Record<string, unknown> = {}) {
    return {
      id: 'req-1',
      status: 'PENDING',
      attemptCount: 0,
      expiresAt: new Date(Date.now() + 60_000),
      targetUserId: 'tgt-user',
      codeHash: hashLinkCode('ABCD2345', SECRET),
      ...over,
    };
  }

  beforeEach(async () => {
    prisma = {
      chatLinkRequest: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(pendingRequest()),
      },
    };
    merge = {
      detectCollision: jest.fn().mockResolvedValue(null),
      hasInFlightPayout: jest.fn().mockResolvedValue(false),
      merge: jest.fn().mockResolvedValue({ chatIdentities: 1 }),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatLinkService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: AuditService, useValue: audit },
        { provide: AccountMergeService, useValue: merge },
      ],
    }).compile();
    service = moduleRef.get(ChatLinkService);
  });

  it('links on a valid code and marks the request consumed', async () => {
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'LINKED',
      platform: 'TELEGRAM',
    });
    expect(merge.merge).toHaveBeenCalledWith('src-user', 'tgt-user', {});
    expect(prisma.chatLinkRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    });
  });

  it('normalizes case and whitespace before hashing', async () => {
    await service.consume(IDENTITY as never, '  abcd2345 ');
    expect(merge.merge).toHaveBeenCalled();
  });

  it('returns INVALID for an unknown code and merges nothing', async () => {
    prisma.chatLinkRequest.findUnique.mockResolvedValue(null);
    await expect(service.consume(IDENTITY as never, 'ZZZZ9999')).resolves.toEqual({
      status: 'INVALID',
    });
    expect(merge.merge).not.toHaveBeenCalled();
  });

  it('returns INVALID for an expired code without merging', async () => {
    prisma.chatLinkRequest.findUnique.mockResolvedValue(
      pendingRequest({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'INVALID',
    });
    expect(merge.merge).not.toHaveBeenCalled();
  });

  it('returns INVALID once the attempt cap is reached', async () => {
    prisma.chatLinkRequest.findUnique.mockResolvedValue(pendingRequest({ attemptCount: 5 }));
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'INVALID',
    });
  });

  it('counts a failed attempt on a real row so brute force is visible', async () => {
    prisma.chatLinkRequest.findUnique.mockResolvedValue(
      pendingRequest({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await service.consume(IDENTITY as never, 'ABCD2345');
    expect(prisma.chatLinkRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { attemptCount: { increment: 1 } },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'chat.link_code_rejected' }),
    );
  });

  it('never discloses why a code failed', async () => {
    prisma.chatLinkRequest.findUnique.mockResolvedValue(null);
    const unknown = await service.consume(IDENTITY as never, 'ZZZZ9999');
    prisma.chatLinkRequest.findUnique.mockResolvedValue(
      pendingRequest({ expiresAt: new Date(Date.now() - 1000) }),
    );
    const expired = await service.consume(IDENTITY as never, 'ABCD2345');
    // Same outcome for both — an attacker cannot tell a real code from a wrong one.
    expect(unknown).toEqual(expired);
  });

  it('is a no-op when the identity is already on the target account', async () => {
    prisma.chatLinkRequest.findUnique.mockResolvedValue(
      pendingRequest({ targetUserId: 'src-user' }),
    );
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'ALREADY_LINKED',
    });
    expect(merge.merge).not.toHaveBeenCalled();
  });

  it('parks a hard collision for review and does not merge', async () => {
    merge.detectCollision.mockResolvedValue('SELLER_PROFILE_CONFLICT');
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'PENDING_REVIEW',
      reason: 'SELLER_PROFILE_CONFLICT',
    });
    expect(merge.merge).not.toHaveBeenCalled();
    expect(prisma.chatLinkRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: expect.objectContaining({
        status: 'PENDING_REVIEW',
        conflictReason: 'SELLER_PROFILE_CONFLICT',
      }),
    });
  });

  it('refuses transiently on an in-flight payout and leaves the code unconsumed', async () => {
    merge.hasInFlightPayout.mockResolvedValue(true);
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'RETRY',
    });
    // Crucially NOT consumed — the user retries the same code in a minute.
    expect(prisma.chatLinkRequest.update).not.toHaveBeenCalled();
  });

  it('leaves the code live when the merge itself reports an in-flight race', async () => {
    merge.merge.mockRejectedValue(new LinkMergeInFlightError());
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'RETRY',
    });
  });

  it('leaves the code live when the merge reports a collision race', async () => {
    merge.merge.mockRejectedValue(new LinkMergeCollisionError('SELF_TRANSACTION_CONFLICT'));
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'PENDING_REVIEW',
      reason: 'SELF_TRANSACTION_CONFLICT',
    });
  });
});
