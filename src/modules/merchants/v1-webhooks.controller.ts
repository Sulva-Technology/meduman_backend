import { Body, Controller, Delete, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, type MerchantContext } from './api-key.guard';
import { CurrentMerchant } from './decorators/current-merchant.decorator';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { OutboundEventsService } from '@/modules/outbound-events/outbound-events.service';
import { SetWebhookEndpointDto } from './dto/set-webhook-endpoint.dto';
import { ListEventsDto } from './dto/list-events.dto';

/**
 * Public /v1 API — gated by ApiKeyGuard, NOT the global Supabase JWT guard.
 * @Public() makes SupabaseJwtGuard skip this controller; ApiKeyGuard is the
 * real gate (merchant-scoped bearer sk_ key). Every handler is merchant-scoped
 * via @CurrentMerchant.
 */
@Public()
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class V1WebhooksController {
  constructor(
    private readonly endpoints: WebhookEndpointsService,
    private readonly events: OutboundEventsService,
  ) {}

  @Post('webhook-endpoints')
  set(@CurrentMerchant() m: MerchantContext, @Body() dto: SetWebhookEndpointDto) {
    return this.endpoints.setEndpoint(m.id, m.livemode, dto.url); // returns secret once
  }

  @Get('webhook-endpoints')
  get(@CurrentMerchant() m: MerchantContext) {
    return this.endpoints.get(m.id);
  }

  @Post('webhook-endpoints/rotate-secret')
  rotate(@CurrentMerchant() m: MerchantContext) {
    return this.endpoints.rotateSecret(m.id);
  }

  @Delete('webhook-endpoints')
  @HttpCode(204)
  async disable(@CurrentMerchant() m: MerchantContext) {
    await this.endpoints.disable(m.id);
  }

  @Get('events')
  list(@CurrentMerchant() m: MerchantContext, @Query() q: ListEventsDto) {
    return this.events.listForMerchant(m.id, q);
  }
}
