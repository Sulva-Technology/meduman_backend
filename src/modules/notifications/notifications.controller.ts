import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { NotificationStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { NotificationsService } from './notifications.service';

class ListNotificationsDto {
  @IsOptional()
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;
}

/** In-app notification inbox for the authenticated user. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() claims: SupabaseJwtClaims, @Query() q: ListNotificationsDto) {
    return this.notifications.listForUser(claims.sub, q.status);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    return this.notifications.markRead(claims.sub, id);
  }
}
