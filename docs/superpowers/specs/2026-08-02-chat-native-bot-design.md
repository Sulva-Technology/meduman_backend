# Chat-native bot gateway — design

**Date:** 2026-08-02
**Status:** Approved, slice 1 pending implementation

## Goal

Let a user complete a full protected transaction — create, invite, pay, confirm
delivery, receive payout — entirely inside a social-media chat account, without
visiting the Meduman website. The website stays an optional path, never a
required one.

The backend already owns the whole domain (state machine, payments, payouts,
OTP, disputes, storage, audit). The bot is a **new surface** on top of it, not a
new domain. Nothing in this design changes the six money-safety rules; the
design's main job is to add a conversational front door that cannot weaken them.

## Non-goals (slice 1)

- Disputes and photo evidence via chat (slice 2 — needs platform CDN media
  download + re-upload).
- Meta platforms (WhatsApp / Instagram / Messenger) — slice 2, blocked on Meta
  Business verification, not on code.
- X (Twitter) DMs — slice 3, blocked on a paid API tier.
- Any change to the website API. Existing endpoints keep working untouched.

## Platform strategy

The owner wants every social platform. Those platforms are not equivalent in
cost to reach:

| Platform | Transport | External gate |
| --- | --- | --- |
| Telegram | Bot API, `X-Telegram-Bot-Api-Secret-Token` | none — token in minutes |
| WhatsApp | Meta Graph, `X-Hub-Signature-256` | Meta Business verification + approved message templates |
| Instagram DM | Meta Graph (same webhook + send surface) | same verification, plus a linked professional account |
| Messenger | Meta Graph (same webhook + send surface) | same verification, plus a linked Page |
| X | Account Activity API | paid API tier |

So the architecture is **one platform-agnostic core plus thin adapters**, and
adapters ship in order of external gating. Telegram first proves the core end to
end with zero waiting; the Meta adapter then plugs into a core that is already
tested. WhatsApp, Instagram, and Messenger are a single adapter — they share one
webhook receiver and one send API, differing only in the id field and the
capability flags.

## Architecture

```
src/modules/chat/
  chat.module.ts
  adapters/
    chat-adapter.ts              # ChatAdapter interface + CHAT_ADAPTERS multi-token
    telegram/telegram.adapter.ts # slice 1
    meta/meta.adapter.ts         # slice 2 — WhatsApp + Instagram + Messenger
    x/x.adapter.ts               # slice 3
  gateway/
    chat-webhook.controller.ts   # POST /chat/:platform/webhook
    chat-inbound.service.ts      # signature -> dedupe -> enqueue -> 200
  identity/chat-identity.service.ts
  session/chat-session.service.ts
  dialog/
    chat-dialog.service.ts       # step machine
    steps/*.ts                   # one file per step handler
  outbound/chat-notification.sender.ts
```

### The adapter seam

```ts
export interface InboundChatMessage {
  platform: ChatPlatform;
  providerMessageId: string;   // dedupe key
  from: string;                // platform user id
  displayName?: string;
  text?: string;
  /** Set when the user tapped a button rather than typing. */
  payload?: string;
}

export interface OutboundChatMessage {
  text: string;
  buttons?: { label: string; payload: string }[];
}

export interface ChatAdapter {
  readonly platform: ChatPlatform;
  verifySignature(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;
  parse(body: unknown): InboundChatMessage[];
  send(to: string, msg: OutboundChatMessage): Promise<void>;
  readonly capabilities: { buttons: boolean; media: boolean };
}
```

Adapters are registered under a `CHAT_ADAPTERS` multi-provider token and resolved
by the `:platform` route param. An unknown platform is a 404, never a fallback.

When `capabilities.buttons` is false the dialog renders the same choices as a
numbered list and accepts the number as input. The dialog therefore never
branches on platform identity — only on capability.

### Request path

Inbound webhook handling is deliberately minimal:

1. Verify the adapter's signature over the **raw body**. Failure → 401, nothing
   persisted. (`main.ts` already enables `rawBody`; the chat routes reuse it and
   skip the global throttler exactly as the Paystack webhook route does.)
2. Insert a `ChatInboundEvent`. A unique violation on
   `(platform, providerMessageId)` means a re-delivery → return 200, do nothing.
   This mirrors the existing `WebhookEvent` dedupe.
3. Enqueue a `chat` BullMQ job and return 200 immediately.

All dialog work happens in the worker. Telegram and Meta both retry aggressively
when a webhook is slow, and a retried delivery that races the first one is
exactly how duplicated side effects get created. Answering fast and working
asynchronously removes that class of bug, and matches the existing rule that
long or retryable work never runs inside an HTTP request.

