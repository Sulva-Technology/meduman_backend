/** BullMQ queue + job names and the DI tokens for the Redis/Queue providers. */
export const PAYOUT_QUEUE = 'payout';
export const RELEASE_JOB = 'release';

export const NOTIFICATION_QUEUE = 'notification';
export const OTP_NOTIFICATION_JOB = 'otp';
export const INVOICE_DELIVERY_JOB = 'invoice';

export const CHAT_QUEUE = 'chat';
/** An inbound chat message to run through the dialog (worker side). */
export const CHAT_INBOUND_JOB = 'inbound';
/** A push to a chat user (payment/payout/OTP status), resolved at delivery. */
export const CHAT_OUTBOUND_JOB = 'outbound';

export const WEBHOOK_OUT_QUEUE = 'webhook-out';
export const WEBHOOK_DELIVER_JOB = 'deliver';

/** DI token for the shared ioredis connection. */
export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');
/** DI token for the payout BullMQ Queue (producer side). */
export const PAYOUT_QUEUE_TOKEN = Symbol('PAYOUT_QUEUE');
/** DI token for the notification BullMQ Queue (producer side). */
export const NOTIFICATION_QUEUE_TOKEN = Symbol('NOTIFICATION_QUEUE');
/** DI token for the chat BullMQ Queue (producer side). */
export const CHAT_QUEUE_TOKEN = Symbol('CHAT_QUEUE');
/** DI token for the outbound-webhook BullMQ Queue (producer side). */
export const WEBHOOK_OUT_QUEUE_TOKEN = Symbol('WEBHOOK_OUT_QUEUE');

/** Payload of a release job: authorize+settle the payout for one transaction. */
export interface ReleaseJobData {
  transactionId: string;
}

/**
 * Payload of an OTP-delivery job. The plaintext `code` rides ONLY in this
 * transient job (removed on completion) — it is never written to Postgres. The
 * recorded Notification row carries non-secret metadata only.
 */
export interface OtpNotificationJobData {
  transactionId: string;
  otpId: string;
  code: string;
  purpose: string;
}

/** Payload of an invoice-delivery job. Carries no secrets — the worker re-loads
 *  the invoice and its public view id from Postgres. */
export interface InvoiceDeliveryJobData {
  invoiceId: string;
}

/**
 * A normalized inbound chat message, already parsed by an adapter, to be run
 * through the dialog in the worker. The raw provider id + platform let the
 * processor stay adapter-agnostic.
 */
export interface ChatInboundMediaJob {
  id: string;
  mimeType?: string;
  filename?: string;
  url?: string;
}

export interface ChatInboundJobData {
  platform: string;
  providerMessageId: string;
  from: string;
  displayName?: string;
  text?: string;
  payload?: string;
  media?: ChatInboundMediaJob[];
}

/**
 * An outbound push to a chat user, resolved to a ChatIdentity at delivery time.
 * `templateKey` selects the message body; `data` carries its variables. An OTP
 * push puts the plaintext `code` here — this job is transient (removeOnComplete),
 * so the code is never retained, exactly like the OTP-delivery job.
 */
export interface ChatOutboundJobData {
  userId: string;
  templateKey: string;
  data: Record<string, unknown>;
}

/** Payload of a webhook delivery job. The worker re-loads the event from Postgres. */
export interface WebhookDeliveryJobData {
  eventId: string;
}
