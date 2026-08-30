# EaaS Slice 2 — Outbound signed webhooks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver signed, at-least-once outbound webhooks to each merchant's own endpoint when their escrow transactions change state, produced via a transactional outbox so no event is ever lost.

**Architecture:** Events are written to an `OutboundEvent` outbox row **inside the same `$transaction`** as the state change, from a single wiring point in `TransactionsService.apply` (every target event — protected/cancelled/dispute.opened/dispute.resolved/funds.released — flows through `apply`). A decoupled `outbound-events/` module owns the emit seam + queue dispatch; the `merchants/` module owns endpoint config, signing, SSRF, and delivery. A BullMQ `webhook-out` worker delivers; a cron relay re-dispatches any stranded `PENDING` row.

**Tech Stack:** NestJS + TypeScript strict, Prisma (Supabase Postgres), BullMQ + Redis, Node `crypto` (AES-256-GCM + HMAC-SHA256), Jest, e2e vs real Postgres.

## Global Constraints

- No new money path. Emission is read-only w.r.t. money state; the outbox insert is atomic with the state change (if it fails, the transition rolls back — the safe direction).
- Tenancy is money-safety-critical: emit **only** when the transaction's `merchantId` is non-null (first-party events never leave the platform); every `/v1` read is scoped by the caller's `merchantId`.
- Signing secret is stored **AES-256-GCM encrypted** (key `EAAS_WEBHOOK_SIGNING_KEY`), decrypted only to sign, **never returned after creation**.
- SSRF: always reject private/loopback/link-local/cloud-metadata addresses; `https` required for a live-mode endpoint, `http` allowed for a test-mode endpoint (recorded on the endpoint from the creating key's `livemode`). No redirects; timeout + response-size cap.
- Money is integer minor units (kobo). TypeScript strict. Path alias `@/*` → `src/*`. Test output pristine.
- No dependency cycle: `transactions → outbound-events`; `merchants → transactions, outbound-events`; `outbound-events → prisma, queue` only.
- Verify before "done": `npm run lint && npm run build && npm test`.

---

### Task 1: Schema — `WebhookEndpoint`, `OutboundEvent`, enums + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260808000000_eaas_outbound_webhooks/migration.sql`

**Interfaces:**
- Produces: models `WebhookEndpoint`, `OutboundEvent`; enums `WebhookEndpointStatus`, `OutboundEventStatus`; `Merchant.webhookEndpoint` reverse relation.

- [ ] **Step 1: Add to `prisma/schema.prisma`** (enums near the other enums; models near `MerchantApiKey`; add the reverse relation to `Merchant`).

```prisma
enum WebhookEndpointStatus {
  ACTIVE
  DISABLED
}

enum OutboundEventStatus {
  PENDING
  DELIVERED
  FAILED
}

/// A merchant's single outbound-webhook destination. Secret is AES-GCM encrypted.
model WebhookEndpoint {
  id         String                @id @default(uuid()) @db.Uuid
  merchantId String                @unique @db.Uuid
  merchant   Merchant              @relation(fields: [merchantId], references: [id], onDelete: Cascade)
  url        String
  /// AES-256-GCM ciphertext of the whsec_ secret ("iv:tag:ciphertext" hex). Never returned.
  secretEnc  String
  /// https required when true (live key registered it); http permitted when false (test).
  livemode   Boolean
  status     WebhookEndpointStatus @default(ACTIVE)
  createdAt  DateTime              @default(now())
  updatedAt  DateTime              @updatedAt

  @@map("webhook_endpoints")
}

/// Transactional outbox row + delivery log for one outbound event.
model OutboundEvent {
  id           String              @id @default(uuid()) @db.Uuid
  merchantId   String              @db.Uuid
  type         String
  payload      Json
  status       OutboundEventStatus @default(PENDING)
  attemptCount Int                 @default(0)
  lastError    String?
  deliveredAt  DateTime?
  createdAt    DateTime            @default(now())

  @@index([status, createdAt])
  @@index([merchantId, createdAt])
  @@map("outbound_events")
}
```

Add to `model Merchant` (in the relations block): `webhookEndpoint WebhookEndpoint?`.

- [ ] **Step 2: Author the migration SQL** (offline, additive — mirror the Slice 1 migration style).

`prisma/migrations/20260808000000_eaas_outbound_webhooks/migration.sql`:
```sql
-- CreateEnum
CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "OutboundEventStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbound_events" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboundEventStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outbound_events_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "webhook_endpoints_merchantId_key" ON "webhook_endpoints"("merchantId");
CREATE INDEX "outbound_events_status_createdAt_idx" ON "outbound_events"("status", "createdAt");
CREATE INDEX "outbound_events_merchantId_createdAt_idx" ON "outbound_events"("merchantId", "createdAt");

-- Foreign keys
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3:** `npm run prisma:generate` → succeeds, new types available.
- [ ] **Step 4:** Apply to local test DB. Start Docker Postgres if needed (`docker compose up -d postgres`), then apply with `npx prisma migrate deploy` (env from `.env.test`; the `npm run db:migrate:test` wrapper hits a known Windows `spawnSync npx.cmd EINVAL` bug — use `migrate deploy` directly). Confirm `migrate status` clean.
- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260808000000_eaas_outbound_webhooks
git commit -m "feat(eaas): WebhookEndpoint + OutboundEvent models, outbound-webhooks migration"
```

---

### Task 2: Config — `EAAS_WEBHOOK_SIGNING_KEY` + delivery tunables

**Files:**
- Modify: `src/config/env.validation.ts`
- Modify: `.env.test`

**Interfaces:**
- Produces: `config.get('EAAS_WEBHOOK_SIGNING_KEY')` (string, min 32); `WEBHOOK_DELIVERY_TIMEOUT_MS` (number, default 5000); `WEBHOOK_MAX_ATTEMPTS` (number, default 5).

- [ ] **Step 1: Add to the zod schema** (near `EAAS_API_KEY_SECRET`):

```ts
  EAAS_WEBHOOK_SIGNING_KEY: z.string().min(32),
  WEBHOOK_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
```

- [ ] **Step 2: Add to `.env.test`**

```
EAAS_WEBHOOK_SIGNING_KEY=test-eaas-webhook-signing-key-0000000000
```

- [ ] **Step 3:** `npm run build` → PASS.
- [ ] **Step 4: Commit**

```bash
git add src/config/env.validation.ts .env.test
git commit -m "feat(eaas): EAAS_WEBHOOK_SIGNING_KEY + webhook delivery tunables"
```

---

### Task 3: `webhook-secret.crypto.ts` — AES-256-GCM secret at rest (pure, TDD)

**Files:**
- Create: `src/modules/merchants/webhook-secret.crypto.ts`
- Test: `src/modules/merchants/webhook-secret.crypto.spec.ts`

**Interfaces:**
- Produces:
  - `generateWebhookSecret(): string` — `whsec_<40 hex>`.
  - `encryptSecret(plaintext: string, key: string): string` — `"<iv hex>:<tag hex>:<ciphertext hex>"` (AES-256-GCM; 32-byte key derived by sha256 of the env key).
  - `decryptSecret(enc: string, key: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { decryptSecret, encryptSecret, generateWebhookSecret } from './webhook-secret.crypto';

const KEY = 'unit-webhook-signing-key-000000000000';

describe('webhook-secret.crypto', () => {
  it('generates a whsec_-prefixed secret, unique per call', () => {
    const a = generateWebhookSecret();
    expect(a.startsWith('whsec_')).toBe(true);
    expect(a).not.toEqual(generateWebhookSecret());
  });

  it('round-trips encrypt→decrypt with the same key', () => {
    const secret = generateWebhookSecret();
    const enc = encryptSecret(secret, KEY);
    expect(enc).not.toContain(secret); // ciphertext, not plaintext
    expect(enc.split(':')).toHaveLength(3);
    expect(decryptSecret(enc, KEY)).toBe(secret);
  });

  it('fails to decrypt with a different key', () => {
    const enc = encryptSecret('whsec_abc', KEY);
    expect(() => decryptSecret(enc, 'a-different-key-000000000000000000')).toThrow();
  });
});
```

- [ ] **Step 2:** `npm test -- webhook-secret.crypto` → FAIL (module not found).
- [ ] **Step 3: Implement**

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 32-byte AES key derived from the configured secret string. */
function deriveKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

/** A fresh signing secret shared with the merchant. Returned once, then encrypted. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(20).toString('hex')}`;
}

/** AES-256-GCM. Output "iv:tag:ciphertext" hex. Never store the plaintext. */
export function encryptSecret(plaintext: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decryptSecret(enc: string, key: string): string {
  const [ivHex, tagHex, ctHex] = enc.split(':');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(key), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString(
    'utf8',
  );
}
```

- [ ] **Step 4:** `npm test -- webhook-secret.crypto` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/modules/merchants/webhook-secret.crypto.ts src/modules/merchants/webhook-secret.crypto.spec.ts
git commit -m "feat(eaas): AES-256-GCM webhook signing-secret at rest"
```

---

### Task 4: `webhook-signing.ts` — HMAC signature (pure, TDD)

**Files:**
- Create: `src/modules/merchants/webhook-signing.ts`
- Test: `src/modules/merchants/webhook-signing.spec.ts`

**Interfaces:**
- Produces:
  - `signPayload(secret: string, timestampSeconds: number, rawBody: string): string` — hex HMAC-SHA256 of `"${timestampSeconds}.${rawBody}"`.
  - `buildSignatureHeader(secret: string, timestampSeconds: number, rawBody: string): string` — `"t=<ts>,v1=<hex>"`.

- [ ] **Step 1: Write the failing test**

```ts
import { buildSignatureHeader, signPayload } from './webhook-signing';

describe('webhook-signing', () => {
  it('signs over "timestamp.body" deterministically', () => {
    const s1 = signPayload('whsec_x', 1000, '{"a":1}');
    const s2 = signPayload('whsec_x', 1000, '{"a":1}');
    expect(s1).toEqual(s2);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with secret, timestamp, or body', () => {
    const base = signPayload('whsec_x', 1000, 'b');
    expect(signPayload('whsec_y', 1000, 'b')).not.toEqual(base);
    expect(signPayload('whsec_x', 1001, 'b')).not.toEqual(base);
    expect(signPayload('whsec_x', 1000, 'c')).not.toEqual(base);
  });

  it('builds a t=,v1= header', () => {
    const header = buildSignatureHeader('whsec_x', 1000, 'b');
    expect(header).toBe(`t=1000,v1=${signPayload('whsec_x', 1000, 'b')}`);
  });
});
```

- [ ] **Step 2:** `npm test -- webhook-signing` → FAIL.
- [ ] **Step 3: Implement**

```ts
import { createHmac } from 'node:crypto';

/** HMAC-SHA256 over "<timestamp>.<rawBody>", hex. The merchant recomputes to verify. */
export function signPayload(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
}

/** Stripe-style signature header value. */
export function buildSignatureHeader(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return `t=${timestampSeconds},v1=${signPayload(secret, timestampSeconds, rawBody)}`;
}
```

- [ ] **Step 4:** `npm test -- webhook-signing` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/modules/merchants/webhook-signing.ts src/modules/merchants/webhook-signing.spec.ts
git commit -m "feat(eaas): webhook HMAC signing (t.body, X-Meduman-Signature)"
```

---

### Task 5: `webhook-ssrf.ts` — SSRF guard (pure, TDD)

**Files:**
- Create: `src/modules/merchants/webhook-ssrf.ts`
- Test: `src/modules/merchants/webhook-ssrf.spec.ts`

**Interfaces:**
- Produces: `assertPublicUrl(rawUrl: string, opts: { allowHttp: boolean }): void` — throws `BadRequestException` on a disallowed scheme or a host that is a literal private/loopback/link-local/metadata IP or `localhost`.

Note: this is a static, allocation-free guard on the URL string and any literal IP host. It does NOT do DNS resolution (a resolve-time check also runs implicitly because the delivery `fetch` in Task 10 disables redirects and times out); DNS-rebind hardening is a documented follow-up, not this task.

- [ ] **Step 1: Write the failing test**

```ts
import { BadRequestException } from '@nestjs/common';
import { assertPublicUrl } from './webhook-ssrf';

describe('assertPublicUrl', () => {
  it('allows a normal https URL', () => {
    expect(() => assertPublicUrl('https://hooks.example.com/x', { allowHttp: false })).not.toThrow();
  });

  it('rejects http when allowHttp is false, allows it when true', () => {
    expect(() => assertPublicUrl('http://hooks.example.com', { allowHttp: false })).toThrow(
      BadRequestException,
    );
    expect(() => assertPublicUrl('http://hooks.example.com', { allowHttp: true })).not.toThrow();
  });

  it('rejects loopback, private, link-local, and metadata hosts', () => {
    for (const url of [
      'https://127.0.0.1/x',
      'https://localhost/x',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://169.254.169.254/latest/meta-data',
      'https://[::1]/x',
    ]) {
      expect(() => assertPublicUrl(url, { allowHttp: true })).toThrow(BadRequestException);
    }
  });

  it('rejects a non-URL', () => {
    expect(() => assertPublicUrl('not a url', { allowHttp: true })).toThrow(BadRequestException);
  });
});
```

- [ ] **Step 2:** `npm test -- webhook-ssrf` → FAIL.
- [ ] **Step 3: Implement**

```ts
import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';

/** Reject a URL that could target our own network (SSRF). Scheme + literal-IP host checks. */
export function assertPublicUrl(rawUrl: string, opts: { allowHttp: boolean }): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Invalid webhook URL');
  }

  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new BadRequestException('Webhook URL must use https');
  }

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new BadRequestException('Webhook URL host is not permitted');
  }

  // Strip IPv6 brackets for isIP.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const family = isIP(bare);
  if (family && isPrivateAddress(bare, family)) {
    throw new BadRequestException('Webhook URL host is not permitted');
  }
}

