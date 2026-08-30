# EaaS Slice 1 — Tenancy + API-key auth + `/v1` core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a third-party developer's server drive our escrow engine with a secret API key, fully isolated per merchant, over a versioned `/v1` API — without touching money-safety internals.

**Architecture:** A thin `/v1` layer authenticated by API key calls the existing domain services (state machine, `TransactionsService`, `PaystackService`) merchant-scoped. New `Merchant` + `MerchantApiKey` tables; nullable `merchantId` on `User`/`SellerProfile`/`Transaction`/`Payout` (null = first-party Meduman). Every `/v1` read/write intersects the caller's `merchantId`.

**Tech Stack:** NestJS + TypeScript (strict), Prisma (Supabase Postgres), Jest (unit), e2e against real Postgres, Node `crypto`.

## Global Constraints

- Money is integer minor units (kobo), never floats.
- The state machine is the sole owner of `TransactionStatus` (rule 1). `/v1` supplies intents, never a target status.
- Payment protect only via signed webhook / server-verify (rule 2) — `/v1` adds no money-marking endpoint.
- API-key plaintext is returned exactly once at creation and never stored; only a keyed HMAC-SHA256 hash is persisted (reuse the `otp.crypto.ts` pattern — key with a server secret).
- Isolation is money-safety-critical: a merchant can never read/mutate another merchant's (or first-party) rows. Enforced in service methods, never by trusting a client-supplied id alone.
- Path alias `@/*` → `src/*`. One domain per module. `*.module.ts` / `*.controller.ts` / `*.service.ts` / `dto/` / `*.spec.ts` colocated.
- Verify before "done": `npm run lint && npm run build && npm test`.
- New env var must be added to `src/config/env.validation.ts` (zod, fail-fast) and to `.env.test`.

---

### Task 1: Schema — `Merchant`, `MerchantApiKey`, `merchantId` columns + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260807000000_eaas_tenancy/migration.sql`

**Interfaces:**
- Produces: Prisma models `Merchant`, `MerchantApiKey`; nullable `merchantId` on `User`, `SellerProfile`, `Transaction`, `Payout`; enums `MerchantStatus`.

- [ ] **Step 1: Add models + enum to `prisma/schema.prisma`** (place near `AdminUser`; add the reverse relations + `merchantId` to the four existing models).

```prisma
enum MerchantStatus {
  ACTIVE
  SUSPENDED
}

/// A third-party developer tenant integrating our escrow via the /v1 API.
model Merchant {
  id              String         @id @default(uuid()) @db.Uuid
  name            String
  status          MerchantStatus @default(ACTIVE)
  /// Gate: sk_live keys only work once an admin flips this true.
  livemodeEnabled Boolean        @default(false)
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt

  apiKeys      MerchantApiKey[]
  users        User[]
  transactions Transaction[]
  payouts      Payout[]

  @@index([status])
  @@map("merchants")
}

/// An issued secret API key. Plaintext is shown once at creation, never stored.
model MerchantApiKey {
  id         String    @id @default(uuid()) @db.Uuid
  merchantId String    @db.Uuid
  merchant   Merchant  @relation(fields: [merchantId], references: [id], onDelete: Cascade)
  /// Public, non-secret label: e.g. "sk_test_9f3a1c" (env tag + short suffix).
  keyPrefix  String
  /// Keyed HMAC-SHA256 of the full secret. The lookup key. Never the plaintext.
  keyHash    String    @unique
  /// Derived from the key prefix. sk_live => true.
  livemode   Boolean
  lastUsedAt DateTime?
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())

  @@index([merchantId])
  @@map("merchant_api_keys")
}
```

Add to `model User`: `merchantId String? @db.Uuid` + `merchant Merchant? @relation(fields: [merchantId], references: [id])` + `@@index([merchantId])`.
Add to `model SellerProfile`: `merchantId String? @db.Uuid` + `@@index([merchantId])` (no relation needed; scoping column only).
Add to `model Transaction`: `merchantId String? @db.Uuid` + `merchant Merchant? @relation(fields: [merchantId], references: [id])` + `@@index([merchantId])`.
Add to `model Payout`: `merchantId String? @db.Uuid` + `merchant Merchant? @relation(fields: [merchantId], references: [id])` + `@@index([merchantId])`.

- [ ] **Step 2: Generate the migration SQL offline** (matches how `init` was authored — `migrate diff`, not a live DB).

Run:
```bash
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > /dev/null 2>&1 || true
mkdir -p prisma/migrations/20260807000000_eaas_tenancy
```

Then author `migration.sql` by hand as an **additive** migration (new tables + new nullable columns + indexes; no data change):
```sql
-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "merchants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "MerchantStatus" NOT NULL DEFAULT 'ACTIVE',
    "livemodeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_api_keys" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "merchant_api_keys_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "users" ADD COLUMN "merchantId" UUID;
ALTER TABLE "seller_profiles" ADD COLUMN "merchantId" UUID;
ALTER TABLE "transactions" ADD COLUMN "merchantId" UUID;
ALTER TABLE "payouts" ADD COLUMN "merchantId" UUID;

-- Indexes
CREATE INDEX "merchants_status_idx" ON "merchants"("status");
CREATE UNIQUE INDEX "merchant_api_keys_keyHash_key" ON "merchant_api_keys"("keyHash");
CREATE INDEX "merchant_api_keys_merchantId_idx" ON "merchant_api_keys"("merchantId");
CREATE INDEX "users_merchantId_idx" ON "users"("merchantId");
CREATE INDEX "seller_profiles_merchantId_idx" ON "seller_profiles"("merchantId");
CREATE INDEX "transactions_merchantId_idx" ON "transactions"("merchantId");
CREATE INDEX "payouts_merchantId_idx" ON "payouts"("merchantId");

-- Foreign keys
ALTER TABLE "merchant_api_keys" ADD CONSTRAINT "merchant_api_keys_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npm run prisma:generate`
Expected: succeeds; `Merchant`, `MerchantApiKey` types available from `@prisma/client`.

