import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ChatSession } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import type { Env } from '@/config/env.validation';
import { ChatStep, type ChatDraft } from '../dialog/dialog.types';

export interface SessionPatch {
  step?: ChatStep;
  draft?: ChatDraft | null;
  transactionId?: string | null;
}

/**
 * Conversational state for one chat identity — NOT transaction state. Losing a
 * session only loses the user's place in a dialog; the money state machine
 * remains the sole owner of TransactionStatus.
 */
@Injectable()
export class ChatSessionService {
  private readonly ttlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlSeconds = config.get('CHAT_SESSION_TTL_SECONDS', { infer: true });
  }

  /** Load the session for an identity, creating a fresh IDLE one if none/expired. */
  async getOrCreate(chatIdentityId: string): Promise<ChatSession> {
    const existing = await this.prisma.chatSession.findUnique({ where: { chatIdentityId } });
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      return existing;
    }
    const expiresAt = this.freshExpiry();
    return this.prisma.chatSession.upsert({
      where: { chatIdentityId },
      create: { chatIdentityId, step: ChatStep.IDLE, expiresAt },
      // Expired → reset to IDLE and drop stale draft/tx.
      update: { step: ChatStep.IDLE, draft: Prisma.JsonNull, transactionId: null, expiresAt },
    });
  }

  /** Apply a patch and bump the expiry. */
  async update(chatIdentityId: string, patch: SessionPatch): Promise<ChatSession> {
    const data: Prisma.ChatSessionUpdateInput = { expiresAt: this.freshExpiry() };
    if (patch.step) data.step = patch.step;
    if (patch.draft !== undefined) {
      data.draft = patch.draft === null ? Prisma.JsonNull : (patch.draft as Prisma.InputJsonValue);
    }
    if (patch.transactionId !== undefined) data.transactionId = patch.transactionId;
    return this.prisma.chatSession.update({ where: { chatIdentityId }, data });
  }

  /** Return to IDLE and clear the draft + active transaction. */
  async reset(chatIdentityId: string): Promise<ChatSession> {
    return this.update(chatIdentityId, {
      step: ChatStep.IDLE,
      draft: null,
      transactionId: null,
    });
  }

  readDraft(session: ChatSession): ChatDraft {
    return (session.draft as ChatDraft | null) ?? {};
  }

  private freshExpiry(): Date {
    return new Date(Date.now() + this.ttlSeconds * 1000);
  }
}
