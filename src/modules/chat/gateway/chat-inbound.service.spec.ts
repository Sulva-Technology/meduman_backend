import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ChatPlatform } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import type { QueueService } from '@/modules/queue/queue.service';
import type { ChatIdentityService } from '../identity/chat-identity.service';
import type { ChatSessionService } from '../session/chat-session.service';
import type { ChatDialogService } from '../dialog/chat-dialog.service';
import { ChatAdapterRegistry } from '../adapters/chat-adapter.registry';
import type { ChatAdapter, InboundChatMessage } from '../adapters/chat-adapter';
import { ChatInboundService } from './chat-inbound.service';

function makeAdapter(messages: InboundChatMessage[], signatureOk = true): ChatAdapter {
  return {
    platform: ChatPlatform.TELEGRAM,
    capabilities: { buttons: true, media: true },
    verifySignature: jest.fn().mockReturnValue(signatureOk),
    parse: jest.fn().mockReturnValue(messages),
    send: jest.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(adapter: ChatAdapter | undefined, opts: { inboundThrows?: unknown } = {}) {
  const registry = new ChatAdapterRegistry(adapter ? [adapter] : []);

  const create = jest.fn();
  if (opts.inboundThrows) create.mockRejectedValue(opts.inboundThrows);
  else create.mockResolvedValue({ id: 'ev-1' });

  const prisma = {
    chatInboundEvent: { create },
  } as unknown as PrismaService;

  const enqueueChatInbound = jest.fn().mockResolvedValue(undefined);
  const queue = { enqueueChatInbound } as unknown as QueueService;

  const identity = {} as ChatIdentityService;
  const sessions = {} as ChatSessionService;
  const dialog = {} as ChatDialogService;

  const service = new ChatInboundService(prisma, registry, queue, identity, sessions, dialog);
  return { service, enqueueChatInbound, create };
}

const MSG: InboundChatMessage = {
  platform: ChatPlatform.TELEGRAM,
  providerMessageId: 'msg:1',
  from: '999',
  text: '/help',
};

describe('ChatInboundService.resolvePlatform', () => {
  it('rejects an unknown or unconfigured platform with 404', () => {
    const { service } = makeDeps(makeAdapter([]));
    expect(() => service.resolvePlatform('myspace')).toThrow(NotFoundException);
    // WhatsApp enum exists but has no registered adapter here.
    expect(() => service.resolvePlatform('whatsapp')).toThrow(NotFoundException);
  });

  it('accepts a registered platform', () => {
    const { service } = makeDeps(makeAdapter([]));
    expect(service.resolvePlatform('telegram')).toBe(ChatPlatform.TELEGRAM);
  });
});

describe('ChatInboundService.ingest', () => {
  it('rejects a bad signature before persisting or enqueuing anything', async () => {
    const adapter = makeAdapter([MSG], false);
    const { service, create, enqueueChatInbound } = makeDeps(adapter);

    await expect(
      service.ingest(ChatPlatform.TELEGRAM, Buffer.from('{}'), {}, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(create).not.toHaveBeenCalled();
    expect(enqueueChatInbound).not.toHaveBeenCalled();
  });

  it('records and enqueues a new message', async () => {
    const { service, enqueueChatInbound } = makeDeps(makeAdapter([MSG]));

    const result = await service.ingest(ChatPlatform.TELEGRAM, Buffer.from('{}'), {}, {});

    expect(enqueueChatInbound).toHaveBeenCalledTimes(1);
    expect(result.accepted).toBe(1);
  });

  it('does NOT enqueue a duplicate message (idempotency on providerMessageId)', async () => {
    const { service, enqueueChatInbound } = makeDeps(makeAdapter([MSG]), {
      inboundThrows: { code: 'P2002' },
    });

    const result = await service.ingest(ChatPlatform.TELEGRAM, Buffer.from('{}'), {}, {});

    expect(enqueueChatInbound).not.toHaveBeenCalled();
    expect(result.accepted).toBe(0);
    expect(result.duplicate).toBe(1);
  });
});
