import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ActorType,
  ChatLinkConflictReason,
  ChatLinkRequestStatus,
  type ChatIdentity,
  type ChatLinkRequest,
  type ChatPlatform,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/modules/audit/audit.service';
import type { Env } from '@/config/env.validation';
import { AccountMergeService } from './account-merge.service';
import { generateLinkCode, hashLinkCode, normalizeLinkCode } from './chat-link.crypto';
import { LinkMergeCollisionError, LinkMergeInFlightError } from './linking.errors';

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

export type ConsumeOutcome =
  | { status: 'LINKED'; platform: ChatPlatform }
  | { status: 'ALREADY_LINKED' }
  | { status: 'PENDING_REVIEW'; reason: ChatLinkConflictReason }
  | { status: 'RETRY' }
  | { status: 'INVALID' };

/** A link request as the admin API returns it — never the code hash. */
export type LinkRequestView = Omit<ChatLinkRequest, 'codeHash'>;

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
  private readonly logger = new Logger(ChatLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly merge: AccountMergeService,
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

  /**
   * Verify a code typed into chat and, on success, merge the chat-born account
   * into the web account that minted it.
   *
   * Failure is deliberately uniform: every rejection returns INVALID, so a caller
   * cannot learn whether a code exists, expired, or was already used. The precise
   * reason goes to the log and the audit trail instead.
   */
  async consume(identity: ChatIdentity, rawCode: string): Promise<ConsumeOutcome> {
    const maxAttempts = this.config.get('CHAT_LINK_MAX_ATTEMPTS', { infer: true });
    const codeHash = hashLinkCode(
      normalizeLinkCode(rawCode),
      this.config.get('CHAT_LINK_HASH_SECRET', { infer: true }),
    );

    const request = await this.prisma.chatLinkRequest.findUnique({ where: { codeHash } });

    const reject = async (reason: string): Promise<ConsumeOutcome> => {
      this.logger.warn(
        `Link code rejected (${reason}) for ${identity.platform}:${identity.platformUserId}`,
      );
      if (request) {
        // Count the attempt on a real row so a brute-force run is visible.
        await this.prisma.chatLinkRequest.update({
          where: { id: request.id },
          data: { attemptCount: { increment: 1 } },
        });
        await this.audit.log({
          action: 'chat.link_code_rejected',
          targetType: 'ChatLinkRequest',
          targetId: request.id,
          actorId: identity.id,
          actorType: ActorType.USER,
          reason,
          metadata: { platform: identity.platform },
        });
      }
      return { status: 'INVALID' };
    };

    if (!request) {
      return reject('unknown code');
    }
    if (request.status !== ChatLinkRequestStatus.PENDING) {
      return reject(`status ${request.status}`);
    }
    if (request.expiresAt <= new Date()) {
      return reject('expired');
    }
    if (request.attemptCount >= maxAttempts) {
      return reject('attempt cap reached');
    }

    const targetUserId = request.targetUserId;

    // Already on this account — nothing to do, but consume so the code can't be
    // replayed against a different identity later.
    if (identity.userId === targetUserId) {
      await this.consumeAs(request.id, {
        status: ChatLinkRequestStatus.COMPLETED,
        platform: identity.platform,
        platformUserId: identity.platformUserId,
        chatIdentityId: identity.id,
        sourceUserId: identity.userId,
      });
      return { status: 'ALREADY_LINKED' };
    }

    // Transient check BEFORE the merge: a payout may be mid-send, and the transfer
    // destination is read from the seller's profile at send time (rule 4). Write
    // nothing and leave the code live so the user can retry.
    if (await this.merge.hasInFlightPayout([identity.userId, targetUserId])) {
      this.logger.warn(`Link deferred — payout in flight for ${identity.userId}/${targetUserId}`);
      return { status: 'RETRY' };
    }

    const collision = await this.merge.detectCollision(identity.userId, targetUserId);
    if (collision) {
      await this.consumeAs(request.id, {
        status: ChatLinkRequestStatus.PENDING_REVIEW,
        conflictReason: collision,
        platform: identity.platform,
        platformUserId: identity.platformUserId,
        chatIdentityId: identity.id,
        sourceUserId: identity.userId,
      });
      return { status: 'PENDING_REVIEW', reason: collision };
    }

    try {
      const report = await this.merge.merge(identity.userId, targetUserId, {});
      await this.consumeAs(request.id, {
        status: ChatLinkRequestStatus.COMPLETED,
        platform: identity.platform,
        platformUserId: identity.platformUserId,
        chatIdentityId: identity.id,
        sourceUserId: identity.userId,
      });
      this.logger.log(
        `Linked ${identity.platform}:${identity.platformUserId} → ${targetUserId} (${report.chatIdentities} identities)`,
      );
      return { status: 'LINKED', platform: identity.platform };
    } catch (err) {
      // The guards re-run inside the merge transaction, so a row created between
      // the checks above and the write surfaces here. Neither is a permanent
      // failure — leave the code live and let the user retry.
      if (err instanceof LinkMergeInFlightError) {
        return { status: 'RETRY' };
      }
      if (err instanceof LinkMergeCollisionError) {
        await this.consumeAs(request.id, {
          status: ChatLinkRequestStatus.PENDING_REVIEW,
          conflictReason: err.kind,
          platform: identity.platform,
          platformUserId: identity.platformUserId,
          chatIdentityId: identity.id,
          sourceUserId: identity.userId,
        });
        return { status: 'PENDING_REVIEW', reason: err.kind };
      }
      throw err;
    }
  }

  /** Parked link requests, newest first — the admin review queue. */
  async listForReview(filter: {
    status?: string;
    cursor?: string;
    limit?: string;
  }): Promise<{ items: LinkRequestView[]; nextCursor: string | null }> {
    const take = Math.min(Number(filter.limit) || 50, 100);
    const rows = await this.prisma.chatLinkRequest.findMany({
      where: {
        status: (filter.status as ChatLinkRequestStatus) ?? ChatLinkRequestStatus.PENDING_REVIEW,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    });
    // `codeHash` never leaves the service: an admin has no use for it, and a
    // keyed hash in an API response is secret-adjacent material that does not
    // need to travel.
    const items: LinkRequestView[] = rows
      .slice(0, take)
      .map(({ codeHash: _codeHash, ...rest }) => rest);
    const nextCursor = rows.length > take ? (items.at(-1)?.id ?? null) : null;
    return { items, nextCursor };
  }

  /**
   * Resolve a parked request. COMPLETE re-runs the merge with the admin's chosen
   * winning profile; REJECT closes it having written nothing else.
   *
   * SELF_TRANSACTION_CONFLICT is NOT resolvable — no choice of profile makes one
   * user a valid counterparty to themselves, so it returns 409 and must be
   * rejected instead.
   */
  async resolve(
    id: string,
    outcome: 'COMPLETE' | 'REJECT',
    opts: { keepProfile?: 'TARGET' | 'SOURCE'; adminId: string },
  ): Promise<{ status: ChatLinkRequestStatus }> {
    const request = await this.prisma.chatLinkRequest.findUnique({ where: { id } });
    if (!request) {
      throw new NotFoundException(`Link request ${id} not found`);
    }
    if (request.status !== ChatLinkRequestStatus.PENDING_REVIEW) {
      throw new ConflictException(`Link request is ${request.status}, not PENDING_REVIEW`);
    }
    if (!request.sourceUserId || !request.chatIdentityId) {
      throw new ConflictException('Link request has no chat side to merge');
    }

    if (outcome === 'REJECT') {
      await this.prisma.chatLinkRequest.update({
        where: { id },
        data: {
          status: ChatLinkRequestStatus.REJECTED,
          resolvedAt: new Date(),
          resolvedBy: opts.adminId,
        },
      });
      await this.audit.log({
        action: 'chat.link_request_rejected',
        targetType: 'ChatLinkRequest',
        targetId: id,
        actorId: opts.adminId,
        actorType: ActorType.ADMIN,
      });
      return { status: ChatLinkRequestStatus.REJECTED };
    }

    if (request.conflictReason === ChatLinkConflictReason.SELF_TRANSACTION_CONFLICT) {
      throw new ConflictException(
        'SELF_TRANSACTION_CONFLICT cannot be resolved by choosing a profile — reject it instead',
      );
    }
    if (!opts.keepProfile) {
      throw new ConflictException('keepProfile is required to resolve a SELLER_PROFILE_CONFLICT');
    }

    // Promote back to PENDING so the normal merge path owns the guards.
    await this.prisma.chatLinkRequest.update({
      where: { id },
      data: { status: ChatLinkRequestStatus.PENDING, conflictReason: null },
    });

    const identity = await this.prisma.chatIdentity.findUniqueOrThrow({
      where: { id: request.chatIdentityId },
    });
    const result = await this.merge.merge(request.sourceUserId, request.targetUserId, {
      keepProfile: opts.keepProfile,
      // The admin has made the collision decision the guard refuses to make.
      overrideCollision: 'SELLER_PROFILE_CONFLICT',
    });

    await this.prisma.chatLinkRequest.update({
      where: { id },
      data: {
        status: ChatLinkRequestStatus.COMPLETED,
        consumedAt: new Date(),
        resolvedAt: new Date(),
        resolvedBy: opts.adminId,
      },
    });
    await this.audit.log({
      action: 'chat.link_request_completed',
      targetType: 'ChatLinkRequest',
      targetId: id,
      actorId: opts.adminId,
      actorType: ActorType.ADMIN,
      metadata: { keepProfile: opts.keepProfile, ...result, platform: identity.platform },
    });
    return { status: ChatLinkRequestStatus.COMPLETED };
  }

  /** Mark a request consumed and record the chat side that consumed it. */
  private async consumeAs(
    id: string,
    data: {
      status: ChatLinkRequestStatus;
      platform: ChatPlatform;
      platformUserId: string;
      chatIdentityId: string;
      sourceUserId: string;
      conflictReason?: ChatLinkConflictReason;
    },
  ): Promise<void> {
    await this.prisma.chatLinkRequest.update({
      where: { id },
      data: {
        status: data.status,
        platform: data.platform,
        platformUserId: data.platformUserId,
        chatIdentityId: data.chatIdentityId,
        sourceUserId: data.sourceUserId,
        consumedAt: new Date(),
        resolvedAt: new Date(),
        ...(data.conflictReason ? { conflictReason: data.conflictReason } : {}),
      },
    });
  }
}