function isPrivateAddress(addr: string, family: number): boolean {
  if (family === 6) {
    const a = addr.toLowerCase();
    return a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80');
  }
  const [o0, o1] = addr.split('.').map((n) => Number.parseInt(n, 10));
  if (o0 === 10 || o0 === 127) return true;
  if (o0 === 169 && o1 === 254) return true; // link-local + 169.254.169.254 metadata
  if (o0 === 192 && o1 === 168) return true;
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return true;
  return false;
}
```

- [ ] **Step 4:** `npm test -- webhook-ssrf` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/modules/merchants/webhook-ssrf.ts src/modules/merchants/webhook-ssrf.spec.ts
git commit -m "feat(eaas): SSRF guard for merchant webhook URLs"
```

---

### Task 6: Queue — `webhook-out` queue token, registration, enqueue

**Files:**
- Modify: `src/modules/queue/queue.constants.ts`
- Modify: `src/modules/queue/queue.module.ts`
- Modify: `src/modules/queue/queue.service.ts`

**Interfaces:**
- Produces:
  - constants `WEBHOOK_OUT_QUEUE = 'webhook-out'`, `WEBHOOK_DELIVER_JOB = 'deliver'`, `WEBHOOK_OUT_QUEUE_TOKEN = Symbol('WEBHOOK_OUT_QUEUE')`, `interface WebhookDeliveryJobData { eventId: string }`.
  - `QueueService.enqueueWebhookDelivery(eventId: string): Promise<void>`.
  - The token is exported from `QueueModule` and closed on shutdown.

