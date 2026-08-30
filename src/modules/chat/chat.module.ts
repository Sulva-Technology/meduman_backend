import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { TransactionsModule } from '@/modules/transactions/transactions.module';
import { PaymentsModule } from '@/modules/payments/payments.module';
import { OtpModule } from '@/modules/otp/otp.module';
import { UsersModule } from '@/modules/users/users.module';
import { StorageModule } from '@/modules/storage/storage.module';
import type { Env } from '@/config/env.validation';
import { ChatPlatform } from '@prisma/client';
import { CHAT_ADAPTERS, type ChatAdapter } from './adapters/chat-adapter';
import { ChatAdapterRegistry } from './adapters/chat-adapter.registry';
import { TelegramAdapter } from './adapters/telegram/telegram.adapter';
import { MetaAdapter, type MetaProduct } from './adapters/meta/meta.adapter';
import { XAdapter } from './adapters/x/x.adapter';
import { DisputesModule } from '@/modules/disputes/disputes.module';
import { SUPABASE_ADMIN_CLIENT } from './identity/supabase-admin';
import { ChatIdentityService } from './identity/chat-identity.service';
import { ChatSessionService } from './session/chat-session.service';
import { ChatDialogService } from './dialog/chat-dialog.service';
import { ChatEvidenceService } from './evidence/chat-evidence.service';
import { ChatOutboundService } from './outbound/chat-outbound.service';
import { ChatInboundService } from './gateway/chat-inbound.service';
import { ChatWebhookController } from './gateway/chat-webhook.controller';

/**
 * Chat-native bot gateway. Platform-agnostic core (identity, session, dialog,
 * inbound/outbound) plus per-platform adapters. An adapter self-registers under
 * CHAT_ADAPTERS only when its credentials are configured, so an unconfigured
 * deploy boots cleanly with no adapters.
 *
 * The dialog drives money/state only through the domain services (Transactions,
 * Payments, Otp), so the state machine stays the sole owner of transaction state.
 */
@Module({
  imports: [
    TransactionsModule,
    PaymentsModule,
    OtpModule,
    UsersModule,
    DisputesModule,
    StorageModule,
  ],
  controllers: [ChatWebhookController],
  providers: [
    {
      // Collect every configured adapter. Each registers only when its full
      // credential set is present, so an unconfigured platform is simply absent.
      provide: CHAT_ADAPTERS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): ChatAdapter[] => {
        const adapters: ChatAdapter[] = [];

        const tgToken = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
        const tgSecret = config.get('TELEGRAM_WEBHOOK_SECRET', { infer: true });
        if (tgToken && tgSecret) {
          adapters.push(new TelegramAdapter(tgToken, tgSecret));
        }

        // WhatsApp / Instagram / Messenger share one Meta app secret + verify token.
        const appSecret = config.get('META_APP_SECRET', { infer: true });
        const verifyToken = config.get('META_VERIFY_TOKEN', { infer: true });
        const graphVersion = config.get('META_GRAPH_VERSION', { infer: true });
        if (appSecret && verifyToken) {
          const meta = (
            platform: ChatPlatform,
            product: MetaProduct,
            accessToken?: string,
            senderId?: string,
          ): void => {
            if (accessToken && senderId) {
              adapters.push(
                new MetaAdapter({
                  platform,
                  product,
                  appSecret,
                  verifyToken,
                  graphVersion,
                  accessToken,
                  senderId,
                }),
              );
            }
          };
          meta(
            ChatPlatform.WHATSAPP,
            'whatsapp',
            config.get('WHATSAPP_ACCESS_TOKEN', { infer: true }),
            config.get('WHATSAPP_PHONE_NUMBER_ID', { infer: true }),
          );
          meta(
            ChatPlatform.MESSENGER,
            'messenger',
            config.get('MESSENGER_PAGE_ACCESS_TOKEN', { infer: true }),
            config.get('MESSENGER_PAGE_ID', { infer: true }),
          );
          meta(
            ChatPlatform.INSTAGRAM,
            'messenger',
            config.get('INSTAGRAM_ACCESS_TOKEN', { infer: true }),
            config.get('INSTAGRAM_ACCOUNT_ID', { infer: true }),
          );
        }

        if (config.get('X_ADAPTER_ENABLED', { infer: true })) {
          adapters.push(new XAdapter());
        }

        return adapters;
      },
    },
    {
      // Service-role Supabase client for minting chat auth users.
      provide: SUPABASE_ADMIN_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createClient(
          config.get('SUPABASE_URL', { infer: true }),
          config.get('SUPABASE_SERVICE_ROLE_KEY', { infer: true }),
          { auth: { persistSession: false, autoRefreshToken: false } },
        ),
    },
    ChatAdapterRegistry,
    ChatIdentityService,
    ChatSessionService,
    ChatDialogService,
    ChatEvidenceService,
    ChatOutboundService,
    ChatInboundService,
  ],
  exports: [ChatInboundService, ChatOutboundService],
})
export class ChatModule {}
