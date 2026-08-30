import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { UsersModule } from '@/modules/users/users.module';
import { TransactionsModule } from '@/modules/transactions/transactions.module';
import { OutboundEventsModule } from '@/modules/outbound-events/outbound-events.module';
import { MerchantsService } from './merchants.service';
import { MerchantSellersService } from './merchant-sellers.service';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { OutboundEventRelay } from './outbound-event-relay.service';
import { ApiKeyGuard } from './api-key.guard';
import { AdminMerchantsController } from './admin-merchants.controller';
import { V1SellersController } from './v1-sellers.controller';
import { V1TransactionsController } from './v1-transactions.controller';
import { V1WebhooksController } from './v1-webhooks.controller';

/**
 * EaaS /v1 public API surface (slice 1): API-key-authenticated merchant
 * tenancy over sellers + transactions. ApiKeyGuard is the real gate on both
 * v1 controllers (they are also @Public() to skip the global Supabase JWT
 * guard — see the controllers for the guard-interplay note).
 *
 * Admin merchant endpoints: SupabaseJwtGuard + RolesGuard (@Roles('ADMIN'))
 * protect the AdminMerchantsController — first-party only.
 */
@Module({
  imports: [PrismaModule, UsersModule, TransactionsModule, OutboundEventsModule],
  controllers: [
    AdminMerchantsController,
    V1SellersController,
    V1TransactionsController,
    V1WebhooksController,
  ],
  providers: [
    MerchantsService,
    MerchantSellersService,
    WebhookEndpointsService,
    WebhookDeliveryService,
    OutboundEventRelay,
    ApiKeyGuard,
  ],
  exports: [MerchantsService, WebhookEndpointsService, WebhookDeliveryService, OutboundEventRelay],
})
export class MerchantsModule {}
