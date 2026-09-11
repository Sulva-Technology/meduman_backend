import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Roles } from '@/modules/auth';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { ChatLinkService } from './chat-link.service';
import { ResolveLinkRequestDto } from './dto/resolve-link-request.dto';

/**
 * Admin review queue for link requests that hit a hard collision. Every route
 * requires the ADMIN app role (rule 6 — an admin action is always audited).
 */
@Roles('ADMIN')
@Controller('admin/chat/link-requests')
export class ChatLinkAdminController {
  constructor(private readonly links: ChatLinkService) {}

  @Get()
  list(@Query() query: { status?: string; cursor?: string; limit?: string }) {
    return this.links.listForReview(query);
  }

  /** Resolve a parked request: complete the merge, or reject it. */
  @Post(':id/resolve')
  resolve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ResolveLinkRequestDto,
    @CurrentUser() claims: SupabaseJwtClaims,
  ) {
    return this.links.resolve(id, dto.outcome, {
      ...(dto.keepProfile ? { keepProfile: dto.keepProfile } : {}),
      adminId: claims.sub,
    });
  }
}