- [ ] **Step 1: Add constants** to `queue.constants.ts`:

```ts
export const WEBHOOK_OUT_QUEUE = 'webhook-out';
export const WEBHOOK_DELIVER_JOB = 'deliver';
export const WEBHOOK_OUT_QUEUE_TOKEN = Symbol('WEBHOOK_OUT_QUEUE');

/** Payload of a webhook delivery job. The worker re-loads the event from Postgres. */
export interface WebhookDeliveryJobData {
  eventId: string;
}
```

- [ ] **Step 2: Register the queue** in `queue.module.ts`: add a provider for `WEBHOOK_OUT_QUEUE_TOKEN` mirroring the `PAYOUT_QUEUE_TOKEN` factory (new `Queue(WEBHOOK_OUT_QUEUE, { connection, prefix })`), add the token to `exports`, inject it in the constructor, and `await this.webhookOutQueue.close()` in `onApplicationShutdown`. Import the new constants.

- [ ] **Step 3: Add the producer method** to `queue.service.ts` (inject the new token):

```ts
  @Inject(WEBHOOK_OUT_QUEUE_TOKEN)
  private readonly webhookOutQueue!: Queue<WebhookDeliveryJobData>;

  /** Enqueue delivery of one outbound event. jobId dedupes repeat enqueues of the
   *  same event; retries with backoff. removeOnFail keeps dead jobs for inspection. */
  async enqueueWebhookDelivery(eventId: string): Promise<void> {
    await this.webhookOutQueue.add(
      WEBHOOK_DELIVER_JOB,
      { eventId },
      {
        jobId: `webhook:${eventId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
```
(Constructor-inject the token instead of a property if the file uses constructor injection — match the existing style; the file currently constructor-injects the other queue tokens, so add `@Inject(WEBHOOK_OUT_QUEUE_TOKEN) private readonly webhookOutQueue: Queue<WebhookDeliveryJobData>` to the constructor.)

- [ ] **Step 4:** `npm run build` → PASS. Add a focused test to `queue.service.spec.ts` if one exists (mirror an existing enqueue test) asserting `add` is called with `jobId: 'webhook:<id>'`; otherwise skip (covered by e2e).
- [ ] **Step 5: Update the e2e harness fake** — in `test/utils/e2e-harness.ts`, override `WEBHOOK_OUT_QUEUE_TOKEN` with `fakeQueue` (add to the `.overrideProvider(...)` chain, mirroring `PAYOUT_QUEUE_TOKEN`). Import the token. (Without this the e2e app fails to resolve the token.)
- [ ] **Step 6: Commit**

```bash
git add src/modules/queue/queue.constants.ts src/modules/queue/queue.module.ts src/modules/queue/queue.service.ts test/utils/e2e-harness.ts
git commit -m "feat(eaas): webhook-out BullMQ queue + enqueueWebhookDelivery"
```

---

### Task 7: `outbound-events/` module — emit seam + payload builder

**Files:**
- Create: `src/modules/outbound-events/outbound-event.builder.ts`
- Create: `src/modules/outbound-events/outbound-events.service.ts`
- Create: `src/modules/outbound-events/outbound-events.module.ts`
- Test: `src/modules/outbound-events/outbound-event.builder.spec.ts`
- Test: `src/modules/outbound-events/outbound-events.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; `QueueService.enqueueWebhookDelivery` (Task 6).
- Produces:
  - Pure `buildOutboundEvent(eventType: string, tx: OutboundTxView): { type: string; payload: OutboundPayload } | null` — maps a state-machine event type to an outbound event, or `null` if that transition emits nothing.
  - `OutboundTxView = { id: string; status: string; amount: number; currency: string; title: string; merchantId: string | null }`.
  - `OutboundEventsService.recordForTransition(db: Prisma.TransactionClient, eventType: string, tx: OutboundTxView): Promise<string | null>` — builds + inserts the `OutboundEvent` row (only when `tx.merchantId` set and the type maps), returns the new event id or null.
  - `OutboundEventsService.dispatch(eventId: string): Promise<void>` — enqueue delivery; swallow errors (cron relay is the net).
  - `OutboundEventsService.listForMerchant(merchantId, { status?, cursor?, limit? }): Promise<{ items; nextCursor }>` — lean projection `{ id, type, status, attemptCount, createdAt, deliveredAt }`.
  - `OutboundEventsModule` exports `OutboundEventsService`.

- [ ] **Step 1: Write the builder test**

```ts
import { buildOutboundEvent } from './outbound-event.builder';

const tx = {
  id: 't1', status: 'PAYMENT_PROTECTED', amount: 1000, currency: 'NGN', title: 'X', merchantId: 'm1',
};

describe('buildOutboundEvent', () => {
  it('maps PAYMENT_VERIFIED to transaction.protected with a lean payload', () => {
    const out = buildOutboundEvent('PAYMENT_VERIFIED', tx);
    expect(out?.type).toBe('transaction.protected');
    expect(out?.payload).toEqual({
      transactionId: 't1', status: 'PAYMENT_PROTECTED', amount: 1000, currency: 'NGN', title: 'X',
    });
  });

  it('maps the money + dispute transitions', () => {
    expect(buildOutboundEvent('PAYOUT_SUCCEEDED', tx)?.type).toBe('funds.released');
    expect(buildOutboundEvent('CANCEL', tx)?.type).toBe('transaction.cancelled');
    expect(buildOutboundEvent('RAISE_DISPUTE', tx)?.type).toBe('dispute.opened');
    expect(buildOutboundEvent('RESOLVE_DISPUTE_FOR_SELLER', tx)?.type).toBe('dispute.resolved');
    expect(buildOutboundEvent('RESOLVE_DISPUTE_FOR_BUYER', tx)?.type).toBe('dispute.resolved');
  });

  it('returns null for transitions that emit nothing', () => {
    expect(buildOutboundEvent('SELLER_PUBLISH', tx)).toBeNull();
    expect(buildOutboundEvent('BUYER_CONFIRM', tx)).toBeNull();
  });
});
```

- [ ] **Step 2:** `npm test -- outbound-event.builder` → FAIL.
- [ ] **Step 3: Implement the builder**

```ts
export interface OutboundTxView {
  id: string;
  status: string;
  amount: number;
  currency: string;
  title: string;
  merchantId: string | null;
}

export interface OutboundPayload {
  transactionId: string;
  status: string;
  amount: number;
  currency: string;
  title: string;
}

const TYPE_MAP: Record<string, string> = {
  PAYMENT_VERIFIED: 'transaction.protected',
  CANCEL: 'transaction.cancelled',
  RAISE_DISPUTE: 'dispute.opened',
  RESOLVE_DISPUTE_FOR_SELLER: 'dispute.resolved',
  RESOLVE_DISPUTE_FOR_BUYER: 'dispute.resolved',
  PAYOUT_SUCCEEDED: 'funds.released',
};

/** Map a state-machine event to a merchant-facing outbound event, or null. */
export function buildOutboundEvent(
  eventType: string,
  tx: OutboundTxView,
): { type: string; payload: OutboundPayload } | null {
  const type = TYPE_MAP[eventType];
  if (!type) return null;
  return {
    type,
    payload: {
      transactionId: tx.id,
      status: tx.status,
      amount: tx.amount,
      currency: tx.currency,
      title: tx.title,
    },
  };
}
```

- [ ] **Step 4:** `npm test -- outbound-event.builder` → PASS.

- [ ] **Step 5: Write the service test**

```ts
import { OutboundEventsService } from './outbound-events.service';

const tx = { id: 't1', status: 'PAYMENT_PROTECTED', amount: 1000, currency: 'NGN', title: 'X', merchantId: 'm1' };

describe('OutboundEventsService.recordForTransition', () => {
  it('inserts an OutboundEvent via the tx client and returns its id', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'ev1' });
    const db = { outboundEvent: { create } } as any;
    const svc = new OutboundEventsService({} as any, { enqueueWebhookDelivery: jest.fn() } as any);
    const id = await svc.recordForTransition(db, 'PAYMENT_VERIFIED', tx);
    expect(id).toBe('ev1');
    expect(create.mock.calls[0][0].data).toMatchObject({ merchantId: 'm1', type: 'transaction.protected' });
  });

  it('returns null (no insert) when merchantId is null', async () => {
    const create = jest.fn();
    const db = { outboundEvent: { create } } as any;
    const svc = new OutboundEventsService({} as any, {} as any);
    const id = await svc.recordForTransition(db, 'PAYMENT_VERIFIED', { ...tx, merchantId: null });
    expect(id).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('returns null when the transition maps to no event', async () => {
    const create = jest.fn();
    const db = { outboundEvent: { create } } as any;
    const svc = new OutboundEventsService({} as any, {} as any);
    expect(await svc.recordForTransition(db, 'SELLER_PUBLISH', tx)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6:** `npm test -- outbound-events.service` → FAIL.
- [ ] **Step 7: Implement the service + module**

`outbound-events.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, OutboundEventStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { QueueService } from '@/modules/queue/queue.service';
import { buildOutboundEvent, type OutboundTxView } from './outbound-event.builder';

@Injectable()
export class OutboundEventsService {
  private readonly logger = new Logger(OutboundEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Write the outbox row INSIDE the caller's $transaction. Returns the event id or null. */
  async recordForTransition(
    db: Prisma.TransactionClient,
    eventType: string,
    tx: OutboundTxView,
  ): Promise<string | null> {
    if (!tx.merchantId) return null;
    const built = buildOutboundEvent(eventType, tx);
    if (!built) return null;
    const row = await db.outboundEvent.create({
      data: { merchantId: tx.merchantId, type: built.type, payload: built.payload },
    });
    return row.id;
  }

  /** Fast-path enqueue after commit. Swallow — the cron relay re-dispatches PENDING rows. */
  async dispatch(eventId: string): Promise<void> {
    try {
      await this.queue.enqueueWebhookDelivery(eventId);
    } catch (err) {
      this.logger.warn(`enqueue webhook delivery ${eventId} failed; relay will retry: ${String(err)}`);
    }
  }

  async listForMerchant(
    merchantId: string,
    opts: { status?: OutboundEventStatus; cursor?: string; limit?: number },
  ): Promise<{ items: Array<{ id: string; type: string; status: OutboundEventStatus; attemptCount: number; createdAt: Date; deliveredAt: Date | null }>; nextCursor: string | null }> {
    const take = opts.limit ?? 20;
    const rows = await this.prisma.outboundEvent.findMany({
      where: { merchantId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, take).map((r) => ({
      id: r.id, type: r.type, status: r.status, attemptCount: r.attemptCount,
      createdAt: r.createdAt, deliveredAt: r.deliveredAt,
    }));
    const last = items.at(-1);
    const nextCursor = rows.length > take && last ? last.id : null;
    return { items, nextCursor };
  }
}
```

`outbound-events.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { OutboundEventsService } from './outbound-events.service';

@Module({
  imports: [PrismaModule],
  providers: [OutboundEventsService],
  exports: [OutboundEventsService],
})
export class OutboundEventsModule {}
```
(`QueueModule` is `@Global`, so `QueueService` injects without importing it.)

- [ ] **Step 8:** `npm test -- outbound-events.service outbound-event.builder` → PASS. Register `OutboundEventsModule` in `app.module.ts` imports.
- [ ] **Step 9: Commit**

```bash
git add src/modules/outbound-events src/app.module.ts
git commit -m "feat(eaas): outbound-events emit seam + payload builder"
```

---

### Task 8: Wire emission into `TransactionsService.apply`

**Files:**
- Modify: `src/modules/transactions/transactions.service.ts`
- Modify: `src/modules/transactions/transactions.module.ts`
- Test: `src/modules/transactions/transactions.service.spec.ts` (add cases)

**Interfaces:**
- Consumes: `OutboundEventsService.recordForTransition` / `dispatch` (Task 7).
- Produces: `apply` writes an `OutboundEvent` in the same `$transaction` for a mapped, merchant-owned transition, then dispatches after commit. No signature change.

- [ ] **Step 1: Write the failing test** (add to the existing spec; use a mock OutboundEventsService).

```ts
describe('TransactionsService emits outbound events', () => {
  function build(outbound: any, txRow: any) {
    const db = {
      transaction: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ...txRow, status: 'PAYMENT_PROTECTED' }),
      },
      timelineEvent: { create: jest.fn() },
      auditLog: { create: jest.fn() },
      outboundEvent: { create: jest.fn().mockResolvedValue({ id: 'ev1' }) },
    };
    const prisma = {
      transaction: { findUnique: jest.fn().mockResolvedValue({ ...txRow, disputes: [] }) },
      $transaction: jest.fn(async (fn: any) => fn(db)),
    } as any;
    return { svc: new TransactionsService(prisma, outbound), db };
  }

  it('records + dispatches an event for a merchant-owned PAYMENT_VERIFIED', async () => {
    const outbound = {
      recordForTransition: jest.fn().mockResolvedValue('ev1'),
      dispatch: jest.fn().mockResolvedValue(undefined),
    };
    const txRow = { id: 't1', status: 'PAYMENT_PENDING', amount: 1000, currency: 'NGN', title: 'X', releaseRule: 'BUYER_CONFIRMATION', merchantId: 'm1' };
    const { svc } = build(outbound, txRow);
    await svc.apply({ transactionId: 't1', event: { type: 'PAYMENT_VERIFIED', source: 'WEBHOOK' } as any, actor: { type: 'SYSTEM' } });
    expect(outbound.recordForTransition).toHaveBeenCalled();
    expect(outbound.dispatch).toHaveBeenCalledWith('ev1');
  });

  it('does not dispatch when recordForTransition returns null (first-party/no map)', async () => {
    const outbound = {
      recordForTransition: jest.fn().mockResolvedValue(null),
      dispatch: jest.fn(),
    };
    const txRow = { id: 't1', status: 'PAYMENT_PENDING', amount: 1000, currency: 'NGN', title: 'X', releaseRule: 'BUYER_CONFIRMATION', merchantId: null };
    const { svc } = build(outbound, txRow);
    await svc.apply({ transactionId: 't1', event: { type: 'PAYMENT_VERIFIED', source: 'WEBHOOK' } as any, actor: { type: 'SYSTEM' } });
    expect(outbound.dispatch).not.toHaveBeenCalled();
  });
});
```
(Match the exact `event` shape the machine expects — check the existing spec's usage of `apply` for `PAYMENT_VERIFIED` and copy its event object, including any `source` field.)

- [ ] **Step 2:** `npm test -- transactions.service` → new cases FAIL (constructor arity / no emission).
- [ ] **Step 3: Implement.** Inject `OutboundEventsService` into `TransactionsService` (constructor). In `apply`, restructure the `$transaction` return so emission happens inside and dispatch after:

Replace `return this.prisma.$transaction(async (db) => { ... return db.transaction.findUniqueOrThrow(...); });` with:

```ts
    let outboundEventId: string | null = null;
    const result = await this.prisma.$transaction(async (db) => {
      // ... existing updateMany guard, timelineEvent.create, auditLog.create ...
      outboundEventId = await this.outbound.recordForTransition(db, event.type, {
        id: tx.id,
        status: nextState,
        amount: tx.amount,
        currency: tx.currency,
        title: tx.title,
        merchantId: tx.merchantId,
      });
      return db.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    });
    if (outboundEventId) {
      await this.outbound.dispatch(outboundEventId);
    }
    return result;
```
Keep every existing line inside the `$transaction` intact; only add the `recordForTransition` call before the final `findUniqueOrThrow` and move the `return` out as shown.

- [ ] **Step 4:** In `transactions.module.ts`, add `OutboundEventsModule` to `imports` (so `OutboundEventsService` injects). Confirm no cycle: `OutboundEventsModule` imports only Prisma + (global) Queue.
- [ ] **Step 5:** `npm test -- transactions.service` → all green (existing + new). Run the broader `npm test` to confirm no other suite that constructs `TransactionsService` broke (some specs `new TransactionsService(prisma)` — they must pass a stub outbound now; update those constructions to `new TransactionsService(prisma, { recordForTransition: async () => null, dispatch: async () => {} } as any)`). Grep: `new TransactionsService(` across `src` and `test` and fix each.
- [ ] **Step 6: Commit**

```bash
git add src/modules/transactions/transactions.service.ts src/modules/transactions/transactions.module.ts src/modules/transactions/transactions.service.spec.ts
git commit -m "feat(eaas): emit outbound events from the state-machine apply transaction"
```

---

### Task 9: `WebhookEndpointsService` + `/v1/webhook-endpoints` + `/v1/events`

**Files:**
- Create: `src/modules/merchants/webhook-endpoints.service.ts`
- Create: `src/modules/merchants/dto/set-webhook-endpoint.dto.ts`
- Create: `src/modules/merchants/v1-webhooks.controller.ts`
- Modify: `src/modules/merchants/merchants.module.ts`
- Test: `src/modules/merchants/webhook-endpoints.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; `ConfigService` (`EAAS_WEBHOOK_SIGNING_KEY`); `webhook-secret.crypto`; `webhook-ssrf`; `ApiKeyGuard` + `@CurrentMerchant`; `OutboundEventsService.listForMerchant`.
- Produces:
  - `WebhookEndpointsService.setEndpoint(merchantId, livemode, url): Promise<{ id: string; url: string; secret: string }>` — SSRF-validates (`allowHttp = !livemode`), generates + encrypts the secret, upserts (unique on merchantId), returns the plaintext secret ONCE.
  - `.get(merchantId): Promise<{ id; url; livemode; status; createdAt } | null>` — never the secret.
  - `.rotateSecret(merchantId): Promise<{ secret: string }>`.
  - `.disable(merchantId): Promise<void>`.
  - `.resolveForDelivery(merchantId): Promise<{ url: string; secret: string; livemode: boolean } | null>` — decrypts; used by the delivery worker (Task 10). ACTIVE only.
  - Routes (all `@UseGuards(ApiKeyGuard)` + `@Public()`): `POST /v1/webhook-endpoints`, `GET /v1/webhook-endpoints`, `POST /v1/webhook-endpoints/rotate-secret`, `DELETE /v1/webhook-endpoints`, `GET /v1/events`.

- [ ] **Step 1: Write the service test**

```ts
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { decryptSecret } from './webhook-secret.crypto';

const KEY = 'test-eaas-webhook-signing-key-0000000000';

function build(store: any = {}) {
  const prisma = {
    webhookEndpoint: {
      upsert: jest.fn(async ({ create }: any) => { store.row = { id: 'we1', ...create }; return store.row; }),
      findUnique: jest.fn(async () => store.row ?? null),
      update: jest.fn(async ({ data }: any) => { store.row = { ...store.row, ...data }; return store.row; }),
    },
  } as any;
  const config = { get: () => KEY } as any;
  return { svc: new WebhookEndpointsService(prisma, config), store, prisma };
}

describe('WebhookEndpointsService', () => {
  it('stores the secret encrypted and returns the plaintext once', async () => {
    const { svc, store } = build();
    const res = await svc.setEndpoint('m1', true, 'https://hooks.example.com/x');
    expect(res.secret.startsWith('whsec_')).toBe(true);
    expect(store.row.secretEnc).not.toContain(res.secret);       // encrypted at rest
    expect(decryptSecret(store.row.secretEnc, KEY)).toBe(res.secret);
    expect(store.row.livemode).toBe(true);
  });

  it('rejects an http URL for a live endpoint (SSRF/https rule)', async () => {
    const { svc } = build();
    await expect(svc.setEndpoint('m1', true, 'http://hooks.example.com')).rejects.toBeTruthy();
  });

  it('allows http for a test endpoint', async () => {
    const { svc } = build();
    await expect(svc.setEndpoint('m1', false, 'http://hooks.example.com')).resolves.toBeTruthy();
  });

  it('resolveForDelivery decrypts and get never returns the secret', async () => {
    const { svc } = build();
    await svc.setEndpoint('m1', true, 'https://hooks.example.com/x');
    const got: any = await svc.get('m1');
    expect(got.secret).toBeUndefined();
    expect(got.secretEnc).toBeUndefined();
    const del = await svc.resolveForDelivery('m1');
    expect(del?.secret.startsWith('whsec_')).toBe(true);
  });
});
```

- [ ] **Step 2:** `npm test -- webhook-endpoints.service` → FAIL.
- [ ] **Step 3: Implement the service**

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import { PrismaService } from '@/prisma/prisma.service';
import { generateWebhookSecret, encryptSecret, decryptSecret } from './webhook-secret.crypto';
import { assertPublicUrl } from './webhook-ssrf';

@Injectable()
export class WebhookEndpointsService {
  private readonly key: string;
  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.key = config.get('EAAS_WEBHOOK_SIGNING_KEY', { infer: true });
  }

  async setEndpoint(
    merchantId: string,
    livemode: boolean,
    url: string,
  ): Promise<{ id: string; url: string; secret: string }> {
    assertPublicUrl(url, { allowHttp: !livemode });
    const secret = generateWebhookSecret();
    const secretEnc = encryptSecret(secret, this.key);
    const row = await this.prisma.webhookEndpoint.upsert({
      where: { merchantId },
      create: { merchantId, url, secretEnc, livemode, status: 'ACTIVE' },
      update: { url, secretEnc, livemode, status: 'ACTIVE' },
    });
    return { id: row.id, url: row.url, secret };
  }

  async get(
    merchantId: string,
  ): Promise<{ id: string; url: string; livemode: boolean; status: string; createdAt: Date } | null> {
    const row = await this.prisma.webhookEndpoint.findUnique({ where: { merchantId } });
    if (!row) return null;
    return { id: row.id, url: row.url, livemode: row.livemode, status: row.status, createdAt: row.createdAt };
  }

  async rotateSecret(merchantId: string): Promise<{ secret: string }> {
    const existing = await this.prisma.webhookEndpoint.findUnique({ where: { merchantId } });
    if (!existing) throw new NotFoundException('No webhook endpoint configured');
    const secret = generateWebhookSecret();
    await this.prisma.webhookEndpoint.update({
      where: { merchantId },
      data: { secretEnc: encryptSecret(secret, this.key) },
    });
    return { secret };
  }

  async disable(merchantId: string): Promise<void> {
    await this.prisma.webhookEndpoint.updateMany({ where: { merchantId }, data: { status: 'DISABLED' } });
  }

  /** Delivery-only: decrypt the secret for an ACTIVE endpoint. */
  async resolveForDelivery(
    merchantId: string,
  ): Promise<{ url: string; secret: string; livemode: boolean } | null> {
    const row = await this.prisma.webhookEndpoint.findUnique({ where: { merchantId } });
    if (!row || row.status !== 'ACTIVE') return null;
    return { url: row.url, secret: decryptSecret(row.secretEnc, this.key), livemode: row.livemode };
  }
}
```

- [ ] **Step 4:** `npm test -- webhook-endpoints.service` → PASS.

- [ ] **Step 5: DTO + controller.**

`dto/set-webhook-endpoint.dto.ts`:
```ts
import { IsUrl, MaxLength } from 'class-validator';

export class SetWebhookEndpointDto {
  @IsUrl({ require_tld: false }) @MaxLength(500) url!: string;
}
```

`v1-webhooks.controller.ts`:
```ts
import { Body, Controller, Delete, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, type MerchantContext } from './api-key.guard';
import { CurrentMerchant } from './decorators/current-merchant.decorator';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { OutboundEventsService } from '@/modules/outbound-events/outbound-events.service';
import { SetWebhookEndpointDto } from './dto/set-webhook-endpoint.dto';
import { OutboundEventStatus } from '@prisma/client';

@Public()
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class V1WebhooksController {
  constructor(
    private readonly endpoints: WebhookEndpointsService,
    private readonly events: OutboundEventsService,
  ) {}

  @Post('webhook-endpoints')
  set(@CurrentMerchant() m: MerchantContext, @Body() dto: SetWebhookEndpointDto) {
    return this.endpoints.setEndpoint(m.id, m.livemode, dto.url); // returns secret once
  }

  @Get('webhook-endpoints')
  get(@CurrentMerchant() m: MerchantContext) {
    return this.endpoints.get(m.id);
  }

  @Post('webhook-endpoints/rotate-secret')
  rotate(@CurrentMerchant() m: MerchantContext) {
    return this.endpoints.rotateSecret(m.id);
  }

  @Delete('webhook-endpoints')
  @HttpCode(204)
  async disable(@CurrentMerchant() m: MerchantContext) {
    await this.endpoints.disable(m.id);
  }

  @Get('events')
  list(
    @CurrentMerchant() m: MerchantContext,
    @Query('status') status?: OutboundEventStatus,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.events.listForMerchant(m.id, {
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit: Number.parseInt(limit, 10) } : {}),
    });
  }
}
```

- [ ] **Step 6: Wire the module.** In `merchants.module.ts`: add `imports: [..., OutboundEventsModule]`, add `WebhookEndpointsService` to `providers`, add `V1WebhooksController` to `controllers`, and `exports: [..., WebhookEndpointsService]` (delivery worker needs it in Task 10).
- [ ] **Step 7:** `npm run build && npm run lint` → clean.
- [ ] **Step 8: Commit**

```bash
git add src/modules/merchants/webhook-endpoints.service.ts src/modules/merchants/dto/set-webhook-endpoint.dto.ts src/modules/merchants/v1-webhooks.controller.ts src/modules/merchants/merchants.module.ts src/modules/merchants/webhook-endpoints.service.spec.ts
git commit -m "feat(eaas): /v1 webhook-endpoints CRUD + /v1/events (merchant-scoped)"
```

---

### Task 10: Delivery worker + cron relay

**Files:**
- Create: `src/modules/merchants/webhook-delivery.service.ts`
- Create: `src/modules/merchants/webhook-delivery.processor.ts`
- Create: `src/modules/merchants/outbound-event-relay.service.ts`
- Modify: `src/modules/merchants/merchants.module.ts`
- Modify: `src/worker.ts`
- Modify: `src/cron.ts`
- Test: `src/modules/merchants/webhook-delivery.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `WebhookEndpointsService.resolveForDelivery`, `ConfigService` (timeout/max attempts), `webhook-signing`, `webhook-ssrf`, `QueueService.enqueueWebhookDelivery` (relay).
- Produces:
  - `WebhookDeliveryService.deliver(eventId: string): Promise<void>` — loads the event; skip if `DELIVERED`; load endpoint (none → mark `FAILED` "no endpoint"); SSRF-check; sign; `fetch` POST (timeout, `redirect: 'error'`); 2xx → `DELIVERED`; else increment `attemptCount`, set `lastError`; when `attemptCount >= WEBHOOK_MAX_ATTEMPTS` mark `FAILED`, else re-throw so BullMQ retries.
  - `createWebhookDeliveryProcessor(svc)` → BullMQ processor fn (mirror `createPayoutProcessor`).
  - `OutboundEventRelay.redispatchPending(graceSeconds?): Promise<number>` — enqueue delivery for `PENDING` rows older than the grace window; returns the count.

