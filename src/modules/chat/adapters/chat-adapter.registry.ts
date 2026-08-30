import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ChatPlatform } from '@prisma/client';
import { CHAT_ADAPTERS, type ChatAdapter } from './chat-adapter';

/**
 * Resolves the adapter for a platform. Adapters self-register under the
 * CHAT_ADAPTERS multi-token; only the ones whose credentials are configured are
 * present (e.g. Telegram registers only when a bot token is set), so an
 * unconfigured platform is simply unknown.
 */
@Injectable()
export class ChatAdapterRegistry {
  private readonly byPlatform: Map<ChatPlatform, ChatAdapter>;

  constructor(@Optional() @Inject(CHAT_ADAPTERS) adapters: ChatAdapter[] | null) {
    this.byPlatform = new Map((adapters ?? []).map((a) => [a.platform, a]));
  }

  /** The adapter for a platform, or undefined when none is registered. */
  get(platform: ChatPlatform): ChatAdapter | undefined {
    return this.byPlatform.get(platform);
  }

  /** All registered adapters. */
  all(): ChatAdapter[] {
    return [...this.byPlatform.values()];
  }
}
