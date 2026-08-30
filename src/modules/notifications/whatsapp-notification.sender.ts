import { Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { maskRecipient, normalizeMsisdn } from './phone';
import {
  OTP_TEMPLATE_KEY,
  type NotificationSender,
  type OutboundMessage,
} from './notification-sender';

/** Cap on any provider text we surface in an error, so a Graph blob can't flood logs. */
const MAX_ERROR_TEXT = 300;

export interface WhatsAppSenderConfig {
  /** WABA/system-user access token. NEVER logged, never echoed in an error. */
  accessToken: string;
  /** WhatsApp Cloud API phone-number id (the sender). */
  phoneNumberId: string;
  graphVersion: string;
  /** Name of the APPROVED authentication template that carries the code. */
  otpTemplateName: string;
  /** Template language code, e.g. `en` or `en_US`. Must match the approved one. */
  otpTemplateLang: string;
  /**
   * Whether the approved template has the OTP button (copy-code / one-tap).
   * Authentication templates always do, and the code must be repeated in the
   * button component; a plain utility template has none.
   */
  otpTemplateHasButton: boolean;
  /** Country code assumed for national-form numbers (`0803...`). */
  defaultCountryCode: string;
}

/** Read the OTP out of the template variables without ever widening its type. */
function readCode(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/** Replace every occurrence of a secret with a marker. */
function replaceSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

/**
 * Real OTP transport: the WhatsApp Cloud API. Sends the buyer's delivery-
 * confirmation code as a pre-approved **authentication template** (business-
 * initiated messages outside the 24h customer-service window must be templated),
 * mirroring the Graph call shape already used by {@link MetaAdapter}.
 *
 * Message safety: the plaintext code goes into the outbound HTTP body and
 * nowhere else. It is never logged, never persisted, and is scrubbed out of any
 * provider error text before that text is thrown. Recipients are logged masked
 * and the access token is never logged at all. A send failure throws so BullMQ
 * retries under the existing notification policy.
 *
 * Anything that is not the OTP template (today: invoice email) is delegated
 * untouched to the fallback transport — there is no approved WhatsApp template
 * behind it.
 */
export class WhatsAppNotificationSender implements NotificationSender {
  private readonly logger = new Logger(WhatsAppNotificationSender.name);

  constructor(
    private readonly config: WhatsAppSenderConfig,
    /** Handles every message this transport has no approved template for. */
    private readonly fallback: NotificationSender,
  ) {}

  async send(message: OutboundMessage): Promise<void> {
    if (message.channel === NotificationChannel.EMAIL || message.templateKey !== OTP_TEMPLATE_KEY) {
      return this.fallback.send(message);
    }

    const code = readCode(message.data.code);
    // No code = nothing to template. Fail loudly WITHOUT quoting the payload.
    if (!code) throw new Error('WhatsApp OTP send aborted: message carries no code');

    // Throws (with no number in the message) rather than dialing a wrong handset.
    const to = normalizeMsisdn(message.to, this.config.defaultCountryCode);
    const url = `https://graph.facebook.com/${this.config.graphVersion}/${this.config.phoneNumberId}/messages`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.otpTemplateBody(to, code)),
      });
    } catch (err) {
      // Message only — never the error object: it can carry the request body.
      this.logger.error(
        `WhatsApp OTP send failed (network) -> ${maskRecipient(to)}: ${
          err instanceof Error ? this.scrub(err.message, code) : 'unknown error'
        }`,
      );
      throw new Error('WhatsApp OTP send failed (network)');
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`WhatsApp OTP send failed: ${res.status} ${this.scrub(text, code)}`.trim());
    }

    this.logger.log(
      `WhatsApp OTP template ${this.config.otpTemplateName} -> ${maskRecipient(to)} sent`,
    );
  }

  /**
   * Make provider text safe to throw or log. A thrown message ends up in BullMQ's
   * `failedReason` and in Sentry, and the Graph API echoes request parameters in
   * some error bodies — so the live OTP and the access token are stripped, and
   * the blob is clipped so it cannot flood the logs.
   */
  private scrub(text: string, code: string): string {
    return replaceSecret(
      replaceSecret(text.slice(0, MAX_ERROR_TEXT), code),
      this.config.accessToken,
    );
  }

  /**
   * Authentication-template send payload (WhatsApp Cloud API). The code goes in
   * the BODY parameter — what the user reads — and, when the template has the
   * OTP button, in the BUTTON parameter too (`sub_type: "url"`, `index: "0"`),
   * which is the value the copy-code / one-tap button actually hands back to the
   * app. Meta requires the two to be identical.
   */
  private otpTemplateBody(to: string, code: string): Record<string, unknown> {
    const components: Record<string, unknown>[] = [
      { type: 'body', parameters: [{ type: 'text', text: code }] },
    ];
    if (this.config.otpTemplateHasButton) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: code }],
      });
    }
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: this.config.otpTemplateName,
        language: { code: this.config.otpTemplateLang },
        components,
      },
    };
  }
}
