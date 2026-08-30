import { timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ChatPlatform } from '@prisma/client';
import type {
  AdapterCapabilities,
  ChatAdapter,
  DownloadedMedia,
  InboundChatMessage,
  InboundMedia,
  OutboundChatMessage,
} from '../chat-adapter';

/** Largest single chat upload we accept as evidence (10 MiB). */
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

interface TelegramPhotoSize {
  file_id?: string;
  file_size?: number;
}
interface TelegramDocument {
  file_id?: string;
  mime_type?: string;
  file_name?: string;
}

/** Minimal shape of the Telegram Update objects we consume. */
interface TelegramUpdate {
  update_id?: number;
  message?: {
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
    chat?: { id?: number | string };
    from?: { first_name?: string; username?: string };
  };
  callback_query?: {
    id?: string;
    data?: string;
    message?: { chat?: { id?: number | string } };
    from?: { first_name?: string; username?: string };
  };
}

/**
 * Telegram Bot API adapter. Authenticity is the shared secret Telegram echoes in
 * `X-Telegram-Bot-Api-Secret-Token` (set when the webhook is registered), checked
 * constant-time. Full inline-button support.
 */
@Injectable()
export class TelegramAdapter implements ChatAdapter {
  readonly platform = ChatPlatform.TELEGRAM;
  readonly capabilities: AdapterCapabilities = { buttons: true, media: true };
  private readonly logger = new Logger(TelegramAdapter.name);

  constructor(
    private readonly botToken: string,
    private readonly webhookSecret: string,
  ) {}

  verifySignature(_rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    const provided = headers['x-telegram-bot-api-secret-token'];
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.webhookSecret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parse(body: unknown): InboundChatMessage[] {
    const update = body as TelegramUpdate;
    if (!update || typeof update !== 'object' || update.update_id === undefined) {
      return [];
    }

    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      if (chatId === undefined) return [];
      const displayName = this.name(cq.from);
      return [
        {
          platform: this.platform,
          providerMessageId: `cbq:${cq.id ?? update.update_id}`,
          from: String(chatId),
          ...(displayName ? { displayName } : {}),
          ...(cq.data ? { payload: cq.data } : {}),
        },
      ];
    }

    const msg = update.message;
    const chatId = msg?.chat?.id;
    if (!msg || chatId === undefined) return [];
    const displayName = this.name(msg.from);
    const media = this.extractMedia(msg);
    // A photo carries its text in `caption`, a plain message in `text`.
    const text = msg.text ?? msg.caption;
    return [
      {
        platform: this.platform,
        providerMessageId: `msg:${update.update_id}`,
        from: String(chatId),
        ...(displayName ? { displayName } : {}),
        ...(text ? { text } : {}),
        ...(media.length ? { media } : {}),
      },
    ];
  }

  /** Pull the largest photo size and/or a document into neutral media handles. */
  private extractMedia(msg: NonNullable<TelegramUpdate['message']>): InboundMedia[] {
    const out: InboundMedia[] = [];
    if (msg.photo?.length) {
      // Telegram sends ascending sizes; the last is the highest resolution.
      const largest = msg.photo[msg.photo.length - 1];
      if (largest?.file_id) out.push({ id: largest.file_id, mimeType: 'image/jpeg' });
    }
    if (msg.document?.file_id) {
      out.push({
        id: msg.document.file_id,
        ...(msg.document.mime_type ? { mimeType: msg.document.mime_type } : {}),
        ...(msg.document.file_name ? { filename: msg.document.file_name } : {}),
      });
    }
    return out;
  }

  /**
   * Resolve a Telegram file_id to bytes: getFile yields a file_path, then the
   * file endpoint serves the content. Both calls carry the bot token; the bytes
   * are re-uploaded to private storage, never linked from Telegram's CDN.
   */
  async downloadMedia(media: InboundMedia): Promise<DownloadedMedia> {
    const meta = await fetch(
      `https://api.telegram.org/bot${this.botToken}/getFile?file_id=${encodeURIComponent(media.id)}`,
    );
    if (!meta.ok) throw new Error(`Telegram getFile failed: ${meta.status}`);
    const metaJson = (await meta.json()) as { ok?: boolean; result?: { file_path?: string } };
    const filePath = metaJson.result?.file_path;
    if (!metaJson.ok || !filePath) throw new Error('Telegram getFile returned no file_path');

    const fileRes = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${filePath}`);
    if (!fileRes.ok) throw new Error(`Telegram file download failed: ${fileRes.status}`);
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    if (buffer.length > MAX_MEDIA_BYTES) {
      throw new Error(`Telegram media too large: ${buffer.length} bytes`);
    }
    return { buffer, mimeType: media.mimeType ?? 'application/octet-stream' };
  }

  async send(to: string, message: OutboundChatMessage): Promise<void> {
    const body: Record<string, unknown> = { chat_id: to, text: message.text };
    if (message.buttons?.length) {
      body.reply_markup = {
        inline_keyboard: message.buttons.map((b) => [{ text: b.label, callback_data: b.payload }]),
      };
    }

    let res: Response;
    try {
      res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.error(`Telegram send failed (network)`, err as Error);
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Telegram send failed: ${res.status} ${text}`);
    }
  }

  private name(from?: { first_name?: string; username?: string }): string | undefined {
    return from?.first_name ?? from?.username;
  }
}