- [ ] **Step 1: Write the delivery test** (fake `global.fetch`, mock prisma + endpoints service).

```ts
import { WebhookDeliveryService } from './webhook-delivery.service';

function build(event: any, endpoint: any, fetchImpl: any) {
  const prisma = {
    outboundEvent: {
      findUnique: jest.fn().mockResolvedValue(event),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
  const endpoints = { resolveForDelivery: jest.fn().mockResolvedValue(endpoint) } as any;
  const config = { get: (k: string) => (k === 'WEBHOOK_DELIVERY_TIMEOUT_MS' ? 5000 : 5) } as any;
  global.fetch = fetchImpl;
  return { svc: new WebhookDeliveryService(prisma, endpoints, config), prisma };
}

const event = { id: 'ev1', merchantId: 'm1', type: 'transaction.protected', payload: { transactionId: 't1' }, status: 'PENDING', attemptCount: 0 };
const endpoint = { url: 'https://hooks.example.com/x', secret: 'whsec_x', livemode: true };

describe('WebhookDeliveryService.deliver', () => {
  it('marks DELIVERED on a 2xx response', async () => {
    const { svc, prisma } = build(event, endpoint, jest.fn().mockResolvedValue({ ok: true, status: 200 }));
    await svc.deliver('ev1');
    expect(prisma.outboundEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DELIVERED' }) }),
    );
  });

  it('is idempotent — skips an already DELIVERED event', async () => {
    const { svc, prisma } = build({ ...event, status: 'DELIVERED' }, endpoint, jest.fn());
    await svc.deliver('ev1');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.outboundEvent.update).not.toHaveBeenCalled();
  });

  it('marks FAILED when there is no active endpoint', async () => {
    const { svc, prisma } = build(event, null, jest.fn());
    await svc.deliver('ev1');
    expect(prisma.outboundEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('throws on a 500 (BullMQ will retry) and records the attempt', async () => {
    const { svc } = build(event, endpoint, jest.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(svc.deliver('ev1')).rejects.toBeTruthy();
  });

  it('marks FAILED once attempts are exhausted', async () => {
    const { svc, prisma } = build({ ...event, attemptCount: 4 }, endpoint, jest.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(svc.deliver('ev1')).resolves.toBeUndefined(); // no throw on final attempt
    expect(prisma.outboundEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });
});
```

