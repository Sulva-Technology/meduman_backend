import { createHmac, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ChatPlatform } from '@prisma/client';
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

/** Which Meta messaging product a given platform speaks. */
export type MetaProduct = 'whatsapp' | 'messenger';

export interface MetaAdapterConfig {
  platform: ChatPlatform;
  /** WhatsApp uses the Cloud API shape; Messenger + Instagram share the Send API shape. */
  product: MetaProduct;
  /** Meta App Secret — keys the X-Hub-Signature-256 HMAC over the raw body. */
  appSecret: string;
  /** Shared token echoed back in the GET verification handshake. */
  verifyToken: string;
  /** Page/WABA access token used to call the Graph send API. */
  accessToken: string;
  /** WhatsApp phone-number id, or the Page/IG id for the Send API. */
  senderId: string;
  graphVersion: string;
}

interface WhatsAppMedia {
  id?: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
}

interface WhatsAppChange {
  value?: {
    messages?: {
      from?: string;
      id?: string;
      text?: { body?: string };
      image?: WhatsAppMedia;
      document?: WhatsAppMedia;
      interactive?: { button_reply?: { id?: string }; list_reply?: { id?: string } };
    }[];
    contacts?: { profile?: { name?: string } }[];
  };
}

interface MessengerEvent {
  sender?: { id?: string };
  message?: {
    mid?: string;
    text?: string;
    quick_reply?: { payload?: string };
    attachments?: { type?: string; payload?: { url?: string } }[];
  };
  postback?: { mid?: string; payload?: string };
}

/**
 * One adapter for all three Meta chat surfaces — WhatsApp, Instagram DM, and
 * Messenger — since they share one webhook (X-Hub-Signature-256 over the raw
 * body), one GET verification handshake, and one Graph send API. The only real
 * differences are the inbound payload shape (WhatsApp Cloud API vs the Send API
 * used by Messenger/Instagram) and the send envelope, both selected by
 * `product`. The gateway core stays platform-agnostic.
 *
 * Instantiated once per configured platform in ChatModule; a platform whose
 * credentials are incomplete is simply not registered.
 */
export class MetaAdapter implements ChatAdapter {
  readonly platform: ChatPlatform;
  readonly capabilities: AdapterCapabilities = { buttons: true, media: true };
  private readonly logger = new Logger(MetaAdapter.name);

  constructor(private readonly config: MetaAdapterConfig) {
    this.platform = config.platform;
  }

  verifySignature(rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    const header = headers['x-hub-signature-256'];
    if (!header || !header.startsWith('sha256=')) return false;
    const provided = header.slice('sha256='.length);
    const expected = createHmac('sha256', this.config.appSecret).update(rawBody).digest('hex');
    let a: Buffer;
    let b: Buffer;
    try {
      a = Buffer.from(provided, 'hex');
      b = Buffer.from(expected, 'hex');
    } catch {
      return false;
    }
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  verifyChallenge(query: Record<string, string | undefined>): string | null {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (mode === 'subscribe' && token === this.config.verifyToken && challenge) {
      return challenge;
    }
    return null;
  }

  parse(body: unknown): InboundChatMessage[] {
    const root = body as { entry?: { messaging?: MessengerEvent[]; changes?: WhatsAppChange[] }[] };
    if (!root?.entry?.length) return [];
    return this.config.product === 'whatsapp'
      ? this.parseWhatsApp(root.entry)
      : this.parseMessenger(root.entry);
  }

  private parseWhatsApp(entries: { changes?: WhatsAppChange[] }[]): InboundChatMessage[] {
    const out: InboundChatMessage[] = [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const name = change.value?.contacts?.[0]?.profile?.name;
        for (const m of change.value?.messages ?? []) {
          if (!m.id || !m.from) continue;
          const payload = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id;
          const media = this.whatsAppMedia(m.image, m.document);
          const caption = m.image?.caption ?? m.document?.caption;
          const text = m.text?.body ?? caption;
          out.push({
            platform: this.platform,
            providerMessageId: m.id,
            from: m.from,
            ...(name ? { displayName: name } : {}),
            ...(text ? { text } : {}),
            ...(payload ? { payload } : {}),
            ...(media.length ? { media } : {}),
          });
        }
      }
    }
    return out;
  }

