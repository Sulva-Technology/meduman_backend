import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActorType, type ChatIdentity, type ChatPlatform, type User } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/modules/audit/audit.service';
import type { Env } from '@/config/env.validation';
import { SUPABASE_ADMIN_CLIENT, type SupabaseAdminAuthClient } from './supabase-admin';

export interface ResolvedChatUser {
  identity: ChatIdentity;
  user: User;
  /** True on the request that first created this identity. */
  created: boolean;
}

/**
 * Maps a chat account to a Meduman user, minting the user in Supabase Auth on
 * first contact so `User.id` stays a real auth uuid (a chat-born user can later
 * sign into the website with the same identity). First contact is idempotent:
 * the unique (platform, platformUserId) index is the guard, and a lost race
 * re-reads the winner rather than creating a second auth user.
 */
@Injectable()
export class ChatIdentityService {
  private readonly logger = new Logger(ChatIdentityService.name);
  private readonly emailDomain: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    @Inject(SUPABASE_ADMIN_CLIENT) private readonly supabase: SupabaseAdminAuthClient,
  ) {
    this.emailDomain = config.get('CHAT_IDENTITY_EMAIL_DOMAIN', { infer: true });
  }

  async resolveOrCreate(
    platform: ChatPlatform,
    platformUserId: string,
    displayName?: string,
  ): Promise<ResolvedChatUser> {
    const existing = await this.prisma.chatIdentity.findUnique({
      where: { platform_platformUserId: { platform, platformUserId } },
      include: { user: true },
    });
    if (existing) {
      return { identity: existing, user: existing.user, created: false };
    }

    const email = this.syntheticEmail(platform, platformUserId);
    const authUserId = await this.createAuthUser(email, platform, platformUserId, displayName);

    // Mirror the auth user locally, then attach the chat identity. A concurrent
    // first contact for the same account collides on the unique index — we adopt
    // the winner and leave the just-created auth user unreferenced rather than
    // returning a duplicate identity.
    try {
      const identity = await this.prisma.$transaction(async (db) => {
        await db.user.upsert({
          where: { id: authUserId },
          create: { id: authUserId, email },
          update: {},
        });
        return db.chatIdentity.create({
          data: {
            platform,
            platformUserId,
            userId: authUserId,
            ...(displayName ? { displayName } : {}),
          },
          include: { user: true },
        });
      });

      await this.audit.log({
        action: 'chat.identity_created',
        targetType: 'ChatIdentity',
        targetId: identity.id,
        actorId: authUserId,
        actorType: ActorType.USER,
        metadata: { platform, platformUserId },
      });

      return { identity, user: identity.user, created: true };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        const winner = await this.prisma.chatIdentity.findUnique({
          where: { platform_platformUserId: { platform, platformUserId } },
          include: { user: true },
        });
        if (winner) {
          this.logger.warn(
            `Lost identity race for ${platform}:${platformUserId} — adopting winner`,
          );
          return { identity: winner, user: winner.user, created: false };
        }
      }
      throw err;
    }
  }

  /** Deterministic synthetic address — a chat user may have no real email. */
  private syntheticEmail(platform: ChatPlatform, platformUserId: string): string {
    return `chat+${platform.toLowerCase()}-${platformUserId}@${this.emailDomain}`;
  }

  private async createAuthUser(
    email: string,
    platform: ChatPlatform,
    platformUserId: string,
    displayName?: string,
  ): Promise<string> {
    const { data, error } = await this.supabase.auth.admin.createUser({
      email,
      email_confirm: false,
      user_metadata: {
        source: 'chat',
        platform,
        platform_user_id: platformUserId,
        ...(displayName ? { full_name: displayName } : {}),
      },
    });
    if (error || !data?.user?.id) {
      throw new InternalServerErrorException(
        `Could not create chat auth user: ${error?.message ?? 'unknown error'}`,
      );
    }
    return data.user.id;
  }
}
