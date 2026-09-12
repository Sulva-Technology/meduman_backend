import { Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { ChatLinkService, type LinkStatus } from './chat-link.service';

/**
 * The web side of account linking. Both routes are authenticated by the global
 * SupabaseJwtGuard — the caller can only ever act on their own account.
 *
 * `mint` is the ONLY place a plaintext link code is ever returned. It is not
 * logged, not audited, and not recoverable afterwards.
 */
@Controller('chat')
export class ChatLinkController {
  constructor(private readonly links: ChatLinkService) {}

  /** Mint a link code to type into the bot as `/connect <code>`. */
  // Tight limit: codes are single-use, so minting is inherently rare.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('link-code')
  async mint(
    @CurrentUser() claims: SupabaseJwtClaims,
  ): Promise<{ code: string; expiresAt: string }> {
    const { code, expiresAt } = await this.links.mint(claims.sub);
    return { code, expiresAt: expiresAt.toISOString() };
  }

  /** Non-secret link state for the frontend's "connect" card. */
  @Get('link-status')
  async status(@CurrentUser() claims: SupabaseJwtClaims): Promise<LinkStatus> {
    return this.links.statusFor(claims.sub);
  }
}