### Identity

`ChatIdentity` maps `(platform, platformUserId)` to a Meduman `User`. On first
contact `ChatIdentityService` mints a real Supabase auth user through the admin
API (`SUPABASE_SERVICE_ROLE_KEY`, already in the env schema) and then mirrors it
locally, so `User.id` keeps meaning "Supabase auth uuid" and a chat-born user can
later sign into the website with the same account.

Creation is idempotent: the unique index on `(platform, platformUserId)` is the
guard, and a lost race resolves by re-reading the winner's row rather than
creating a second auth user.

Supabase requires an email. Chat users may not have one, so identity creation
uses a deterministic synthetic address, `chat+<platform>-<platformUserId>@<CHAT_IDENTITY_EMAIL_DOMAIN>`,
recorded as unverified. When the user later supplies a real email the row is
updated; the synthetic address is never surfaced in chat.

### Session and dialog

`ChatSession` holds the conversational step and a draft JSON blob, one row per
identity, with an expiry. `ChatDialogService` is a step machine: given the
session step and the inbound message, it produces the next step, a persisted
draft mutation, and an outbound reply.

**The dialog never writes `TransactionStatus`.** Every state change goes through
the existing services — `TransactionsService.apply`, `PaymentsService`,
`OtpService` — so the state machine remains the single owner of transaction
state (rule 1) and every transition still writes its `TimelineEvent` and
`AuditLog` row (rule 6). The chat session is conversational state only; losing
it entirely would cost the user their place in a dialog and nothing else.

Audit rows raised from chat carry the originating platform and platform user id
in metadata, so an operator can trace an action back to the exact chat account.

### Outbound

`ChatNotificationSender` implements the existing `NotificationSender` interface
and is bound to `NOTIFICATION_SENDER`, replacing `LogNotificationSender`. It
resolves the user's `ChatIdentity` and dispatches through that platform's
adapter.

`NotificationsService.deliverOtpCode` currently hardcodes
`NotificationChannel.SMS` and `to = tx.buyer.phone`
(`src/modules/notifications/notifications.service.ts`). That becomes a
resolution step: prefer the buyer's `ChatIdentity` and its matching channel, fall
back to SMS-by-phone, and mark the notification `FAILED` when neither exists —
unroutable, as today. The plaintext code continues to ride only the transient
job; the persisted `Notification` row keeps carrying non-secret metadata only.

## Payment inside chat — dedicated virtual accounts

Hosted checkout would require a browser hop, which defeats the goal. Paystack
dedicated virtual accounts (DVA) let the bot print an account number in chat that
the buyer pays from their own bank app, with `charge.success` closing the loop.

**Paystack assigns a DVA per customer, not per transaction.** Matching an inbound
transfer by amount alone is ambiguous the moment one buyer has two open
transactions, and resolving that ambiguity wrongly would protect the wrong
transaction. So each transaction gets its own throwaway Paystack customer, and
therefore its own DVA. The mapping is then deterministic.

Flow:

1. `PaymentsService.initializeVirtualAccount(transactionId, buyerId)` drives
   `BUYER_INITIATE_CHECKOUT` through the machine (same as the existing hosted
   path), creates a Paystack customer, and requests a dedicated account.
2. DVA assignment is asynchronous. The `dedicatedaccount.assign.success` webhook
   stores the account number and bank on the `Payment` row. Until it arrives the
   bot tells the buyer the account is being prepared.
3. The bot posts account number, bank, and exact kobo amount in chat.
4. The buyer pays. Paystack fires `charge.success` with a **Paystack-generated**
   reference — not ours.

### Webhook resolution without weakening rules 2 or 4

`Payment.providerReference` stays `NOT NULL @unique` and keeps holding *our*
generated reference; a DVA payment gets one at creation time
(`mdn_dva_<uuid>`). A new nullable-unique `providerChargeReference` column holds
Paystack's reference once the charge exists.

On `charge.success`, `WebhooksService.route` resolves the payment by
`providerReference`; on a miss it falls back to resolving by
`data.customer.customer_code`. It then binds Paystack's reference onto that
payment with a conditional `updateMany` (`where: { id, providerChargeReference: null }`).
That write is the idempotency lock: a re-delivered webhook binds zero rows and
short-circuits, and the unique index makes a second binding impossible.

