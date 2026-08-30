import { Logger } from '@nestjs/common';
import { ChatPlatform } from '@prisma/client';
import type {
  AdapterCapabilities,
  ChatAdapter,
  InboundChatMessage,
  OutboundChatMessage,
} from '../chat-adapter';

/**
 * X (Twitter) DM adapter — STUB (slice 3). X DMs require a paid API tier and the
 * Account Activity API (CRC challenge + per-event HMAC), which is an account /
 * billing gate rather than a code gate. This placeholder registers the platform
 * so the surface is wired, but refuses all traffic until the real Account
 * Activity integration lands. It never silently accepts an unverified event.
 */
export class XAdapter implements ChatAdapter {
  readonly platform = ChatPlatform.X;
  readonly capabilities: AdapterCapabilities = { buttons: false, media: false };
  private readonly logger = new Logger(XAdapter.name);

  verifySignature(_rawBody: Buffer, _headers: Record<string, string | undefined>): boolean {
    // No verification implemented yet — fail closed so nothing is ever processed.
    return false;
  }

  parse(_body: unknown): InboundChatMessage[] {
    return [];
  }

  send(_to: string, _message: OutboundChatMessage): Promise<void> {
    this.logger.warn('X adapter is a stub — outbound send is not implemented');
    return Promise.reject(new Error('X adapter not implemented'));
  }
}
