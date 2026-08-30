import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { WebhooksService, type WebhookResult } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /**
   * Paystack webhook sink. Public (no JWT) — the HMAC signature IS the auth.
   * Relies on `rawBody: true` in main.ts so the exact bytes Paystack signed are
   * available for verification. Always answers 200 for accepted events.
   */
  @Public()
  @SkipThrottle()
  @Post('paystack')
  @HttpCode(200)
  async paystack(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string,
  ): Promise<WebhookResult> {
    if (!req.rawBody) {
      throw new BadRequestException('Missing raw request body');
    }
    return this.webhooks.handlePaystackEvent(req.rawBody, signature ?? '');
  }
}