`verifyAndProtect` then runs unchanged in substance — a server-side
`/transaction/verify` against Paystack's reference, an exact amount match as a
hard stop, and only then the `PAYMENT_VERIFIED` transition with a trusted source.
The bot is never a trusted source. Rules 2 and 4 hold.

DVA requires Paystack to enable the feature on the account; it is NGN-only.

## Data model

One additive migration:

- `enum ChatPlatform { TELEGRAM WHATSAPP INSTAGRAM MESSENGER X }`
- `ChatIdentity` — `platform`, `platformUserId`, `userId`, `displayName`,
  `createdAt`; `@@unique([platform, platformUserId])`, `@@index([userId])`
- `ChatSession` — `chatIdentityId @unique`, `step`, `draft Json?`,
  `transactionId?`, `expiresAt`, timestamps
- `ChatInboundEvent` — `platform`, `providerMessageId`, `rawPayload`,
  `processedAt`, `processingResult`; `@@unique([platform, providerMessageId])`
- `NotificationChannel` += `TELEGRAM`, `INSTAGRAM`, `MESSENGER` (`WHATSAPP`
  already exists)
- `Payment` += `providerCustomerCode String?`,
  `providerDedicatedAccountId String?`, `providerChargeReference String? @unique`,
  `virtualAccountNumber String?`, `virtualAccountBank String?`

Existing columns are unchanged, so the migration is additive and safe to apply
to a populated database.

## New environment variables

Added to `src/config/env.validation.ts` (fail-fast at boot) and `.env.example`:

- `TELEGRAM_BOT_TOKEN` — optional; the Telegram adapter registers only when set,
  so an unconfigured deploy boots cleanly.
- `TELEGRAM_WEBHOOK_SECRET` — required when `TELEGRAM_BOT_TOKEN` is set,
  enforced as a cross-field check alongside the existing JWT-strategy checks.
- `CHAT_IDENTITY_EMAIL_DOMAIN` — domain for synthetic chat-user emails.
- `CHAT_SESSION_TTL_SECONDS` — default 3600.

`SUPABASE_SERVICE_ROLE_KEY` already exists and needs no change.

## Error handling

- Bad signature → 401, nothing persisted, nothing enqueued.
- Duplicate inbound message → 200, no dialog run.
- Unknown platform → 404.
- Adapter send failure → BullMQ retry with exponential backoff, same as OTP
  delivery today.
- A rejected transition (`TransitionRejectedError`) becomes a plain-language chat
  reply, never a stack trace, and the session step is left untouched so the user
  can retry.
- Supabase admin `createUser` failure → the dialog replies that signup failed and
  the job retries; no partial `ChatIdentity` row is written.
- DVA not yet assigned when the buyer asks to pay → the bot says the account is
  being prepared and re-sends once `dedicatedaccount.assign.success` lands.

## Testing

Unit:

- Telegram adapter: signature verify (valid, invalid, missing), parse of text and
  button payloads.
- Inbound dedupe: second delivery of the same `providerMessageId` does not enqueue.
- `ChatIdentityService`: repeated first contact creates exactly one auth user and
  one identity row.
- `ChatDialogService`: each step transition, plus a rejected-transition reply.
- Notification channel resolution: chat identity preferred, phone fallback,
  unroutable marked `FAILED`.
- DVA reference binding: second `charge.success` binds nothing.

e2e, in a new `test/chat-money-safety.e2e-spec.ts` reusing the existing
`test/utils/` harness and Postgres gate (a new file rather than additions to
`money-safety.e2e-spec.ts`, so the existing suite stays untouched):

- A bot message alone can never move a transaction to `PAYMENT_PROTECTED`.
- A DVA `charge.success` whose amount differs from the expected kobo amount never
  protects.
- A duplicate inbound chat message never produces a second side effect.

Definition of done for slice 1: `npm run lint && npm run build && npm test` clean,
e2e green against local Postgres, and no existing test modified to accommodate
the new code.

## Slices

1. **Slice 1 (this build):** migration, gateway core, adapter interface, Telegram
   adapter, identity, session, full happy-path dialog, DVA payment path, outbound
   sender binding, tests.
2. **Slice 2:** Meta adapter (WhatsApp + Instagram + Messenger), chat disputes and
   photo evidence. Gated on Meta Business verification.
3. **Slice 3:** X adapter. Gated on a paid API tier.

## External prerequisites (not code)

- A Telegram bot token from BotFather, and its webhook pointed at
  `POST /chat/telegram/webhook`.
- DVA enabled on the Paystack account.
- Paystack "Transfers OTP" **disabled**, as the existing readiness doc already
  requires — otherwise automated release stalls regardless of surface.
