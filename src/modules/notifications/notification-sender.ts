import type { NotificationChannel } from '@prisma/client';

/** DI token for the pluggable notification transport. */
export const NOTIFICATION_SENDER = Symbol('NOTIFICATION_SENDER');

/**
 * Template key of the buyer delivery-confirmation OTP. Lives here (not in the
 * service) so a transport can tell an OTP apart from every other message without
 * importing the service.
 */
export const OTP_TEMPLATE_KEY = 'otp.delivery_confirmation';

/** A single outbound message handed to a transport (SMS/WhatsApp/email/...). */
export interface OutboundMessage {
  channel: NotificationChannel;
  /** Destination address (phone number / WhatsApp id / email). */
  to: string;
  /** Template identifier the transport renders. */
  templateKey: string;
  /** Template variables. May contain a sensitive OTP `code` — never persist this. */
  data: Record<string, unknown>;
}

/**
 * Pluggable transport seam. The default {@link LogNotificationSender} is a stub;
 * a real provider (Termii / Twilio / WhatsApp Cloud API) implements this same
 * interface and is bound to {@link NOTIFICATION_SENDER} in the module. Delivery
 * runs in the worker, never in an HTTP request.
 */
export interface NotificationSender {
  send(message: OutboundMessage): Promise<void>;
}
