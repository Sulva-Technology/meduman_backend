# EaaS Slice 2 — Outbound signed webhooks — design spec

Status: approved design, 2026-08-08. Builds on EaaS Slice 1 (merged to main:
`docs/superpowers/specs/2026-08-07-escrow-as-a-service-design.md`).

## Problem

A merchant integrating our escrow via `/v1` (Slice 1) can create and read
transactions, but has no way to be **told** when state changes — when a buyer's
payment is protected, when funds are released to their seller, when a dispute
opens. Today we only *receive* Paystack webhooks; we *emit* nothing. Without
outbound events a merchant must poll, and cannot reliably drive their own
fulfillment/inventory off escrow state.

Slice 2 delivers **signed, at-least-once outbound webhooks** to each merchant's
own endpoint, produced reliably (never lost) and scoped strictly to that
merchant's transactions.

## Locked decisions

- **Emission = transactional outbox.** The event row is written in the SAME
  Prisma `$transaction` as the state change; a worker/cron drains and delivers.
  A funds-released event can never be lost even if Redis/delivery is down.
- **Config = self-serve `/v1`, one endpoint per merchant.** The merchant sets
  its URL with its API key; the signing secret is returned **once** at creation.
- **Signing secret at rest = AES-256-GCM encrypted** (keyed by a new
  `EAAS_WEBHOOK_SIGNING_KEY`); decrypted only to sign a delivery; never returned
  after creation.