  private parseMessenger(entries: { messaging?: MessengerEvent[] }[]): InboundChatMessage[] {
    const out: InboundChatMessage[] = [];
    for (const entry of entries) {
      for (const ev of entry.messaging ?? []) {
        const from = ev.sender?.id;
        const id = ev.message?.mid ?? ev.postback?.mid;
        if (!from || !id) continue;
        const payload = ev.postback?.payload ?? ev.message?.quick_reply?.payload;
        const media = this.messengerMedia(ev.message?.attachments);
        out.push({
          platform: this.platform,
          providerMessageId: id,
          from,
          ...(ev.message?.text ? { text: ev.message.text } : {}),
          ...(payload ? { payload } : {}),
          ...(media.length ? { media } : {}),
        });
      }
    }
    return out;
  }

  /** WhatsApp media is id-based — resolved to a URL at download time. */
  private whatsAppMedia(image?: WhatsAppMedia, document?: WhatsAppMedia): InboundMedia[] {
    const out: InboundMedia[] = [];
    if (image?.id) out.push({ id: image.id, mimeType: image.mime_type ?? 'image/jpeg' });
    if (document?.id) {
      out.push({
        id: document.id,
        ...(document.mime_type ? { mimeType: document.mime_type } : {}),
        ...(document.filename ? { filename: document.filename } : {}),
      });
    }
    return out;
  }

  /** Messenger/Instagram attachments carry a direct CDN url. */
  private messengerMedia(
    attachments?: { type?: string; payload?: { url?: string } }[],
  ): InboundMedia[] {
    const out: InboundMedia[] = [];
    for (const a of attachments ?? []) {
      const url = a.payload?.url;
      if (url) out.push({ id: url, url });
    }
    return out;
  }

  /**
   * Download a media attachment. For WhatsApp the id must first be resolved to a
   * short-lived Graph url; Messenger/Instagram already carry a direct url. Both
   * fetches send the page/WABA bearer token. Bytes are re-uploaded to private
   * storage — never linked from the Meta CDN.
   */
  async downloadMedia(media: InboundMedia): Promise<DownloadedMedia> {
    let url = media.url;
    if (!url) {
      const metaRes = await fetch(
        `https://graph.facebook.com/${this.config.graphVersion}/${encodeURIComponent(media.id)}`,
        { headers: { Authorization: `Bearer ${this.config.accessToken}` } },
      );
      if (!metaRes.ok) throw new Error(`Meta media lookup failed: ${metaRes.status}`);
      const metaJson = (await metaRes.json()) as { url?: string };
      if (!metaJson.url) throw new Error('Meta media lookup returned no url');
      url = metaJson.url;
    }

    const fileRes = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
    });
    if (!fileRes.ok) throw new Error(`Meta media download failed: ${fileRes.status}`);
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    if (buffer.length > MAX_MEDIA_BYTES) {
      throw new Error(`Meta media too large: ${buffer.length} bytes`);
    }
    const mimeType =
      media.mimeType ?? fileRes.headers.get('content-type') ?? 'application/octet-stream';
    return { buffer, mimeType };
  }

  async send(to: string, message: OutboundChatMessage): Promise<void> {
    const url = `https://graph.facebook.com/${this.config.graphVersion}/${this.config.senderId}/messages`;
    const body =
      this.config.product === 'whatsapp'
        ? this.whatsAppBody(to, message)
        : this.messengerBody(to, message);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.error(`Meta send failed (network)`, err as Error);
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Meta send failed: ${res.status} ${text}`);
    }
  }

  private whatsAppBody(to: string, message: OutboundChatMessage): Record<string, unknown> {
    if (message.buttons?.length) {
      return {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: message.text },
          action: {
            buttons: message.buttons.slice(0, 3).map((b) => ({
              type: 'reply',
              reply: { id: b.payload, title: b.label.slice(0, 20) },
            })),
          },
        },
      };
    }
    return { messaging_product: 'whatsapp', to, type: 'text', text: { body: message.text } };
  }

  private messengerBody(to: string, message: OutboundChatMessage): Record<string, unknown> {
    if (message.buttons?.length) {
      return {
        recipient: { id: to },
        message: {
          text: message.text,
          quick_replies: message.buttons.slice(0, 13).map((b) => ({
            content_type: 'text',
            title: b.label.slice(0, 20),
            payload: b.payload,
          })),
        },
      };
    }
    return { recipient: { id: to }, message: { text: message.text } };
  }
}
