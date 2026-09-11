import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActorType, ChatLinkRequestStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/modules/audit/audit.service';
import type { Env } from '@/config/env.validation';
import { generateLinkCode, hashLinkCode } from './chat-link.crypto';

export interface MintedLinkCode {
  /** Plaintext — returned to the authenticated web caller exactly once. */
  code: string;
  expiresAt: Date;
}

export interface LinkStatus {
  linked: boolean;
  pendingCode: boolean;
  underReview: boolean;
}

/**
 * The chat↔web account-link boundary.
 *
 * A web-authenticated user mints a short-lived single-use code; they type it into
 * chat as `/connect <code>`. Verification is generic to the client (no oracle):
 * whether a code exists, expired, or was consumed is never disclosed — only
 * logged and audited, exactly as the OTP verify path does.
 */
@Injectable()
export class ChatLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {}

  /**
   * Mint a link code for a web account. Any earlier live code is superseded —
   * one live code per user keeps the surface small and the retry obvious.
   */
  async mint(targetUserId: string): Promise<MintedLinkCode> {
    await this.prisma.chatLinkRequest.updateMany({
      where: { targetUserId, status: ChatLinkRequestStatus.PENDING },
      data: { status: ChatLinkRequestStatus.CANCELLED, resolvedAt: new Date() },
    });

    const code = generateLinkCode(this.config.get('CHAT_LINK_CODE_LENGTH', { infer: true }));
    const ttlSeconds = this.config.get('CHAT_LINK_CODE_TTL_SECONDS', { infer: true });
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const request = await this.prisma.chatLinkRequest.create({
      data: {
        codeHash: hashLinkCode(code, this.config.get('CHAT_LINK_HASH_SECRET', { infer: true })),
        targetUserId,
        expiresAt,
      },
    });

    // Never the plaintext (rule 6 keeps the action, not the secret).
    await this.audit.log({
      action: 'chat.link_code_minted',
      targetType: 'ChatLinkRequest',
      targetId: request.id,
      actorId: targetUserId,
      actorType: ActorType.USER,
    });

    return { code, expiresAt };
  }

  /** Non-secret state for the frontend's "connect" card. */
  async statusFor(targetUserId: string): Promise<LinkStatus> {
    const [linked, pending, review] = await Promise.all([
      this.prisma.chatIdentity.count({ where: { userId: targetUserId } }),
      this.prisma.chatLinkRequest.count({
        where: { targetUserId, status: ChatLinkRequestStatus.PENDING },
      }),
      this.prisma.chatLinkRequest.count({
        where: { targetUserId, status: ChatLinkRequestStatus.PENDING_REVIEW },
      }),
    ]);
    return { linked: linked > 0, pendingCode: pending > 0, underReview: review > 0 };
  }
}
