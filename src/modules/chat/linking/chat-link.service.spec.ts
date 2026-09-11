import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/modules/audit/audit.service';
import { AccountMergeService } from './account-merge.service';
import { ChatLinkService } from './chat-link.service';
import { hashLinkCode } from './chat-link.crypto';

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
