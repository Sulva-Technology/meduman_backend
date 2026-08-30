import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ChatPlatform, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { QueueService } from '@/modules/queue/queue.service';
import type { ChatInboundJobData } from '@/modules/queue/queue.constants';
import { ChatAdapterRegistry } from '../adapters/chat-adapter.registry';
import type { InboundChatMessage } from '../adapters/chat-adapter';
import { ChatIdentityService } from '../identity/chat-identity.service';
import { ChatSessionService } from '../session/chat-session.service';
import { ChatDialogService } from '../dialog/chat-dialog.service';

export interface ChatWebhookResult {
  received: true;
  accepted: number;
  duplicate?: number;
}

/**
 * Ingests inbound chat webhooks and (in the worker) runs each message through
 * the dialog. The HTTP path is deliberately minimal — verify signature, dedupe,
 * enqueue, answer 200 — because Telegram and Meta retry aggressively on a slow
 * webhook, and a retried delivery racing the first is exactly how duplicated
 * side effects arise. All dialog work happens off-request in the worker.
 */
@Injectable()
export class ChatInboundService {
  private readonly logger = new Logger(ChatInboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChatAdapterRegistry,
    private readonly queue: QueueService,
    private readonly identity: ChatIdentityService,
    private readonly sessions: ChatSessionService,
    private readonly dialog: ChatDialogService,
  ) {}

  /** Resolve a `:platform` route param to a known, registered platform. */
  resolvePlatform(param: string): ChatPlatform {
    const candidate = param.toUpperCase();
    const platform = (Object.values(ChatPlatform) as string[]).includes(candidate)
      ? (candidate as ChatPlatform)
      : undefined;
    if (!platform || !this.registry.get(platform)) {
      throw new NotFoundException(`Unknown or unconfigured chat platform: ${param}`);
    }
    return platform;
  }

  /** GET verification handshake — delegates to the platform adapter (Meta). */
  verifyChallenge(
    platform: ChatPlatform,
    query: Record<string, string | undefined>,
  ): string | null {
    const adapter = this.registry.get(platform);
    if (!adapter?.verifyChallenge) return null;
    return adapter.verifyChallenge(query);
  }

  /**
   * API path: verify, dedupe, enqueue. Never runs the dialog. The signature is
   * the auth — a forged update is rejected before anything is persisted.
   */
  async ingest(
    platform: ChatPlatform,
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
    body: unknown,
  ): Promise<ChatWebhookResult> {
    const adapter = this.registry.get(platform);
    if (!adapter) throw new NotFoundException(`Unconfigured chat platform: ${platform}`);
    if (!adapter.verifySignature(rawBody, headers)) {
      throw new UnauthorizedException('Invalid chat webhook signature');
    }

    const messages = adapter.parse(body);
    let accepted = 0;
    let duplicate = 0;

    for (const message of messages) {
      const isNew = await this.recordInbound(message, body);
      if (!isNew) {
        duplicate += 1;
        continue;
      }
      await this.queue.enqueueChatInbound(this.toJob(message));
      accepted += 1;
    }

    return { received: true, accepted, ...(duplicate ? { duplicate } : {}) };
  }

  /**
   * Worker path: resolve the identity (minting an auth user on first contact),
   * load the session, run the dialog, and send the reply. The dialog itself
   * never writes transaction state — it calls the domain services.
   */
  async processInbound(job: ChatInboundJobData): Promise<void> {
    const platform = job.platform as ChatPlatform;
    const adapter = this.registry.get(platform);
    if (!adapter) {
      this.logger.warn(`Dropping inbound for unconfigured platform ${job.platform}`);
      return;
    }

    const { identity, user } = await this.identity.resolveOrCreate(
      platform,
      job.from,
      job.displayName,
    );
    const session = await this.sessions.getOrCreate(identity.id);

    const message: InboundChatMessage = {
      platform,
      providerMessageId: job.providerMessageId,
      from: job.from,
      ...(job.displayName ? { displayName: job.displayName } : {}),
      ...(job.text ? { text: job.text } : {}),
      ...(job.payload ? { payload: job.payload } : {}),
      ...(job.media?.length ? { media: job.media } : {}),
    };

    const reply = await this.dialog.handle(identity, user, session, message, adapter);
    await adapter.send(job.from, reply);
  }

  /** Record the inbound message for idempotency. Returns false if already seen. */
  private async recordInbound(message: InboundChatMessage, rawBody: unknown): Promise<boolean> {
    try {
      await this.prisma.chatInboundEvent.create({
        data: {
          platform: message.platform,
          providerMessageId: message.providerMessageId,
          rawPayload: rawBody as Prisma.InputJsonValue,
        },
      });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        this.logger.log(
          `Duplicate inbound ${message.platform}:${message.providerMessageId} ignored`,
        );
        return false;
      }
      throw err;
    }
  }

  private toJob(message: InboundChatMessage): ChatInboundJobData {
    return {
      platform: message.platform,
      providerMessageId: message.providerMessageId,
      from: message.from,
      ...(message.displayName ? { displayName: message.displayName } : {}),
      ...(message.text ? { text: message.text } : {}),
      ...(message.payload ? { payload: message.payload } : {}),
      ...(message.media?.length ? { media: message.media } : {}),
    };
  }
}
