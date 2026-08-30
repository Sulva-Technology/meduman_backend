import type { ChatPlatform } from '@prisma/client';

/** DI multi-token: every registered ChatAdapter is collected under this token. */
export const CHAT_ADAPTERS = Symbol('CHAT_ADAPTERS');

/**
 * A media attachment on an inbound message, in platform-neutral terms. `id` is
 * the platform's own handle (Telegram file_id, WhatsApp media id); `url`, when
 * present (Messenger/Instagram), is a direct CDN link. The adapter's
 * `downloadMedia` turns either into bytes.
 */
export interface InboundMedia {
  id: string;
  mimeType?: string;
  filename?: string;
  /** Direct CDN url when the platform provides one (Messenger/Instagram). */
  url?: string;
}

/** Bytes fetched from a platform CDN, ready to re-upload to private storage. */
export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
}

/** A normalized inbound message, produced by an adapter from a raw provider body. */
export interface InboundChatMessage {
  platform: ChatPlatform;
  /** Provider's message id — the inbound idempotency key. */
  providerMessageId: string;
  /** Platform user id (Telegram chat id, Meta PSID, ...). */
  from: string;
  displayName?: string;
  /** Free text the user typed (a photo caption also lands here). */
  text?: string;
  /** Set when the user tapped a button rather than typing (button payload). */
  payload?: string;
  /** Photo/document attachments, if any. */
  media?: InboundMedia[];
}

/** A button on an outbound message. Rendered as a numbered list where the
 * platform can't show inline buttons (capability-driven, never platform `if`s). */
export interface OutboundButton {
  label: string;
  payload: string;
}

export interface OutboundChatMessage {
  text: string;
  buttons?: OutboundButton[];
}

export interface AdapterCapabilities {
  buttons: boolean;
  media: boolean;
}

/**
 * One social platform's transport. The gateway core never branches on platform
 * identity — only on `capabilities` — so a new platform is a new adapter and no
 * core change. Verification is over the raw request bytes, exactly like the
 * Paystack webhook HMAC.
 */
export interface ChatAdapter {
  readonly platform: ChatPlatform;
  readonly capabilities: AdapterCapabilities;
  /** True if the raw body + headers carry a valid signature for this platform. */
  verifySignature(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;
  /** Parse a raw webhook body into zero or more normalized messages. */
  parse(body: unknown): InboundChatMessage[];
  /** Deliver a message to a platform user id. */
  send(to: string, message: OutboundChatMessage): Promise<void>;
  /**
   * GET webhook-verification handshake (Meta). Returns the challenge string to
   * echo when the verify token matches, or null to reject. Platforms without a
   * GET handshake (Telegram) leave this undefined.
   */
  verifyChallenge?(query: Record<string, string | undefined>): string | null;
  /**
   * Download a media attachment from the platform CDN. Present only on adapters
   * whose `capabilities.media` is true. The bytes are re-uploaded to the private
   * evidence bucket — they are never served from the platform CDN.
   */
  downloadMedia?(media: InboundMedia): Promise<DownloadedMedia>;
}