- [ ] **Step 2:** `npm test -- webhook-delivery.service` → FAIL.
- [ ] **Step 3: Implement the delivery service**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import { PrismaService } from '@/prisma/prisma.service';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { buildSignatureHeader } from './webhook-signing';
import { assertPublicUrl } from './webhook-ssrf';

@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly endpoints: WebhookEndpointsService,
    config: ConfigService<Env, true>,
  ) {
    this.timeoutMs = config.get('WEBHOOK_DELIVERY_TIMEOUT_MS', { infer: true });
    this.maxAttempts = config.get('WEBHOOK_MAX_ATTEMPTS', { infer: true });
  }

  async deliver(eventId: string): Promise<void> {
    const event = await this.prisma.outboundEvent.findUnique({ where: { id: eventId } });
    if (!event || event.status === 'DELIVERED') return;

    const endpoint = await this.endpoints.resolveForDelivery(event.merchantId);
    if (!endpoint) {
      await this.prisma.outboundEvent.update({
        where: { id: eventId },
        data: { status: 'FAILED', lastError: 'no active endpoint' },
      });
      return;
    }

    try {
      assertPublicUrl(endpoint.url, { allowHttp: !endpoint.livemode });
      const rawBody = JSON.stringify({ id: event.id, type: event.type, data: event.payload });
      const ts = Math.floor(Date.now() / 1000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: { ok: boolean; status: number };
      try {
        res = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Meduman-Event-Id': event.id,
            'X-Meduman-Signature': buildSignatureHeader(endpoint.secret, ts, rawBody),
          },
          body: rawBody,
          redirect: 'error',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      await this.prisma.outboundEvent.update({
        where: { id: eventId },
        data: { status: 'DELIVERED', deliveredAt: new Date(), attemptCount: { increment: 1 }, lastError: null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = event.attemptCount + 1;
      const exhausted = attempts >= this.maxAttempts;
      await this.prisma.outboundEvent.update({
        where: { id: eventId },
        data: { attemptCount: attempts, lastError: message, ...(exhausted ? { status: 'FAILED' } : {}) },
      });
      if (!exhausted) throw err; // let BullMQ retry
      this.logger.warn(`webhook ${eventId} failed permanently after ${attempts}: ${message}`);
    }
  }
}
```

`webhook-delivery.processor.ts`:
```ts
import type { Job } from 'bullmq';
import type { WebhookDeliveryJobData } from '@/modules/queue/queue.constants';
import type { WebhookDeliveryService } from './webhook-delivery.service';

export function createWebhookDeliveryProcessor(svc: WebhookDeliveryService) {
  return async (job: Job<WebhookDeliveryJobData>): Promise<void> => {
    await svc.deliver(job.data.eventId);
  };
}
```

`outbound-event-relay.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { QueueService } from '@/modules/queue/queue.service';

@Injectable()
export class OutboundEventRelay {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Re-enqueue delivery for PENDING rows older than the grace window (fast-path lost). */
  async redispatchPending(graceSeconds = 60): Promise<number> {
    const cutoff = new Date(Date.now() - graceSeconds * 1000);
    const rows = await this.prisma.outboundEvent.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      select: { id: true },
      take: 500,
    });
    for (const r of rows) await this.queue.enqueueWebhookDelivery(r.id);
    return rows.length;
  }
}
```

- [ ] **Step 4:** `npm test -- webhook-delivery.service` → PASS.
- [ ] **Step 5: Wire the module + entrypoints.**
  - `merchants.module.ts`: add `WebhookDeliveryService`, `OutboundEventRelay` to `providers`; export both.
  - `worker.ts`: resolve `WebhookDeliveryService`, create a `new Worker(WEBHOOK_OUT_QUEUE, createWebhookDeliveryProcessor(svc), { connection, prefix, concurrency: 10 })`, add a `failed` logger, close it in `shutdown`, and add `WEBHOOK_OUT_QUEUE` to the queue-constants import. Update the "Worker started" log line.
  - `cron.ts`: after the overdue-invoice scan, `const redispatched = await app.get(OutboundEventRelay).redispatchPending(); logger.log(...)`.
- [ ] **Step 6:** `npm run build && npm run lint` → clean. `npm test` → all green.
- [ ] **Step 7: Commit**

```bash
git add src/modules/merchants/webhook-delivery.service.ts src/modules/merchants/webhook-delivery.processor.ts src/modules/merchants/outbound-event-relay.service.ts src/modules/merchants/merchants.module.ts src/worker.ts src/cron.ts src/modules/merchants/webhook-delivery.service.spec.ts
git commit -m "feat(eaas): webhook delivery worker + cron relay for stranded events"
```

---

### Task 11: e2e — outbox emission, tenancy, delivery

**Files:**
- Create: `test/eaas-webhooks.e2e-spec.ts`
- Reference: `test/eaas-tenancy.e2e-spec.ts`, `test/money-safety.e2e-spec.ts`, `test/utils/e2e-harness.ts`.

**Interfaces:**
- Consumes: the harness (`createMoneyE2EApp`) with the `webhook-out` queue faked (Task 6 Step 5). Uses `MerchantsService` + `PaymentsService`/`PayoutsService` + `ctx.prisma` to assert `OutboundEvent` rows.

- [ ] **Step 1: Write the spec** (skips unless `DATABASE_URL`, like the others).

```ts
// describeE2E = process.env.DATABASE_URL ? describe : describe.skip;
//
// Spec 1 — merchant tx emits exactly one transaction.protected outbox row:
//   create merchant A + key; POST /v1/sellers, /v1/sellers/:id/recipient, /v1/transactions, publish;
//   protect via the existing /payments verify path; then:
//   const rows = await ctx.prisma.outboundEvent.findMany({ where: { merchantId: A.id } });
//   expect(rows.filter(r => r.type === 'transaction.protected')).toHaveLength(1);
//   expect(rows[0].payload).toMatchObject({ transactionId: txId, status: 'PAYMENT_PROTECTED' });
//
// Spec 2 — first-party tx (no merchant) emits ZERO:
//   drive a first-party transaction (money-safety style, seeded SELLER/BUYER) to PAYMENT_PROTECTED;
//   expect(await ctx.prisma.outboundEvent.count()) unchanged for that flow (0 rows for its tx).
//
// Spec 3 — funds.released emitted exactly once:
//   continue Spec 1's tx through confirm → executeRelease → markPaid(releaseIdempotencyKey(txId), 'TRF_x');
//   expect one outboundEvent row of type 'funds.released' for A.
//
// Spec 4 — cross-tenant GET /v1/events isolation:
//   merchant B's GET /v1/events returns none of A's events.
//
// Spec 5 — delivery marks DELIVERED against a stubbed endpoint:
//   set global.fetch to a 2xx stub; POST /v1/webhook-endpoints (A, https url);
//   await ctx.app.get(WebhookDeliveryService).deliver(evId);
//   expect the row status DELIVERED. Then a 500-stub on a fresh event → after maxAttempts, FAILED.
```

- [ ] **Step 2: Implement** using the harness helpers (mirror `eaas-tenancy.e2e-spec.ts` setup; import `WebhookDeliveryService`, `MerchantsService`, `PayoutsService`, `releaseIdempotencyKey`). Fake `global.fetch` per spec; restore it in `afterEach`.
- [ ] **Step 3:** Ensure Postgres is up + migrated (Task 1), then `npx jest --config ./test/jest-e2e.json eaas-webhooks` → all specs pass. Also run the full `npm run test:e2e` to confirm no regression in the other suites.
- [ ] **Step 4: Full verification:** `npm run lint && npm run build && npm test`.
- [ ] **Step 5: Commit**

```bash
git add test/eaas-webhooks.e2e-spec.ts
git commit -m "test(eaas): outbound-webhook emission, tenancy, and delivery e2e"
```

---

### Task 12: Document Slice 2

**Files:**
- Modify: `CLAUDE.md` (Status — add an eaas Slice 2 bullet)
- Modify: `docs/PRODUCTION_READINESS.md` (new env `EAAS_WEBHOOK_SIGNING_KEY`; note the DNS-rebind follow-up)

- [ ] **Step 1:** Add a Status bullet to CLAUDE.md summarizing: transactional-outbox emission from `apply`; `WebhookEndpoint`/`OutboundEvent`; `/v1/webhook-endpoints` + `/v1/events`; AES-GCM secret, HMAC signing, SSRF guard; delivery worker + cron relay; events `transaction.protected|cancelled`, `dispute.opened|resolved`, `funds.released`; new env; migration `20260808000000_eaas_outbound_webhooks`.
- [ ] **Step 2:** Add a readiness line: SSRF guard is static (literal-IP); DNS-rebind hardening (resolve-and-pin at send) is a follow-up before external merchants point live URLs at us.
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/PRODUCTION_READINESS.md
git commit -m "docs(eaas): record Slice 2 outbound webhooks"
```

---

## Self-Review

**Spec coverage:**
- Transactional outbox → Task 7 (record in tx client) + Task 8 (wired into apply's `$transaction`). ✓
- One endpoint per merchant, secret once → Task 9 (`upsert` on unique merchantId, returns secret once). ✓
- AES-256-GCM secret at rest → Task 3 + used in Task 9. ✓
- SSRF (https/live, http/test, block private/loopback/metadata) → Task 5 + enforced at register (Task 9) and send (Task 10). ✓
- Signing (t.body HMAC, headers) → Task 4 + applied in Task 10. ✓
- Delivery: at-least-once, retry/backoff, dead-letter, idempotent skip → Task 6 (queue opts) + Task 10 (deliver + FAILED on exhaustion + skip DELIVERED). ✓
- Cron relay for stranded PENDING → Task 10 (`redispatchPending`) + cron wiring. ✓
- Event catalog (5 types) → Task 7 builder map. ✓
- Tenancy: emit only when merchantId set; `/v1/events` merchant-scoped → Task 7 (`recordForTransition` null on null merchantId; `listForMerchant`) + Task 11 specs 1,2,4. ✓
- Endpoints `POST/GET/rotate/DELETE /v1/webhook-endpoints`, `GET /v1/events` → Task 9. ✓
- No dependency cycle → Task 7 module (prisma+queue only), Task 8 (transactions→outbound-events), Task 9/10 (merchants→outbound-events+transactions). ✓

**Placeholder scan:** e2e (Task 11) bodies are commented arrange/act/assert because they depend on the harness's exact helper names, which the implementer reads from the referenced suites; each spec states precise assertions. All other code steps are concrete. No "TBD".

**Type consistency:** `OutboundTxView`/`OutboundPayload` (Task 7) used identically in Task 8's `recordForTransition` call. `WebhookDeliveryJobData { eventId }` (Task 6) consumed in Task 10 processor. `resolveForDelivery` return `{ url, secret, livemode }` (Task 9) consumed in Task 10. `buildSignatureHeader`/`assertPublicUrl`/`encryptSecret`/`decryptSecret` signatures consistent across tasks. `enqueueWebhookDelivery(eventId)` (Task 6) used in Task 7 dispatch + Task 10 relay.

**Scope:** One cohesive subsystem (outbound webhooks). Focused.