- **SSRF policy:** private/loopback/link-local/cloud-metadata IP ranges are
  ALWAYS rejected. `https` required for a **live-mode** endpoint; `http`
  permitted for a **test-mode** endpoint (recorded on the endpoint at creation
  from the creating key's `livemode`). No redirects followed; connect/read
  timeout; response-size cap.

## Architecture

Follows Slice 1's pattern: everything new lives in `src/modules/merchants/`
(the tenant module) except the delivery worker registration (worker.ts) and the
drain cron (cron.ts). The domain services emit through a thin seam; delivery is
fully decoupled behind the queue.

### Data model (additive migration `20260808000000_eaas_outbound_webhooks`)

```prisma
enum WebhookEndpointStatus { ACTIVE  DISABLED }
enum OutboundEventStatus   { PENDING  DELIVERED  FAILED }

model WebhookEndpoint {
  id            String @id @default(uuid()) @db.Uuid
  merchantId    String @unique @db.Uuid          // one endpoint per merchant
  merchant      Merchant @relation(fields: [merchantId], references: [id], onDelete: Cascade)
  url           String
  /// AES-256-GCM ciphertext of the whsec_ secret (iv:tag:ct hex). Never returned.
  secretEnc     String
  /// https required when true (live); http permitted when false (test).
  livemode      Boolean
  status        WebhookEndpointStatus @default(ACTIVE)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@map("webhook_endpoints")
}

model OutboundEvent {
  id           String @id @default(uuid()) @db.Uuid  // sent to merchant as event id
  merchantId   String @db.Uuid
  type         String                                 // e.g. "funds.released"
  payload      Json
  status       OutboundEventStatus @default(PENDING)
  attemptCount Int      @default(0)
  lastError    String?
  deliveredAt  DateTime?
  createdAt    DateTime @default(now())
  @@index([status, createdAt])   // drain scan
  @@index([merchantId, createdAt]) // merchant delivery-log read
  @@map("outbound_events")
}
```

`Merchant` gains `webhookEndpoint WebhookEndpoint?` reverse relation. No column
on `Transaction`/`Payout` — the outbox row carries `merchantId`, copied from the
transaction at emit time.

### Emission — the outbox seam

`OutboundEventService.enqueue(db, input)` (where `db` is the active
`Prisma.TransactionClient`) inserts one `OutboundEvent` row. It is called
**inside** the existing `$transaction` blocks so the event commits atomically
with the state change:

- `TransactionsService.apply` — after the status write, map the driving event to
  an outbound type and enqueue **only when `tx.merchantId` is non-null**:
  `PAYMENT_VERIFIED → transaction.protected`, `CANCEL → transaction.cancelled`,
  `RESOLVE_DISPUTE_FOR_SELLER`/`RESOLVE_DISPUTE_FOR_BUYER → dispute.resolved`.
  (Other transitions emit nothing in Slice 2.)
- `PayoutsService.markPaid` — inside its completion `$transaction`, enqueue
  `funds.released` (merchantId from the payout/transaction).
- `DisputesService.raise` — inside its `$transaction`, enqueue `dispute.opened`
  when the transaction has a `merchantId`.

The payload is a lean, merchant-facing projection built by a pure
`buildEventPayload(type, tx, extra?)` — no internal secrets, no first-party
buyer auth id; only `{ transactionId, status, amount, currency, ... }` the
merchant already sees via `/v1`. After the transaction commits, the caller
enqueues a BullMQ delivery job for the new event id (fast path); if that enqueue
throws (Redis down) it is swallowed — the cron drain is the safety net.

### Delivery — decoupled worker + cron drain

- New BullMQ `webhook-out` queue (registered in `queue/`, faked in e2e like the
  others). `worker.ts` runs a `WebhookDeliveryProcessor`.
- `WebhookDeliveryService.deliver(eventId)`:
  1. Load the `OutboundEvent` (skip if already `DELIVERED` — idempotent).
  2. Load the merchant's `ACTIVE` `WebhookEndpoint`; if none, mark the event
     `FAILED` with "no endpoint" (nothing to deliver to) — do not retry forever.
  3. Validate the URL through the SSRF guard (again, at send time).
  4. Decrypt the secret, sign, POST with a timeout + size cap, no redirects.
  5. 2xx → `DELIVERED` (+ `deliveredAt`); non-2xx / network error → throw so
     BullMQ retries (5× exponential); on final failure the processor marks the
     event `FAILED` with `lastError`. `attemptCount` incremented each try.
- `cron.ts` → `OutboundEventRelay.scanPending()` finds `PENDING` rows older than
  a small grace window and re-enqueues their delivery jobs (recovers events
  whose fast-path enqueue was lost). Idempotent: delivery skips already-DELIVERED.

### Signing

`X-Meduman-Event-Id: <uuid>` and
`X-Meduman-Signature: t=<unixSeconds>,v1=<hex hmac_sha256(`t.rawBody`, secret)>`.
Pure `signPayload(secret, timestamp, rawBody)` in `webhook-signing.ts`,
unit-tested. The secret is the decrypted `whsec_...`.

### Secret crypto

`webhook-secret.crypto.ts` (pure): `generateWebhookSecret()` → `whsec_<hex>`;
`encryptSecret(plaintext, key)` → `iv:tag:ciphertext` hex (AES-256-GCM);
`decryptSecret(enc, key)` → plaintext. Key from `EAAS_WEBHOOK_SIGNING_KEY`
(zod `min(32)`). Mirrors the `api-key.crypto.ts` isolation-and-unit-test pattern.

### SSRF guard

`assertPublicUrl(rawUrl, { allowHttp })` in `webhook-ssrf.ts` (pure, unit-tested):
parse; scheme must be `https`, or `http` when `allowHttp`; resolve the host —
reject any literal or resolved address in private/loopback/link-local
(10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, fe80::/10) or
the cloud-metadata address `169.254.169.254`; reject hosts that are bare IPs in
those ranges and obvious internal names (`localhost`). Throw `BadRequestException`
on registration; at send time a failure marks the event `FAILED`.

### Endpoints (`/v1`, `ApiKeyGuard`, `@CurrentMerchant`)

- `POST /v1/webhook-endpoints` — body `{ url }`. The endpoint's `livemode` is
  taken from the calling key (`@CurrentMerchant().livemode`) and stored on the
  row; the SSRF guard runs with `allowHttp = !livemode` (test keys may register
  an http URL, live keys may not). Generates the secret, encrypts it, upserts the
  merchant's single endpoint. Returns `{ id, url, secret }` — the plaintext
  secret **once**.
- `GET /v1/webhook-endpoints` — `{ id, url, livemode, status, createdAt }`;
  never the secret.
- `POST /v1/webhook-endpoints/rotate-secret` — new secret, returned once.
- `DELETE /v1/webhook-endpoints` — set `DISABLED` (soft; delivery stops).
- `GET /v1/events?status=&cursor=&limit=` — merchant's `OutboundEvent` log, lean
  projection `{ id, type, status, attemptCount, createdAt, deliveredAt }`
  (no payload secrets; merchant-scoped by `merchantId`). Cursor pagination like
  Slice 1's list.

## Money-safety statement

No new money path. Emission is read-only w.r.t. money state — it only records
what already happened, inside the same transaction, so it cannot change or block
a release (if the outbox insert failed, the whole state transition rolls back,
which is the safe direction). Tenancy is enforced twice: events are emitted only
for transactions carrying a `merchantId`, and every `/v1` read is scoped by the
caller's merchant. Delivery holds no funds and cannot mutate state.

## Out of scope (later)

- Multiple endpoints / per-event-type subscriptions (Slice 1 spec's alt option).
- Merchant-visible manual "resend event" endpoint (the cron drain + retries
  cover reliability; manual replay is a Slice 3 ergonomics item).
- Signing-key rotation ceremony for `EAAS_WEBHOOK_SIGNING_KEY` itself.
- Payout/audit `merchantId` scoping endpoints (still deferred from Slice 1).

## Testing

**Unit**
- `webhook-secret.crypto`: encrypt→decrypt round-trips; different key fails;
  secret has `whsec_` prefix; ciphertext ≠ plaintext.
- `webhook-signing`: deterministic HMAC over `t.body`; wrong secret differs.
- `webhook-ssrf`: rejects loopback/private/link-local/metadata + `http` when
  `allowHttp=false`; allows a normal https host; allows http when `allowHttp=true`.
- `OutboundEventService.enqueue`: writes a row via the passed tx client; builds
  the lean payload; never enqueues when `merchantId` is null.
- `WebhookDeliveryService`: DELIVERED on 2xx; ret/throw on non-2xx; FAILED on no
  endpoint; skips already-DELIVERED (idempotent); SSRF rejection at send.
- `WebhookEndpointsService`: secret returned once, stored encrypted (not
  plaintext), rotate replaces, merchant-scoped.

**e2e (real Postgres, faked Paystack/auth/queue/http)**
- A `/v1` transaction (merchantId set) driven to PAYMENT_PROTECTED writes
  exactly ONE `OutboundEvent(type=transaction.protected, merchantId=A)`.
- A first-party transaction (merchantId null) driven the same way writes ZERO
  outbound events.
- `funds.released` is emitted exactly once on payout completion.
- Cross-tenant: merchant B's `GET /v1/events` never shows A's events.
- Delivery: a stubbed 2xx endpoint → event DELIVERED; a stubbed 500 → retried
  then FAILED with `lastError` (drive the processor directly, faking fetch).
