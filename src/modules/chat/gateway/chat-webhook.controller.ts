import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { ChatInboundService, type ChatWebhookResult } from './chat-inbound.service';

/**
 * Inbound chat webhook sink, one route for every platform. Public (no JWT) — the
 * per-adapter signature IS the auth. Relies on `rawBody: true` in main.ts so the
 * exact bytes the platform signed are available. Always answers 200 fast; the
 * dialog runs off-request in the worker.
 */
@Controller('chat')
export class ChatWebhookController {
  constructor(private readonly inbound: ChatInboundService) {}

  /**
   * Meta webhook-verification handshake (GET). Meta calls this once when the
   * webhook is registered; the adapter echoes `hub.challenge` only when the
   * verify token matches. Platforms without a GET handshake (Telegram) 403 here.
   */
  @Public()
  @SkipThrottle()
  @Get(':platform/webhook')
  verify(
    @Param('platform') platformParam: string,
    @Query() query: Record<string, string | undefined>,
  ): string {
    const platform = this.inbound.resolvePlatform(platformParam);
    const challenge = this.inbound.verifyChallenge(platform, query);
    if (challenge === null) {
      throw new ForbiddenException('Verification failed');
    }
    return challenge;
  }

  @Public()
  @SkipThrottle()
  @Post(':platform/webhook')
  @HttpCode(200)
  async webhook(
    @Param('platform') platformParam: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<ChatWebhookResult> {
    if (!req.rawBody) {
      throw new BadRequestException('Missing raw request body');
    }
    const platform = this.inbound.resolvePlatform(platformParam);
    return this.inbound.ingest(platform, req.rawBody, headers, req.body);
  }
}