- [ ] **Step 4: Apply the migration to the local test DB**

Run: `npm run db:up && npm run db:migrate:test`
Expected: all migrations apply clean, including `20260807000000_eaas_tenancy`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260807000000_eaas_tenancy
git commit -m "feat(eaas): Merchant + MerchantApiKey models, merchantId tenancy columns"
```

---

### Task 2: API-key crypto primitives (pure, unit-tested)

**Files:**
- Create: `src/modules/merchants/api-key.crypto.ts`
- Test: `src/modules/merchants/api-key.crypto.spec.ts`

**Interfaces:**
- Produces:
  - `generateApiKey(livemode: boolean): { plaintext: string; prefix: string }` — plaintext like `sk_live_<40 hex>`, prefix like `sk_live_<6 hex>`.
  - `hashApiKey(plaintext: string, secret: string): string` — keyed HMAC-SHA256 hex.
  - `timingSafeEqualHex(a: string, b: string): boolean` — re-exported/duplicated constant-time compare.

- [ ] **Step 1: Write the failing test**

```ts
import { generateApiKey, hashApiKey, timingSafeEqualHex } from './api-key.crypto';

describe('api-key.crypto', () => {
  it('generates a prefixed secret whose prefix matches the mode', () => {
    const live = generateApiKey(true);
    expect(live.plaintext.startsWith('sk_live_')).toBe(true);
    expect(live.prefix.startsWith('sk_live_')).toBe(true);
    expect(live.plaintext.startsWith(live.prefix)).toBe(true);
    const test = generateApiKey(false);
    expect(test.plaintext.startsWith('sk_test_')).toBe(true);
  });

  it('produces unique secrets across calls', () => {
    expect(generateApiKey(true).plaintext).not.toEqual(generateApiKey(true).plaintext);
  });

  it('hashes deterministically per (plaintext, secret) and differs by secret', () => {
    expect(hashApiKey('sk_test_abc', 's1')).toEqual(hashApiKey('sk_test_abc', 's1'));
    expect(hashApiKey('sk_test_abc', 's1')).not.toEqual(hashApiKey('sk_test_abc', 's2'));
  });

  it('constant-time compares hex and returns false on length mismatch', () => {
    expect(timingSafeEqualHex('aa', 'aa')).toBe(true);
    expect(timingSafeEqualHex('aa', 'bb')).toBe(false);
    expect(timingSafeEqualHex('aa', 'aabb')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- api-key.crypto`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Full secret + its public prefix. Prefix is safe to store/log; plaintext is not. */
export function generateApiKey(livemode: boolean): { plaintext: string; prefix: string } {
  const tag = livemode ? 'sk_live_' : 'sk_test_';
  const body = randomBytes(20).toString('hex'); // 40 hex chars
  return { plaintext: `${tag}${body}`, prefix: `${tag}${body.slice(0, 6)}` };
}

/** Keyed HMAC-SHA256 of the full secret, hex. The stored lookup key — never plaintext. */
export function hashApiKey(plaintext: string, secret: string): string {
  return createHmac('sha256', secret).update(plaintext).digest('hex');
}

/** Constant-time hex compare; false (never throws) on length mismatch. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- api-key.crypto`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/merchants/api-key.crypto.ts src/modules/merchants/api-key.crypto.spec.ts
git commit -m "feat(eaas): API-key crypto primitives (prefixed secret, keyed hash-at-rest)"
```

---

### Task 3: Config — `EAAS_API_KEY_SECRET` env var

**Files:**
- Modify: `src/config/env.validation.ts`
- Modify: `.env.test`

**Interfaces:**
- Produces: `config.get('EAAS_API_KEY_SECRET')` (string, min 16).

- [ ] **Step 1: Add to the zod schema** (near `OTP_HASH_SECRET`):

```ts
  EAAS_API_KEY_SECRET: z.string().min(16),
```

- [ ] **Step 2: Add a fake value to `.env.test`**

```
EAAS_API_KEY_SECRET=test-eaas-api-key-secret-000000
```

- [ ] **Step 3: Verify build/type**

Run: `npm run build`
Expected: PASS (env type includes the new key).

- [ ] **Step 4: Commit**

```bash
git add src/config/env.validation.ts .env.test
git commit -m "feat(eaas): EAAS_API_KEY_SECRET env var (keys the API-key hash)"
```

---

### Task 4: `MerchantsService` — create tenant, issue/verify/revoke keys

**Files:**
- Create: `src/modules/merchants/merchants.service.ts`
- Test: `src/modules/merchants/merchants.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; `ConfigService<Env, true>`; `api-key.crypto`.
- Produces:
  - `createMerchant(name: string): Promise<{ merchant: Merchant; apiKey: string }>` — apiKey is the ONE-TIME plaintext.
  - `issueKey(merchantId: string, livemode: boolean): Promise<{ apiKey: string; keyId: string }>`.
  - `revokeKey(merchantId: string, keyId: string): Promise<void>`.
  - `verifyKey(plaintext: string): Promise<{ merchant: Merchant; livemode: boolean } | null>` — null when unknown/revoked; also updates `lastUsedAt`.
  - `setLivemodeEnabled(merchantId: string, enabled: boolean): Promise<Merchant>` / `setStatus(merchantId, status): Promise<Merchant>`.

- [ ] **Step 1: Write the failing test** (mock `PrismaService` + `ConfigService`).

```ts
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MerchantsService } from './merchants.service';
import { PrismaService } from '@/prisma/prisma.service';
import { hashApiKey } from './api-key.crypto';

const SECRET = 'unit-secret-0000000000';

function prismaMock() {
  return {
    merchant: { create: jest.fn(), update: jest.fn() },
    merchantApiKey: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn((fn: any) => fn(this)),
  } as any;
}

async function build(prisma: any) {
  const mod = await Test.createTestingModule({
    providers: [
      MerchantsService,
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: { get: () => SECRET } },
    ],
  }).compile();
  return mod.get(MerchantsService);
}

describe('MerchantsService', () => {
  it('createMerchant returns a one-time plaintext key and stores only its hash', async () => {
    const prisma = prismaMock();
    prisma.merchant.create.mockResolvedValue({ id: 'm1', name: 'Acme' });
    prisma.merchantApiKey.create.mockResolvedValue({ id: 'k1' });
    const svc = await build(prisma);

    const { merchant, apiKey } = await svc.createMerchant('Acme');

    expect(merchant.id).toBe('m1');
    expect(apiKey.startsWith('sk_test_')).toBe(true); // new merchant starts in test mode
    const stored = prisma.merchantApiKey.create.mock.calls[0][0].data;
    expect(stored.keyHash).toBe(hashApiKey(apiKey, SECRET));
    expect(JSON.stringify(stored)).not.toContain(apiKey); // plaintext never persisted
  });

  it('verifyKey resolves the merchant for a known, non-revoked key and stamps lastUsedAt', async () => {
    const prisma = prismaMock();
    const svc = await build(prisma);
    const plaintext = 'sk_live_' + 'a'.repeat(40);
    prisma.merchantApiKey.findUnique.mockResolvedValue({
      id: 'k1', merchantId: 'm1', livemode: true, revokedAt: null,
      merchant: { id: 'm1', status: 'ACTIVE', livemodeEnabled: true },
    });

    const res = await svc.verifyKey(plaintext);

    expect(prisma.merchantApiKey.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { keyHash: hashApiKey(plaintext, SECRET) } }),
    );
    expect(res?.merchant.id).toBe('m1');
    expect(res?.livemode).toBe(true);
    expect(prisma.merchantApiKey.update).toHaveBeenCalled(); // lastUsedAt stamped
  });

  it('verifyKey returns null for a revoked key', async () => {
    const prisma = prismaMock();
    const svc = await build(prisma);
    prisma.merchantApiKey.findUnique.mockResolvedValue({
      id: 'k1', merchantId: 'm1', livemode: true, revokedAt: new Date(),
      merchant: { id: 'm1', status: 'ACTIVE', livemodeEnabled: true },
    });
    expect(await svc.verifyKey('sk_live_' + 'a'.repeat(40))).toBeNull();
  });

  it('verifyKey returns null for a suspended merchant', async () => {
    const prisma = prismaMock();
    const svc = await build(prisma);
    prisma.merchantApiKey.findUnique.mockResolvedValue({
      id: 'k1', merchantId: 'm1', livemode: false, revokedAt: null,
      merchant: { id: 'm1', status: 'SUSPENDED', livemodeEnabled: false },
    });
    expect(await svc.verifyKey('sk_test_' + 'a'.repeat(40))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- merchants.service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Merchant, MerchantStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import type { Env } from '@/config/env.validation';
import { generateApiKey, hashApiKey } from './api-key.crypto';

@Injectable()
export class MerchantsService {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('EAAS_API_KEY_SECRET', { infer: true });
  }

  async createMerchant(name: string): Promise<{ merchant: Merchant; apiKey: string }> {
    const merchant = await this.prisma.merchant.create({ data: { name } });
    const { apiKey } = await this.issueKey(merchant.id, false); // start in test mode
    return { merchant, apiKey };
  }

  async issueKey(merchantId: string, livemode: boolean): Promise<{ apiKey: string; keyId: string }> {
    const { plaintext, prefix } = generateApiKey(livemode);
    const created = await this.prisma.merchantApiKey.create({
      data: { merchantId, keyPrefix: prefix, keyHash: hashApiKey(plaintext, this.secret), livemode },
    });
    return { apiKey: plaintext, keyId: created.id };
  }

  async revokeKey(merchantId: string, keyId: string): Promise<void> {
    await this.prisma.merchantApiKey.updateMany({
      where: { id: keyId, merchantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async verifyKey(plaintext: string): Promise<{ merchant: Merchant; livemode: boolean } | null> {
    const keyHash = hashApiKey(plaintext, this.secret);
    const row = await this.prisma.merchantApiKey.findUnique({
      where: { keyHash },
      include: { merchant: true },
    });
    if (!row || row.revokedAt || row.merchant.status !== 'ACTIVE') return null;
    await this.prisma.merchantApiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
    return { merchant: row.merchant, livemode: row.livemode };
  }

  setLivemodeEnabled(merchantId: string, enabled: boolean): Promise<Merchant> {
    return this.prisma.merchant.update({ where: { id: merchantId }, data: { livemodeEnabled: enabled } });
  }

  setStatus(merchantId: string, status: MerchantStatus): Promise<Merchant> {
    return this.prisma.merchant.update({ where: { id: merchantId }, data: { status } });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- merchants.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/merchants/merchants.service.ts src/modules/merchants/merchants.service.spec.ts
git commit -m "feat(eaas): MerchantsService — create tenant, issue/verify/revoke API keys"
```

---

### Task 5: `ApiKeyGuard` + `@CurrentMerchant()` decorator

**Files:**
- Create: `src/modules/merchants/api-key.guard.ts`
- Create: `src/modules/merchants/decorators/current-merchant.decorator.ts`
- Test: `src/modules/merchants/api-key.guard.spec.ts`

**Interfaces:**
- Consumes: `MerchantsService.verifyKey`.
- Produces:
  - `ApiKeyGuard` (CanActivate): reads `Authorization: Bearer sk_...`, verifies, attaches `request.merchant = { id, livemode }`. Throws 401 when missing/unknown/revoked; 403 when a `sk_live` key is used but `merchant.livemodeEnabled` is false.
  - `@CurrentMerchant()` → `{ id: string; livemode: boolean }`.
  - Exported request shape `MerchantContext = { id: string; livemode: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

function ctx(authorization?: string): ExecutionContext {
  const req: any = { headers: { authorization } };
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

describe('ApiKeyGuard', () => {
  const merchants = { verifyKey: jest.fn() } as any;
  const guard = new ApiKeyGuard(merchants);
  beforeEach(() => jest.resetAllMocks());

  it('rejects a missing bearer key', async () => {
    await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unknown/revoked key', async () => {
    merchants.verifyKey.mockResolvedValue(null);
    await expect(guard.canActivate(ctx('Bearer sk_test_x'))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a valid test key and attaches the merchant', async () => {
    merchants.verifyKey.mockResolvedValue({ merchant: { id: 'm1', livemodeEnabled: false }, livemode: false });
    const c = ctx('Bearer sk_test_x');
    await expect(guard.canActivate(c)).resolves.toBe(true);
    const req = c.switchToHttp().getRequest() as any;
    expect(req.merchant).toEqual({ id: 'm1', livemode: false });
  });

  it('forbids a live key when livemode is not enabled for the merchant', async () => {
    merchants.verifyKey.mockResolvedValue({ merchant: { id: 'm1', livemodeEnabled: false }, livemode: true });
    await expect(guard.canActivate(ctx('Bearer sk_live_x'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- api-key.guard`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement guard + decorator**

`api-key.guard.ts`:
```ts
import {
  type CanActivate, type ExecutionContext, ForbiddenException,
  Injectable, UnauthorizedException,
} from '@nestjs/common';
import { MerchantsService } from './merchants.service';

export interface MerchantContext {
  id: string;
  livemode: boolean;
}

interface MerchantRequest {
  headers: Record<string, string | undefined>;
  merchant?: MerchantContext;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly merchants: MerchantsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MerchantRequest>();
    const key = extractBearer(request.headers.authorization);
    if (!key || !key.startsWith('sk_')) {
      throw new UnauthorizedException('Missing API key');
    }
    const verified = await this.merchants.verifyKey(key);
    if (!verified) {
      throw new UnauthorizedException('Invalid API key');
    }
    if (verified.livemode && !verified.merchant.livemodeEnabled) {
      throw new ForbiddenException('Live mode is not enabled for this merchant');
    }
    request.merchant = { id: verified.merchant.id, livemode: verified.livemode };
    return true;
  }
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme === 'Bearer' && value ? value : undefined;
}
```

`decorators/current-merchant.decorator.ts`:
```ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { MerchantContext } from '../api-key.guard';

/** Inject the merchant attached by ApiKeyGuard. Only valid on /v1 routes it guards. */
export const CurrentMerchant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MerchantContext => {
    const request = ctx.switchToHttp().getRequest<{ merchant?: MerchantContext }>();
    if (!request.merchant) {
      throw new Error('CurrentMerchant used on a route without ApiKeyGuard');
    }
    return request.merchant;
  },
);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- api-key.guard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/merchants/api-key.guard.ts src/modules/merchants/decorators/current-merchant.decorator.ts src/modules/merchants/api-key.guard.spec.ts
git commit -m "feat(eaas): ApiKeyGuard + @CurrentMerchant (bearer sk_ key, livemode gate)"
```

---

### Task 6: Merchant-scoped seller minting — `MerchantSellersService`

**Files:**
- Create: `src/modules/merchants/merchant-sellers.service.ts`
- Test: `src/modules/merchants/merchant-sellers.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; `SellerProfileService.createTransferRecipient(userId, dto)` (existing, from `users/`).
- Produces:
  - `createSeller(merchantId: string, input: { businessName: string; email?: string }): Promise<{ id: string; businessName: string | null }>` — mints a `User` (roleFlags `[SELLER]`, `merchantId` set, synthetic unique email when none given, NO Supabase auth account) + a `SellerProfile` (`merchantId` set).
  - `listSellers(merchantId: string): Promise<Array<{ id: string; businessName: string | null; settlementReady: boolean }>>`.
  - `getSeller(merchantId: string, sellerId: string): Promise<{ id: string; businessName: string | null; settlementReady: boolean }>` — throws `NotFoundException` if the seller isn't this merchant's.
  - `assertOwnedSeller(merchantId: string, sellerId: string): Promise<void>` — 404 if the `User` row's `merchantId` !== merchantId.

- [ ] **Step 1: Write the failing test**

```ts
import { NotFoundException } from '@nestjs/common';
import { MerchantSellersService } from './merchant-sellers.service';

function prismaMock() {
  return {
    user: { create: jest.fn(), findFirst: jest.fn() },
    sellerProfile: { create: jest.fn(), findMany: jest.fn() },
  } as any;
}

describe('MerchantSellersService', () => {
  it('mints a merchant-scoped seller User + SellerProfile with no Supabase account', async () => {
    const prisma = prismaMock();
    prisma.user.create.mockResolvedValue({ id: 'u1' });
    prisma.sellerProfile.create.mockResolvedValue({ id: 'sp1', businessName: 'Store A' });
    const svc = new MerchantSellersService(prisma, {} as any);

    const seller = await svc.createSeller('m1', { businessName: 'Store A' });

    const userData = prisma.user.create.mock.calls[0][0].data;
    expect(userData.merchantId).toBe('m1');
    expect(userData.roleFlags).toEqual(['SELLER']);
    expect(userData.email).toContain('@'); // synthetic email
    const profileData = prisma.sellerProfile.create.mock.calls[0][0].data;
    expect(profileData.merchantId).toBe('m1');
    expect(seller.id).toBe('u1');
  });

  it('assertOwnedSeller 404s a seller from another merchant', async () => {
    const prisma = prismaMock();
    prisma.user.findFirst.mockResolvedValue(null); // no row with (id, merchantId=m1)
    const svc = new MerchantSellersService(prisma, {} as any);
    await expect(svc.assertOwnedSeller('m1', 'other')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- merchant-sellers.service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { SellerProfileService } from '@/modules/users/seller-profile.service';

@Injectable()
export class MerchantSellersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sellerProfiles: SellerProfileService,
  ) {}

  async createSeller(
    merchantId: string,
    input: { businessName: string; email?: string },
  ): Promise<{ id: string; businessName: string | null }> {
    const email = input.email ?? `seller+${randomUUID()}@eaas.meduman.local`;
    const user = await this.prisma.user.create({
      data: { id: randomUUID(), email, fullName: input.businessName, roleFlags: ['SELLER'], merchantId },
    });
    const profile = await this.prisma.sellerProfile.create({
      data: { userId: user.id, businessName: input.businessName, merchantId },
    });
    return { id: user.id, businessName: profile.businessName };
  }

  async listSellers(
    merchantId: string,
  ): Promise<Array<{ id: string; businessName: string | null; settlementReady: boolean }>> {
    const rows = await this.prisma.sellerProfile.findMany({ where: { merchantId } });
    return rows.map((p) => ({
      id: p.userId,
      businessName: p.businessName,
      settlementReady: !!p.providerRecipientCode,
    }));
  }

  async getSeller(
    merchantId: string,
    sellerId: string,
  ): Promise<{ id: string; businessName: string | null; settlementReady: boolean }> {
    await this.assertOwnedSeller(merchantId, sellerId);
    const profile = await this.prisma.sellerProfile.findUnique({ where: { userId: sellerId } });
    return {
      id: sellerId,
      businessName: profile?.businessName ?? null,
      settlementReady: !!profile?.providerRecipientCode,
    };
  }

  async assertOwnedSeller(merchantId: string, sellerId: string): Promise<void> {
    const owned = await this.prisma.user.findFirst({ where: { id: sellerId, merchantId } });
    if (!owned) throw new NotFoundException(`Seller ${sellerId} not found`);
  }
}
```

> Note: `SellerProfileService.createTransferRecipient(userId, dto)` is reused directly by the controller in Task 8 for `POST /v1/sellers/:id/recipient` (after `assertOwnedSeller`). It is injected here so the module exports a single seam.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- merchant-sellers.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/merchants/merchant-sellers.service.ts src/modules/merchants/merchant-sellers.service.spec.ts
git commit -m "feat(eaas): MerchantSellersService — mint merchant-scoped sellers, ownership assert"
```

---

### Task 7: Merchant-scoped transaction methods on `TransactionsService`

**Files:**
- Modify: `src/modules/transactions/transactions.service.ts`
- Test: `src/modules/transactions/transactions.service.spec.ts` (add cases)

**Interfaces:**
- Consumes: existing `createDraft`, `apply`, `getById`.
- Produces:
  - `CreateDraftInput` gains `merchantId?: string` (written to the row).
  - `listForMerchant(merchantId: string, opts: { status?: TransactionStatus; cursor?: string; limit?: number }): Promise<{ items: Transaction[]; nextCursor: string | null }>`.
  - `getByIdForMerchant(merchantId: string, id: string): Promise<Transaction>` — 404 unless the row's `merchantId` matches.

- [ ] **Step 1: Write the failing test** (extend the existing spec file).

```ts
describe('TransactionsService merchant scoping', () => {
  it('createDraft persists merchantId when supplied', async () => {
    const create = jest.fn().mockResolvedValue({ id: 't1' });
    const prisma = { transaction: { create } } as any;
    const svc = new TransactionsService(prisma);
    await svc.createDraft({ sellerId: 's1', title: 'x', amount: 1000, merchantId: 'm1' });
    expect(create.mock.calls[0][0].data.merchantId).toBe('m1');
  });

  it('getByIdForMerchant 404s a transaction owned by another merchant', async () => {
    const prisma = { transaction: { findFirst: jest.fn().mockResolvedValue(null) } } as any;
    const svc = new TransactionsService(prisma);
    await expect(svc.getByIdForMerchant('m1', 't1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listForMerchant filters by merchantId', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { transaction: { findMany } } as any;
    const svc = new TransactionsService(prisma);
    await svc.listForMerchant('m1', {});
    expect(findMany.mock.calls[0][0].where).toMatchObject({ merchantId: 'm1' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- transactions.service`
Expected: FAIL — methods not defined / merchantId not written.

- [ ] **Step 3: Implement**

Add `merchantId?: string;` to `CreateDraftInput`. In `createDraft`'s `data`, add:
```ts
        ...(input.merchantId ? { merchantId: input.merchantId } : {}),
```

Add methods:
```ts
  async getByIdForMerchant(merchantId: string, id: string): Promise<Transaction> {
    const tx = await this.prisma.transaction.findFirst({ where: { id, merchantId } });
    if (!tx) throw new NotFoundException(`Transaction ${id} not found`);
    return tx;
  }

  async listForMerchant(
    merchantId: string,
    opts: { status?: TransactionStatus; cursor?: string; limit?: number },
  ): Promise<{ items: Transaction[]; nextCursor: string | null }> {
    const take = opts.limit ?? 20;
    const rows = await this.prisma.transaction.findMany({
      where: { merchantId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, take);
    const last = items.at(-1);
    const nextCursor = rows.length > take && last ? last.id : null;
    return { items, nextCursor };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- transactions.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/transactions/transactions.service.ts src/modules/transactions/transactions.service.spec.ts
git commit -m "feat(eaas): merchant-scoped createDraft/list/get on TransactionsService"
```

---

### Task 8: `/v1` controllers + `MerchantsModule` wiring

**Files:**
- Create: `src/modules/merchants/dto/create-seller.dto.ts`
- Create: `src/modules/merchants/dto/create-v1-transaction.dto.ts`
- Create: `src/modules/merchants/dto/list-v1-transactions.dto.ts`
- Create: `src/modules/merchants/v1-sellers.controller.ts`
- Create: `src/modules/merchants/v1-transactions.controller.ts`
- Create: `src/modules/merchants/merchants.module.ts`
- Modify: `src/app.module.ts` (register `MerchantsModule`)

**Interfaces:**
- Consumes: `ApiKeyGuard`, `@CurrentMerchant`, `MerchantsService`, `MerchantSellersService`, `TransactionsService`, `SellerProfileService`, `CreateTransferRecipientDto` (existing, from `users/dto/`), `ConfigService` (`APP_URL` for the pay link).
- Produces: `/v1/sellers*`, `/v1/transactions*` routes, all guarded by `ApiKeyGuard` (NOT the global JWT guard) and merchant-scoped.

- [ ] **Step 1: Write the DTOs**

`dto/create-seller.dto.ts`:
```ts
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateSellerDto {
  @IsString() @MaxLength(120) businessName!: string;
  @IsOptional() @IsEmail() email?: string;
}
```

`dto/create-v1-transaction.dto.ts`:
```ts
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { ReleaseRule } from '@prisma/client';

export class CreateV1TransactionDto {
  @IsUUID() sellerId!: string;
  @IsString() @MaxLength(200) title!: string;
  /** Protected amount in KOBO (integer). */
  @IsInt() @Min(1) amount!: number;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsEnum(ReleaseRule) releaseRule?: ReleaseRule;
}
```

`dto/list-v1-transactions.dto.ts`:
```ts
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { TransactionStatus } from '@prisma/client';

export class ListV1TransactionsDto {
  @IsOptional() @IsEnum(TransactionStatus) status?: TransactionStatus;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}
```

- [ ] **Step 2: Write the controllers**

`v1-sellers.controller.ts`:
```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, type MerchantContext } from './api-key.guard';
import { CurrentMerchant } from './decorators/current-merchant.decorator';
import { MerchantSellersService } from './merchant-sellers.service';
import { SellerProfileService } from '@/modules/users/seller-profile.service';
import { CreateSellerDto } from './dto/create-seller.dto';
import { CreateTransferRecipientDto } from '@/modules/users/dto/create-transfer-recipient.dto';

@UseGuards(ApiKeyGuard)
@Controller('v1/sellers')
export class V1SellersController {
  constructor(
    private readonly sellers: MerchantSellersService,
    private readonly sellerProfiles: SellerProfileService,
  ) {}

  @Post()
  create(@CurrentMerchant() m: MerchantContext, @Body() dto: CreateSellerDto) {
    return this.sellers.createSeller(m.id, dto);
  }

  @Get()
  list(@CurrentMerchant() m: MerchantContext) {
    return this.sellers.listSellers(m.id);
  }

  @Get(':id')
  get(@CurrentMerchant() m: MerchantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.sellers.getSeller(m.id, id);
  }

  @Post(':id/recipient')
  async recipient(
    @CurrentMerchant() m: MerchantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateTransferRecipientDto,
  ) {
    await this.sellers.assertOwnedSeller(m.id, id);
    return this.sellerProfiles.createTransferRecipient(id, dto);
  }
}
```

`v1-transactions.controller.ts`:
```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard, type MerchantContext } from './api-key.guard';
import { CurrentMerchant } from './decorators/current-merchant.decorator';
import { MerchantSellersService } from './merchant-sellers.service';
import { TransactionsService } from '@/modules/transactions/transactions.service';
import { CreateV1TransactionDto } from './dto/create-v1-transaction.dto';
import { ListV1TransactionsDto } from './dto/list-v1-transactions.dto';
import type { Env } from '@/config/env.validation';

@UseGuards(ApiKeyGuard)
@Controller('v1/transactions')
export class V1TransactionsController {
  private readonly appUrl: string;
  constructor(
    private readonly transactions: TransactionsService,
    private readonly sellers: MerchantSellersService,
    config: ConfigService<Env, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  @Post()
  async create(@CurrentMerchant() m: MerchantContext, @Body() dto: CreateV1TransactionDto) {
    await this.sellers.assertOwnedSeller(m.id, dto.sellerId); // 404 if not this merchant's seller
    const tx = await this.transactions.createDraft({
      merchantId: m.id,
      sellerId: dto.sellerId,
      title: dto.title,
      amount: dto.amount,
      ...(dto.description ? { description: dto.description } : {}),
      ...(dto.currency ? { currency: dto.currency } : {}),
      ...(dto.releaseRule ? { releaseRule: dto.releaseRule } : {}),
    });
    return this.view(tx);
  }

  @Get()
  list(@CurrentMerchant() m: MerchantContext, @Query() q: ListV1TransactionsDto) {
    return this.transactions.listForMerchant(m.id, q);
  }

  @Get(':id')
  async get(@CurrentMerchant() m: MerchantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.view(await this.transactions.getByIdForMerchant(m.id, id));
  }

  @Post(':id/publish')
  async publish(@CurrentMerchant() m: MerchantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.transactions.getByIdForMerchant(m.id, id); // ownership gate (404 otherwise)
    const tx = await this.transactions.apply({
      transactionId: id,
      event: { type: 'SELLER_PUBLISH' },
      actor: { id: m.id, type: 'SYSTEM', role: 'MERCHANT' },
    });
    return this.view(tx);
  }

  /** Lean, merchant-safe projection (no internal secrets); adds the hosted pay link. */
  private view(tx: { id: string; publicLinkId: string; status: string; amount: number; currency: string; title: string }) {
    return {
      id: tx.id,
      status: tx.status,
      amount: tx.amount,
      currency: tx.currency,
      title: tx.title,
      payLinkUrl: `${this.appUrl}/pay/${tx.publicLinkId}`,
    };
  }
}
```

- [ ] **Step 3: Write the module + wire it**

`merchants.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@/prisma/prisma.module';
import { UsersModule } from '@/modules/users/users.module';
import { TransactionsModule } from '@/modules/transactions/transactions.module';
import { MerchantsService } from './merchants.service';
import { MerchantSellersService } from './merchant-sellers.service';
import { ApiKeyGuard } from './api-key.guard';
import { V1SellersController } from './v1-sellers.controller';
import { V1TransactionsController } from './v1-transactions.controller';

@Module({
  imports: [PrismaModule, UsersModule, TransactionsModule],
  controllers: [V1SellersController, V1TransactionsController],
  providers: [MerchantsService, MerchantSellersService, ApiKeyGuard],
  exports: [MerchantsService],
})
export class MerchantsModule {}
```

Register `MerchantsModule` in `src/app.module.ts` imports (domain section). Confirm `UsersModule` exports `SellerProfileService` and `TransactionsModule` exports `TransactionsService`; if either isn't exported, add it to that module's `exports`.

> **Guard note:** `/v1` controllers use `@UseGuards(ApiKeyGuard)` at the controller level. They are NOT `@Public()` — so the global `SupabaseJwtGuard` still runs first and would 401 a request with no Supabase JWT. Fix: mark the `/v1` controllers `@Public()` too (to skip the JWT guard) AND keep `@UseGuards(ApiKeyGuard)` (which becomes the real gate). Add `@Public()` from `@/modules/auth/decorators/public.decorator` at the class level of both controllers. Verify in the e2e (Task 9) that a `/v1` call with only an API key (no JWT) succeeds and one with neither 401s.

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/merchants/dto src/modules/merchants/v1-sellers.controller.ts src/modules/merchants/v1-transactions.controller.ts src/modules/merchants/merchants.module.ts src/app.module.ts
git commit -m "feat(eaas): /v1 sellers + transactions controllers, MerchantsModule wiring"
```

---

### Task 9: Admin merchant management endpoints (first-party, JWT + ADMIN)

**Files:**
- Create: `src/modules/merchants/dto/create-merchant.dto.ts`
- Create: `src/modules/merchants/admin-merchants.controller.ts`
- Modify: `src/modules/merchants/merchants.module.ts` (add controller)

**Interfaces:**
- Consumes: `MerchantsService`, global `SupabaseJwtGuard` + `RolesGuard` (`@Roles('ADMIN')`).
- Produces: `POST /admin/merchants`, `POST /admin/merchants/:id/keys`, `POST /admin/merchants/:id/keys/:keyId/revoke`, `PATCH /admin/merchants/:id`.

- [ ] **Step 1: Write the DTO + controller**

`dto/create-merchant.dto.ts`:
```ts
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { MerchantStatus } from '@prisma/client';

export class CreateMerchantDto {
  @IsString() @MaxLength(120) name!: string;
}

export class UpdateMerchantDto {
  @IsOptional() @IsBoolean() livemodeEnabled?: boolean;
  @IsOptional() @IsIn([MerchantStatus.ACTIVE, MerchantStatus.SUSPENDED]) status?: MerchantStatus;
}

export class IssueKeyDto {
  @IsOptional() @IsBoolean() livemode?: boolean;
}
```

`admin-merchants.controller.ts`:
```ts
import { Body, Controller, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '@/modules/auth/decorators/roles.decorator';
import { MerchantsService } from './merchants.service';
import { CreateMerchantDto, IssueKeyDto, UpdateMerchantDto } from './dto/create-merchant.dto';

@Roles('ADMIN')
@Controller('admin/merchants')
export class AdminMerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  @Post()
  create(@Body() dto: CreateMerchantDto) {
    return this.merchants.createMerchant(dto.name); // returns { merchant, apiKey } — apiKey shown once
  }

  @Post(':id/keys')
  issueKey(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: IssueKeyDto) {
    return this.merchants.issueKey(id, dto.livemode ?? false); // { apiKey, keyId } — apiKey shown once
  }

  @Post(':id/keys/:keyId/revoke')
  async revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('keyId', new ParseUUIDPipe()) keyId: string,
  ) {
    await this.merchants.revokeKey(id, keyId);
    return { ok: true };
  }

  @Patch(':id')
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateMerchantDto) {
    if (dto.livemodeEnabled !== undefined) await this.merchants.setLivemodeEnabled(id, dto.livemodeEnabled);
    if (dto.status) await this.merchants.setStatus(id, dto.status);
    return { ok: true };
  }
}
```

Add `AdminMerchantsController` to `merchants.module.ts` `controllers`.

> These routes carry no `@Public()`, so the global `SupabaseJwtGuard` + `RolesGuard` protect them — an admin JWT is required, consistent with the existing `admin/` module.

- [ ] **Step 2: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/modules/merchants/dto/create-merchant.dto.ts src/modules/merchants/admin-merchants.controller.ts src/modules/merchants/merchants.module.ts
git commit -m "feat(eaas): admin merchant CRUD — create tenant, issue/revoke keys, livemode/suspend"
```

---

### Task 10: e2e — cross-tenant isolation + EaaS lifecycle

**Files:**
- Create: `test/eaas-tenancy.e2e-spec.ts`
- Reference: `test/money-safety.e2e-spec.ts` + `test/utils/` (existing harness — real Postgres, faked Paystack/auth/queue).

**Interfaces:**
- Consumes: the test harness that boots the real app against Postgres and fakes the Paystack seam.

- [ ] **Step 1: Write the e2e spec** (skips unless `DATABASE_URL` is set, matching the existing suites).

```ts
// Boots the real app + Prisma against Postgres; fakes Paystack/auth/queue like
// money-safety.e2e-spec.ts. Uses two merchants created via MerchantsService, then
// drives the /v1 API with each merchant's API key.
describe('EaaS tenancy (e2e)', () => {
  // Skip guard identical to money-safety.e2e-spec.ts:
  //   const maybe = process.env.DATABASE_URL ? describe : describe.skip;

  it('a /v1 call with no API key 401s; with a valid key it succeeds', async () => {
    // POST /v1/sellers with no Authorization -> 401
    // POST /v1/sellers with `Bearer <merchantA test key>` -> 201, seller belongs to A
  });

  it('merchant A cannot read merchant B\'s transaction (404, not 403)', async () => {
    // A creates a seller + transaction; B (different key) GET /v1/transactions/:id -> 404
  });

  it('merchant A cannot create a transaction for merchant B\'s seller (404)', async () => {
    // B creates seller sB; A POST /v1/transactions { sellerId: sB } -> 404
  });

  it('a sk_live key is rejected (403) until the admin enables livemode', async () => {
    // issue a live key for A (livemodeEnabled=false) -> /v1 call 403;
    // setLivemodeEnabled(A, true) -> same call succeeds
  });

  it('full lifecycle stays merchant-scoped and honors rules 1-6', async () => {
    // A: create seller + recipient (faked Paystack resolve/recipient) ->
    // create tx -> publish -> simulate hosted pay + signed charge.success (protect) ->
    // buyer confirm -> release -> exactly one Paystack transfer to A's seller;
    // assert the transaction, payout, and audit rows all carry merchantId = A.
  });
});
```

- [ ] **Step 2: Implement the spec** using the harness helpers (mirror the setup in `test/money-safety.e2e-spec.ts`; create merchants + keys through `MerchantsService`, issue requests with `supertest` and the `Authorization: Bearer sk_...` header).

- [ ] **Step 3: Run the e2e suite**

Run: `npm run db:up && npm run db:migrate:test && npm run test:e2e`
Expected: all EaaS tenancy specs PASS alongside the existing suites.

- [ ] **Step 4: Full verification**

Run: `npm run lint && npm run build && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add test/eaas-tenancy.e2e-spec.ts
git commit -m "test(eaas): cross-tenant isolation + merchant-scoped lifecycle e2e"
```

---

### Task 11: Document Slice 1 in CLAUDE.md + readiness

**Files:**
- Modify: `CLAUDE.md` (Status section — add an `eaas/` bullet)
- Modify: `docs/PRODUCTION_READINESS.md` (note the NG multi-tenant-custody licensing dependency; new env `EAAS_API_KEY_SECRET`)

- [ ] **Step 1: Add a Status bullet to CLAUDE.md** summarizing: Merchant/MerchantApiKey, ApiKeyGuard, `merchantId` tenancy, `/v1` sellers+transactions, admin merchant CRUD, isolation invariant, custody = platform, licensing gating in readiness; new env `EAAS_API_KEY_SECRET`; migration `20260807000000_eaas_tenancy`.

- [ ] **Step 2: Add a readiness line** under §6 Compliance: multi-tenant fund custody multiplies the NG licensing question; blocker before onboarding a real external merchant to livemode.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/PRODUCTION_READINESS.md
git commit -m "docs(eaas): record Slice 1 tenancy + API-key layer, custody licensing dependency"
```

---

## Self-Review

**Spec coverage:**
- Custody=platform → no new money path; hosted pay page + existing webhook reused (Task 8 note, Task 10 lifecycle). ✓
- Merchant→Seller(1..n) → `MerchantSellersService` mints scoped sellers, recipient per seller (Task 6, 8). ✓
- S2S API-key auth → crypto (2), config (3), service (4), guard (5). ✓
- Tenancy columns + isolation invariant → schema (1), scoped methods (6,7), e2e (10). ✓
- `/v1` core endpoints (create seller/recipient/list/get, create/list/get/publish tx) → Task 8. ✓
- Test mode via `sk_test`/`sk_live` + `livemodeEnabled` gate → guard (5), admin toggle (9), e2e (10). ✓
- Admin onboarding → Task 9. ✓
- Money-safety unchanged (rules 1–6) → asserted in e2e (10). ✓

**Placeholder scan:** Task 10's spec bodies are described as comments because they depend on the existing harness's exact helper names, which the implementer will read from `test/money-safety.e2e-spec.ts`; each `it` states the precise arrange/act/assert. All other code steps are concrete. No "TBD/TODO".

**Type consistency:** `MerchantContext {id,livemode}` used identically in guard/decorator/controllers. `verifyKey` returns `{merchant,livemode}` — consumed as such in guard. `createDraft` gains `merchantId?` — written in Task 7, passed in Task 8. `assertOwnedSeller(merchantId, sellerId)` — defined Task 6, called Tasks 8. Consistent.

**Scope:** Single implementation plan, one subsystem (the tenancy/auth/`/v1` shell). Slices 2 (outbound webhooks) and 3 (dev ergonomics) are separate specs. Focused.
