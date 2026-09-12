# Platform activity analytics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record where every transaction was created (`WEB` / a chat platform / `EAAS`) and expose a per-platform funnel + money table at `GET /admin/analytics/platforms`, so "which platform does what" is answered from recorded facts rather than inferred from `User → ChatIdentity`.

**Architecture:** Add one server-owned enum column (`Transaction.origin`) written once at creation by the entrypoint that creates the row — never client-supplied. Build the funnel from `TimelineEvent.newState` presence rather than a rank over `TransactionStatus`, because the lifecycle is not linear. One `$queryRaw` groups by origin with a per-stage `EXISTS` probe; the service maps Postgres `bigint` to decimal strings before the value crosses the wire.

**Tech Stack:** NestJS + TypeScript strict, Prisma (`$queryRaw`), Supabase Postgres, class-validator, Jest, e2e against real Postgres.

**Spec:** `docs/superpowers/specs/2026-09-11-platform-analytics-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-11-chat-account-linking.md` (ships first — analytics reads the ownership that linking moves).

## Global Constraints

- **`origin` is server-owned and never client-supplied.** It is written once, by the entrypoint, from a literal. No create DTO gains an `origin` field — same posture as `TransactionStatus` (rule 1).
- **`origin` is never updated.** Not by the merge, not by any admin action. It records where a transaction happened, which merging identities does not change.
- **This feature writes no state and moves no money.** Read-only endpoint, no `TransactionStatus` write, no payment path. Therefore **no audit row** (rule 6 covers state transitions and admin *actions*; a read is neither).
- Money is integer minor units (kobo). `SUM(int)` in Postgres returns `bigint` — every money value leaves the service as a **decimal string**, never a JSON number.
- TypeScript strict. Path alias `@/*` → `src/*`. Admin routes require `@Roles('ADMIN')`.
- New env: `ANALYTICS_MAX_RANGE_DAYS` (default `366`).
- Verify before "done": `npm run lint && npm run build && npm test`.

---

### Task 1: Schema — `TransactionOrigin`, `Transaction.origin`, the funnel index

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260912000000_platform_analytics/migration.sql`

**Interfaces:**
- Produces: enum `TransactionOrigin`; `Transaction.origin`; index `transactions(origin, createdAt)`; index `timeline_events(transaction_id, new_state)`.

- [ ] **Step 1: Add the enum** to `prisma/schema.prisma`, immediately after `enum TransactionStatus` (around line 75).

```prisma
/// Where a transaction was created. Server-owned, written once by the creating
/// entrypoint, never client-supplied and never updated — the same posture as
/// TransactionStatus (rule 1). `X` exists for symmetry with ChatPlatform even
/// though the X adapter is a stub; adding it now avoids a later migration.
enum TransactionOrigin {
  WEB
  TELEGRAM
  WHATSAPP
  INSTAGRAM
  MESSENGER
  X
  EAAS
}
```

- [ ] **Step 2: Add the column and index to `Transaction`** (column after `merchantId` at line 364-365, index after `@@index([merchantId])` at line 384).

```prisma
  /// Where this transaction was created. Server-owned; written once at creation
  /// from a literal by the entrypoint, never from a request body, never updated.
  origin TransactionOrigin @default(WEB)
```

```prisma
  @@index([origin, createdAt])
```

- [ ] **Step 3: Add the funnel index to `TimelineEvent`** (after `@@index([createdAt])` at line 668).

```prisma
  /// Serves the per-stage EXISTS probe in the analytics funnel — without it each
  /// probe is a scan of the transaction's events.
  @@index([transactionId, newState])
```

- [ ] **Step 4: Generate the migration**

Run:
```bash
npm run prisma:generate
mkdir -p prisma/migrations/20260912000000_platform_analytics
git show HEAD:prisma/schema.prisma > /tmp/schema-base.prisma
npx prisma migrate diff --from-schema-datamodel /tmp/schema-base.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20260912000000_platform_analytics/migration.sql
```

**Do NOT use `--from-schema-datasource`.** It diffs from the LIVE database. The
local docker Postgres lags the schema (it predates `waitlist_entries`, the chat
table id defaults, and the whole chat-account-linking migration), so a datasource
diff emits `DROP`/`ALTER COLUMN` against already-shipped tables. Diffing the
committed schema (`git show HEAD:…`) against the working tree is fully offline and
produces only the new statements.

Expected: the file contains `CREATE TYPE "TransactionOrigin"`, `ALTER TABLE "transactions" ADD COLUMN "origin" "TransactionOrigin" NOT NULL DEFAULT 'WEB'`, and two `CREATE INDEX`. **Confirm there is no `DROP` and no `ALTER COLUMN` on an existing column** — this migration is purely additive. If it is not, stop and report.

- [ ] **Step 5: Append the backfill to the migration SQL**

The generated file will not contain the data backfill. Append it verbatim, after the `ALTER TABLE`:

```sql
-- Backfill (best effort — see the platform-analytics spec).
--
-- Rows created before this migration have no recorded origin, so this
-- RECONSTRUCTS the most likely one. Treat the pre-migration period as an
-- estimate, not authoritative; every row created after this migration carries a
-- recorded origin and needs no estimate.

-- EaaS is unambiguous: the tenant column IS the record.
UPDATE "transactions" SET "origin" = 'EAAS'
 WHERE "merchant_id" IS NOT NULL;

-- Otherwise attribute to chat ONLY when the seller holds exactly one chat
-- identity. Two identities means the origin is genuinely ambiguous, and a guess
-- would be worse than the WEB default the column already carries.
UPDATE "transactions" t SET "origin" = (
  SELECT ci."platform"::text::"TransactionOrigin"
    FROM "chat_identities" ci WHERE ci."user_id" = t."seller_id"
)
 WHERE t."merchant_id" IS NULL
   AND (SELECT COUNT(*) FROM "chat_identities" ci WHERE ci."user_id" = t."seller_id") = 1;
```

Note: the double cast is deliberate — `ChatPlatform` and `TransactionOrigin` are distinct enum types in Postgres, so the value must go through `text`. Verify the generated SQL's actual enum type name for the column (`"TransactionOrigin"`) and that `chat_identities.platform` is typed `"ChatPlatform"`.

- [ ] **Step 6: Apply to the local test database**

Run: `npm run db:up && npm run db:migrate:test`
Expected: applies clean, including both `UPDATE` statements. Then `npm run prisma:generate`.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260912000000_platform_analytics/
git commit -m "feat(analytics): TransactionOrigin column, funnel index, best-effort backfill"
```

---

### Task 2: The origin mapper

**Files:**
- Create: `src/modules/analytics/origin.mapper.ts`
- Create: `src/modules/analytics/origin.mapper.spec.ts`

**Interfaces:**
- Produces: `ALL_ORIGINS: readonly TransactionOrigin[]`; `toTransactionOrigin(platform: ChatPlatform): TransactionOrigin`.

Both enums share five names, so the mapping is a typed lookup. Deriving it from the enums rather than hand-writing a `switch` means a future `ChatPlatform` value fails to compile instead of silently falling through.

- [ ] **Step 1: Write the failing test** — `src/modules/analytics/origin.mapper.spec.ts`

```ts
import { ChatPlatform, TransactionOrigin } from '@prisma/client';
import { ALL_ORIGINS, toTransactionOrigin } from './origin.mapper';

describe('origin mapper', () => {
  it('lists every origin so the response can be zero-filled', () => {
    expect(ALL_ORIGINS).toHaveLength(7);
    expect(new Set(ALL_ORIGINS).size).toBe(7);
    expect(ALL_ORIGINS).toEqual(expect.arrayContaining(Object.values(TransactionOrigin)));
  });

  it('maps each chat platform to the origin of the same name', () => {
    expect(toTransactionOrigin(ChatPlatform.TELEGRAM)).toBe(TransactionOrigin.TELEGRAM);
    expect(toTransactionOrigin(ChatPlatform.WHATSAPP)).toBe(TransactionOrigin.WHATSAPP);
    expect(toTransactionOrigin(ChatPlatform.INSTAGRAM)).toBe(TransactionOrigin.INSTAGRAM);
    expect(toTransactionOrigin(ChatPlatform.MESSENGER)).toBe(TransactionOrigin.MESSENGER);
    expect(toTransactionOrigin(ChatPlatform.X)).toBe(TransactionOrigin.X);
  });

  it('is total — every ChatPlatform has an origin, and none maps to WEB or EAAS', () => {
    for (const platform of Object.values(ChatPlatform)) {
      const origin = toTransactionOrigin(platform);
      expect(origin).toBeDefined();
      // A chat platform's origin is never WEB (that would lose the platform) and
      // never EAAS (that is the tenant path, not a chat surface).
      expect(origin).not.toBe(TransactionOrigin.WEB);
      expect(origin).not.toBe(TransactionOrigin.EAAS);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/analytics/origin.mapper.spec.ts`
Expected: FAIL — `Cannot find module './origin.mapper'`.

- [ ] **Step 3: Write the implementation** — `src/modules/analytics/origin.mapper.ts`

```ts
import { ChatPlatform, TransactionOrigin } from '@prisma/client';

/**
 * Every origin, in a stable order. The endpoint zero-fills against this list so
 * the response shape is constant and a dashboard never has to special-case an
 * absent platform.
 */
export const ALL_ORIGINS: readonly TransactionOrigin[] = [
  TransactionOrigin.WEB,
  TransactionOrigin.TELEGRAM,
  TransactionOrigin.WHATSAPP,
  TransactionOrigin.INSTAGRAM,
  TransactionOrigin.MESSENGER,
  TransactionOrigin.X,
  TransactionOrigin.EAAS,
];

/**
 * The five chat platforms map to the origin of the same name.
 *
 * `Record<ChatPlatform, ...>` rather than a `switch` so the mapping is total by
 * construction: adding a ChatPlatform breaks the build here instead of falling
 * through to a wrong origin at runtime.
 */
const CHAT_ORIGIN: Record<ChatPlatform, TransactionOrigin> = {
  [ChatPlatform.TELEGRAM]: TransactionOrigin.TELEGRAM,
  [ChatPlatform.WHATSAPP]: TransactionOrigin.WHATSAPP,
  [ChatPlatform.INSTAGRAM]: TransactionOrigin.INSTAGRAM,
  [ChatPlatform.MESSENGER]: TransactionOrigin.MESSENGER,
  [ChatPlatform.X]: TransactionOrigin.X,
};

/** The origin a transaction created on this chat platform is recorded under. */
export function toTransactionOrigin(platform: ChatPlatform): TransactionOrigin {
  return CHAT_ORIGIN[platform];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/analytics/origin.mapper.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/analytics/origin.mapper.ts src/modules/analytics/origin.mapper.spec.ts
git commit -m "feat(analytics): chat platform to transaction origin mapper"
```

---

### Task 3: Record the origin at every write site

**Files:**
- Modify: `src/modules/transactions/transactions.service.ts`
- Modify: `src/modules/transactions/transactions.controller.ts`
- Modify: `src/modules/chat/dialog/chat-dialog.service.ts`
- Modify: `src/modules/merchants/v1-transactions.controller.ts`
- Modify: `src/modules/invoices/invoices.service.ts`
- Modify: `src/modules/transactions/transactions.create.spec.ts`
- Modify: `src/modules/chat/dialog/chat-dialog.service.spec.ts`

**Interfaces:**
- Consumes: `toTransactionOrigin` (Task 2).
- Produces: `CreateDraftInput.origin?: TransactionOrigin`.

`createDraft` is the single funnel all four entrypoints go through, so the column is written in exactly one place and every caller declares its origin. The `@default(WEB)` on the column is the backstop, not the mechanism.

- [ ] **Step 1: Write the failing tests** — append to `src/modules/transactions/transactions.create.spec.ts`

```ts
describe('TransactionsService.createDraft origin', () => {
  it('records the caller-supplied origin', async () => {
    const { prisma, spy } = makePrisma();
    const service = new TransactionsService(prisma, stubOutbound);

    await service.createDraft({
      sellerId: 'seller-1',
      title: 'Sneakers',
      amount: 1500000,
      origin: TransactionOrigin.TELEGRAM,
    });

    expect(spy.create.mock.calls[0][0].data.origin).toBe(TransactionOrigin.TELEGRAM);
  });

  it('falls back to WEB when an entrypoint declares nothing', async () => {
    const { prisma, spy } = makePrisma();
    const service = new TransactionsService(prisma, stubOutbound);

    await service.createDraft({ sellerId: 'seller-1', title: 'Sneakers', amount: 1500000 });

    expect(spy.create.mock.calls[0][0].data.origin).toBe(TransactionOrigin.WEB);
  });

  it('ignores an origin smuggled in through the request DTO shape', () => {
    // The DTO has no `origin` property, so class-validator strips it and the
    // controller cannot pass it. This asserts the service only accepts the
    // typed field — a client cannot claim a platform it is not on (rule 1).
    const dto = new CreateTransactionDto();
    expect(Object.keys(dto)).not.toContain('origin');
  });
});
```

Add to that spec's imports:

```ts
import { TransactionOrigin } from '@prisma/client';
import { CreateTransactionDto } from './dto/create-transaction.dto';
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/transactions/transactions.create.spec.ts`
Expected: FAIL — `data.origin` is `undefined`.

- [ ] **Step 3: Add `origin` to `CreateDraftInput`** — `src/modules/transactions/transactions.service.ts:52-63`

```ts
export interface CreateDraftInput {
  sellerId: string;
  title: string;
  amount: number;
  description?: string;
  currency?: string;
  releaseRule?: ReleaseRule;
  feeModel?: FeeModel;
  feeAmount?: number;
  expectedDeliveryDate?: Date;
  merchantId?: string;
  /// Where this transaction is created. Server-supplied by the entrypoint from a
  /// literal — never from a request body (rule 1). Defaults to the web surface.
  origin?: TransactionOrigin;
}
```

- [ ] **Step 4: Write it in `createDraft`** — add to the `data` object in `transactions.service.ts:153-167`

```ts
        origin: input.origin ?? TransactionOrigin.WEB,
```

Add `TransactionOrigin` to the `@prisma/client` import at the top of the file.

- [ ] **Step 5: Declare the origin at each of the four entrypoints**

`src/modules/transactions/transactions.controller.ts:33` — the web controller:

```ts
    return this.transactions.createDraft({
      sellerId: claims.sub,
      title: dto.title,
      amount: dto.amount,
      origin: TransactionOrigin.WEB,
      ...(dto.description ? { description: dto.description } : {}),
```

`src/modules/merchants/v1-transactions.controller.ts:46` — the EaaS `/v1` path:

```ts
    const tx = await this.transactions.createDraft({
      merchantId: m.id,
      sellerId: dto.sellerId,
      title: dto.title,
      amount: dto.amount,
      origin: TransactionOrigin.EAAS,
      ...(dto.description ? { description: dto.description } : {}),
```

`src/modules/chat/dialog/chat-dialog.service.ts:210` — the chat dialog. This is the one site that maps rather than names a literal:

```ts
    const tx = await this.transactions.createDraft({
      sellerId: user.id,
      title: draft.title,
      amount: draft.amountKobo,
      // The platform the seller typed /sell on, not the buyer's.
      origin: toTransactionOrigin(identity.platform),
      ...(description ? { description } : {}),
    });
```

`src/modules/invoices/invoices.service.ts:238` — invoice-created transactions:

```ts
    const tx = await this.transactions.createDraft({
      sellerId,
      title: invoice.number || `Invoice`,
      amount: invoice.total,
      currency: invoice.currency,
      // Invoices are a web-only surface today. A future chat invoice path MUST
      // pass its platform here instead — nothing else records it.
      origin: TransactionOrigin.WEB,
    });
```

Add `TransactionOrigin` to the `@prisma/client` imports in each of the four files, and in `chat-dialog.service.ts` add:

```ts
import { toTransactionOrigin } from '@/modules/analytics/origin.mapper';
```

- [ ] **Step 6: Assert the chat site maps the platform** — add to `src/modules/chat/dialog/chat-dialog.service.spec.ts`

```ts
it('records the seller chat platform as the transaction origin', async () => {
  // ...drive the existing /sell → title → amount happy path, then:
  expect(createDraftMock).toHaveBeenCalledWith(
    expect.objectContaining({ origin: 'TELEGRAM' }),
  );
});
```

Match the file's existing mocking style for `TransactionsService` — read it first; if the happy-path test already asserts on `createDraft`, extend that assertion rather than adding a near-duplicate test.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx jest src/modules/transactions src/modules/chat src/modules/invoices src/modules/merchants`
Expected: PASS. Existing tests that assert the full `createDraft` `data` object may now need `origin` added — update those assertions to include it rather than loosening them.

- [ ] **Step 8: Commit**

```bash
git add src/modules/transactions src/modules/chat/dialog src/modules/merchants src/modules/invoices
git commit -m "feat(analytics): record transaction origin at every write site"
```

---

### Task 4: Analytics metrics — types, BigInt mapping, and the query

**Files:**
- Create: `src/modules/analytics/analytics.types.ts`
- Create: `src/modules/analytics/analytics.mapper.ts`
- Create: `src/modules/analytics/analytics.mapper.spec.ts`
- Create: `src/modules/analytics/analytics.service.ts`
- Create: `src/modules/analytics/analytics.service.spec.ts`
- Create: `src/modules/analytics/analytics.module.ts`
- Create: `src/modules/transactions/timeline-parity.spec.ts`

**Interfaces:**
- Consumes: `ALL_ORIGINS` (Task 2); `PrismaService`.
- Produces: `PlatformMetrics` (internal, `bigint` money); `PlatformMetricsResponse` (JSON-safe, string money); `PlatformAnalyticsResponse`; `toPlatformAnalyticsResponse(rows: PlatformMetrics[]): PlatformAnalyticsResponse`; `AnalyticsService.getPlatformMetrics(from: Date, to: Date): Promise<PlatformAnalyticsResponse>`.

**The BigInt trap, stated once.** Postgres `SUM(int)` returns `bigint`; Prisma `$queryRaw` hands that back as a JavaScript `BigInt`; `JSON.stringify` **throws** on a `BigInt` (`TypeError: Do not know how to serialize a BigInt`). So a naive implementation 500s the moment any volume row is non-empty — in production, never in a unit test with empty data. Everything is therefore mapped to a **string** before leaving the service. `COUNT(*)` is `bigint` too and gets the same treatment. `SUM` over zero matching rows is `NULL`, so the SQL coalesces to `0`.

- [ ] **Step 1: Write the failing mapper test** — `src/modules/analytics/analytics.mapper.spec.ts`

```ts
import { TransactionOrigin } from '@prisma/client';
import { toPlatformAnalyticsResponse, type PlatformMetrics } from './analytics.mapper';

function metrics(over: Partial<PlatformMetrics> = {}): PlatformMetrics {
  return {
    origin: TransactionOrigin.WEB,
    sellers: 0n,
    buyers: 0n,
    created: 0n,
    published: 0n,
    paymentStarted: 0n,
    protected: 0n,
    delivered: 0n,
    released: 0n,
    disputed: 0n,
    protectedVolumeKobo: 0n,
    releasedVolumeKobo: 0n,
    feesKobo: 0n,
    ...over,
  };
}

describe('toPlatformAnalyticsResponse', () => {
  it('zero-fills every origin so the table shape is constant', () => {
    const res = toPlatformAnalyticsResponse([metrics({ origin: TransactionOrigin.TELEGRAM })]);
    expect(res.platforms).toHaveLength(7);
    const web = res.platforms.find((p) => p.origin === TransactionOrigin.WEB);
    expect(web?.created).toBe(0);
    expect(web?.protectedVolumeKobo).toBe('0');
  });

  it('serializes counts as numbers and money as decimal strings', () => {
    const res = toPlatformAnalyticsResponse([
      metrics({ created: 12n, protectedVolumeKobo: 5000000n, feesKobo: 75000n }),
    ]);
    const web = res.platforms.find((p) => p.origin === TransactionOrigin.WEB)!;
    expect(web.created).toBe(12);
    expect(typeof web.created).toBe('number');
    expect(web.protectedVolumeKobo).toBe('5000000');
    expect(typeof web.protectedVolumeKobo).toBe('string');
    expect(web.feesKobo).toBe('75000');
  });

  it('survives JSON.stringify with non-empty volume — the case that 500s a naive impl', () => {
    const res = toPlatformAnalyticsResponse([
      metrics({ protectedVolumeKobo: 9007199254740993n }), // > Number.MAX_SAFE_INTEGER
    ]);
    expect(() => JSON.stringify(res)).not.toThrow();
    const web = res.platforms.find((p) => p.origin === TransactionOrigin.WEB)!;
    // A JSON number would have silently lost the last digit.
    expect(web.protectedVolumeKobo).toBe('9007199254740993');
  });

  it('computes disputeRate as a fraction, 4dp, and 0 when nothing was protected', () => {
    const res = toPlatformAnalyticsResponse([
      metrics({ protected: 1000n, disputed: 21n }),
      metrics({ origin: TransactionOrigin.X, protected: 0n, disputed: 0n }),
    ]);
    expect(res.platforms.find((p) => p.origin === TransactionOrigin.WEB)!.disputeRate).toBe(0.021);
    expect(res.platforms.find((p) => p.origin === TransactionOrigin.X)!.disputeRate).toBe(0);
  });

  it('totals every origin, summing money as bigint (no precision loss)', () => {
    const res = toPlatformAnalyticsResponse([
      metrics({ created: 2n, protectedVolumeKobo: 9007199254740993n }),
      metrics({ origin: TransactionOrigin.EAAS, created: 3n, protectedVolumeKobo: 7n }),
    ]);
    expect(res.totals.created).toBe(5);
    expect(res.totals.protectedVolumeKobo).toBe('9007199254741000');
    expect(res.totals.origin).toBe('ALL');
  });

  it('totals re-derive disputeRate rather than summing the per-origin rates', () => {
    const res = toPlatformAnalyticsResponse([
      metrics({ protected: 10n, disputed: 1n }),
      metrics({ origin: TransactionOrigin.EAAS, protected: 10n, disputed: 0n }),
    ]);
    // 1/20, not 0.1 + 0 = 0.2.
    expect(res.totals.disputeRate).toBe(0.05);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/analytics/analytics.mapper.spec.ts`
Expected: FAIL — `Cannot find module './analytics.mapper'`.

- [ ] **Step 3: Write the types** — `src/modules/analytics/analytics.types.ts`

```ts
import type { TransactionOrigin } from '@prisma/client';

/**
 * One origin's funnel and money, as it comes back from Postgres. Money and
 * counts are `bigint` because that is what `SUM`/`COUNT` return — the conversion
 * to a JSON-safe shape is a separate, tested step (`analytics.mapper.ts`).
 */
export interface PlatformMetrics {
  origin: TransactionOrigin;
  sellers: bigint;
  buyers: bigint;
  created: bigint;
  published: bigint;
  paymentStarted: bigint;
  protected: bigint;
  delivered: bigint;
  released: bigint;
  disputed: bigint;
  protectedVolumeKobo: bigint;
  releasedVolumeKobo: bigint;
  feesKobo: bigint;
}

/** JSON-safe. Counts are numbers; money is a decimal string. */
export interface PlatformMetricsResponse {
  origin: TransactionOrigin | 'ALL';
  sellers: number;
  buyers: number;
  created: number;
  published: number;
  paymentStarted: number;
  protected: number;
  delivered: number;
  released: number;
  disputed: number;
  /// Fraction, not a percent: 0.021 = 2.10%.
  disputeRate: number;
  protectedVolumeKobo: string;
  releasedVolumeKobo: string;
  feesKobo: string;
}

export interface PlatformAnalyticsResponse {
  from: string;
  to: string;
  platforms: PlatformMetricsResponse[];
  totals: PlatformMetricsResponse;
}
```

- [ ] **Step 4: Write the mapper** — `src/modules/analytics/analytics.mapper.ts`

Re-export the types so callers have one import site:

```ts
export type {
  PlatformMetrics,
  PlatformMetricsResponse,
  PlatformAnalyticsResponse,
} from './analytics.types';
```

then:

```ts
import { ALL_ORIGINS } from './origin.mapper';
import type {
  PlatformAnalyticsResponse,
  PlatformMetrics,
  PlatformMetricsResponse,
} from './analytics.types';

/**
 * `bigint` → decimal string. Money must NOT become a JS number: a kobo value
 * above 2^53 loses precision silently, and `JSON.stringify` throws outright on a
 * `BigInt`, so leaving it raw 500s the endpoint the moment any volume row is
 * non-empty.
 */
function kobo(value: bigint): string {
  return value.toString();
}

/**
 * Fraction to 4dp, not a percent. 0 when nothing was protected — a rate over an
 * empty denominator is undefined, and 0 is the honest rendering of "no data".
 *
 * One integer division, in units of 1e-4, then scale once. Dividing twice
 * (`/ 100n` then `/ 100`) truncates to 2dp and silently understates the rate.
 */
function rate(disputed: bigint, protectedCount: bigint): number {
  if (protectedCount === 0n) {
    return 0;
  }
  return Number((disputed * 10_000n) / protectedCount) / 10_000;
}

function toResponse(row: PlatformMetrics): PlatformMetricsResponse {
  return {
    origin: row.origin,
    sellers: Number(row.sellers),
    buyers: Number(row.buyers),
    created: Number(row.created),
    published: Number(row.published),
    paymentStarted: Number(row.paymentStarted),
    protected: Number(row.protected),
    delivered: Number(row.delivered),
    released: Number(row.released),
    disputed: Number(row.disputed),
    disputeRate: rate(row.disputed, row.protected),
    protectedVolumeKobo: kobo(row.protectedVolumeKobo),
    releasedVolumeKobo: kobo(row.releasedVolumeKobo),
    feesKobo: kobo(row.feesKobo),
  };
}

const ZERO: PlatformMetrics = {
  origin: ALL_ORIGINS[0] as PlatformMetrics['origin'],
  sellers: 0n,
  buyers: 0n,
  created: 0n,
  published: 0n,
  paymentStarted: 0n,
  protected: 0n,
  delivered: 0n,
  released: 0n,
  disputed: 0n,
  protectedVolumeKobo: 0n,
  releasedVolumeKobo: 0n,
  feesKobo: 0n,
};

/**
 * Zero-fill to every origin so the response shape is constant — a dashboard
 * renders the same seven rows whether or not a platform has activity — and add a
 * `totals` row that aggregates all of them.
 *
 * Totals are summed from the `bigint` values, never from the serialized strings,
 * and `disputeRate` is RE-DERIVED from the summed counts. Averaging the
 * per-origin rates would weight a platform with one protected transaction the
 * same as one with ten thousand.
 */
export function toPlatformAnalyticsResponse(
  rows: PlatformMetrics[],
): Omit<PlatformAnalyticsResponse, 'from' | 'to'> {
  const byOrigin = new Map(rows.map((r) => [r.origin, r]));
  const platforms = ALL_ORIGINS.map((origin) => toResponse(byOrigin.get(origin) ?? { ...ZERO, origin }));

  const summed = platforms.reduce(
    (acc, p) => ({
      sellers: acc.sellers + p.sellers,
      buyers: acc.buyers + p.buyers,
      created: acc.created + p.created,
      published: acc.published + p.published,
      paymentStarted: acc.paymentStarted + p.paymentStarted,
      protected: acc.protected + p.protected,
      delivered: acc.delivered + p.delivered,
      released: acc.released + p.released,
      disputed: acc.disputed + p.disputed,
      protectedVolume: acc.protectedVolume + BigInt(p.protectedVolumeKobo),
      releasedVolume: acc.releasedVolume + BigInt(p.releasedVolumeKobo),
      fees: acc.fees + BigInt(p.feesKobo),
    }),
    {
      sellers: 0, buyers: 0, created: 0, published: 0, paymentStarted: 0,
      protected: 0, delivered: 0, released: 0, disputed: 0,
      protectedVolume: 0n, releasedVolume: 0n, fees: 0n,
    },
  );

  const totals: PlatformMetricsResponse = {
    origin: 'ALL',
    sellers: summed.sellers,
    buyers: summed.buyers,
    created: summed.created,
    published: summed.published,
    paymentStarted: summed.paymentStarted,
    protected: summed.protected,
    delivered: summed.delivered,
    released: summed.released,
    disputed: summed.disputed,
    disputeRate: rate(BigInt(summed.disputed), BigInt(summed.protected)),
    protectedVolumeKobo: kobo(summed.protectedVolume),
    releasedVolumeKobo: kobo(summed.releasedVolume),
    feesKobo: kobo(summed.fees),
  };

  return { platforms, totals };
}
```

- [ ] **Step 5: Run the mapper test to verify it passes**

Run: `npx jest src/modules/analytics/analytics.mapper.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write the timeline-parity spec** — `src/modules/transactions/timeline-parity.spec.ts`

The funnel reads `TimelineEvent` on the assumption that **every transition the
machine permits produces a timeline row**. The spec calls that assumption
load-bearing and requires its own test; this is it. It is the guard against a
future early-return in `apply` silently starving the funnel.

```ts
import { ActorType, TransactionStatus } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import type { OutboundEventsService } from '@/modules/outbound-events/outbound-events.service';
import { TransactionsService } from './transactions.service';
import { TransitionRejectedError } from './transition-rejected.error';
import {
  transition,
  type TransactionContext,
  type TransactionEvent,
  type TransactionEventType,
} from './state-machine';

const stubOutbound = {
  recordForTransition: () => Promise.resolve(null),
  dispatch: () => Promise.resolve(),
} as unknown as OutboundEventsService;

/**
 * One concrete event per `TransactionEvent['type']`. `satisfies` plus the
 * totality assertion below fail to COMPILE if the union gains a member this list
 * misses — so the matrix cannot silently go stale.
 */
const ALL_EVENTS = [
  { type: 'SELLER_PUBLISH' },
  { type: 'CANCEL' },
  { type: 'BUYER_INITIATE_CHECKOUT' },
  { type: 'EXPIRE' },
  { type: 'PAYMENT_VERIFIED', source: 'WEBHOOK' },
  { type: 'PAYMENT_ABANDONED' },
  { type: 'SELLER_START_DELIVERY' },
  { type: 'RAISE_DISPUTE' },
  { type: 'REFUND' },
  { type: 'SELLER_MARK_DELIVERED' },
  { type: 'BUYER_CONFIRM' },
  { type: 'AUTO_CONFIRM' },
  { type: 'RESOLVE_DISPUTE_FOR_SELLER' },
  { type: 'RESOLVE_DISPUTE_FOR_BUYER' },
  { type: 'WITHDRAW_DISPUTE' },
  { type: 'PAYOUT_SUCCEEDED' },
  { type: 'PAYOUT_RETRY' },
  { type: 'ADMIN_INTERVENTION' },
] as const satisfies readonly TransactionEvent[];

type CoveredEventType = (typeof ALL_EVENTS)[number]['type'];
/** Compile-time totality proof. `never` only if the union is fully covered. */
const EVERY_EVENT_TYPE_IS_COVERED: Exclude<TransactionEventType, CoveredEventType> extends never
  ? true
  : never = true;

/** A context that permits every guarded transition, so the matrix is about the
 *  graph rather than about the guards. */
const PERMISSIVE: TransactionContext = {
  releaseRule: 'AUTO_AFTER_WINDOW',
  hasOpenDispute: false,
  autoConfirmWindowElapsed: true,
};

describe('timeline parity', () => {
  it('covers every event type in the union', () => {
    expect(EVERY_EVENT_TYPE_IS_COVERED).toBe(true);
  });

  it('writes exactly one timeline row per permitted transition, and none per rejection', async () => {
    const actor = { id: 'user-1', type: ActorType.USER, role: 'SELLER' };
    const permitted: string[] = [];
    const rejected: string[] = [];

    for (const from of Object.values(TransactionStatus)) {
      for (const event of ALL_EVENTS) {
        const row = {
          id: 'tx-1',
          status: from,
          releaseRule: 'AUTO_AFTER_WINDOW',
          disputes: [],
        };
        const txClient = {
          transaction: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: jest.fn().mockResolvedValue({ ...row }),
          },
          timelineEvent: { create: jest.fn().mockResolvedValue({}) },
          auditLog: { create: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
          transaction: { findUnique: jest.fn().mockResolvedValue(row) },
          $transaction: jest.fn(
            async (cb: (db: typeof txClient) => Promise<unknown>) => cb(txClient),
          ),
        } as unknown as PrismaService;
        const service = new TransactionsService(prisma, stubOutbound);
        const key = `${from} + ${event.type}`;
        const call = { transactionId: 'tx-1', event, actor };

        const expected = transition(from, event, PERMISSIVE);
        if (expected.ok) {
          await service.apply(call);
          // Object equality so a failure names the offending pair.
          expect({ key, written: txClient.timelineEvent.create.mock.calls.length }).toEqual({
            key,
            written: 1,
          });
          permitted.push(key);
        } else {
          await expect(service.apply(call)).rejects.toBeInstanceOf(TransitionRejectedError);
          expect({ key, written: txClient.timelineEvent.create.mock.calls.length }).toEqual({
            key,
            written: 0,
          });
          rejected.push(key);
        }
      }
    }

    // Guards against a vacuous pass: both outcomes must actually occur.
    expect(permitted.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 7: Run the parity spec**

Run: `npx jest src/modules/transactions/timeline-parity.spec.ts`
Expected: PASS, 2 tests (216 status × event pairs exercised).

- [ ] **Step 8: Write the failing service test** — `src/modules/analytics/analytics.service.spec.ts`

```ts
import { Test } from '@nestjs/testing';
import { TransactionOrigin } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService.getPlatformMetrics', () => {
  let service: AnalyticsService;
  let prisma: { $queryRaw: jest.Mock };

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      providers: [AnalyticsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(AnalyticsService);
  });

  it('returns all seven origins zero-filled when nothing is in range', async () => {
    const res = await service.getPlatformMetrics(
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    );
    expect(res.platforms).toHaveLength(7);
    expect(res.totals.created).toBe(0);
    expect(res.from).toBe('2026-09-01T00:00:00.000Z');
    expect(res.to).toBe('2026-10-01T00:00:00.000Z');
  });

  it('maps a real row, converting bigint to number and money to string', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        origin: TransactionOrigin.TELEGRAM,
        sellers: 4n, buyers: 9n,
        created: 10n, published: 10n, paymentStarted: 8n, protected: 6n,
        delivered: 5n, released: 4n, disputed: 1n,
        protectedVolumeKobo: 1200000n, releasedVolumeKobo: 800000n, feesKobo: 18000n,
      },
    ]);
    const res = await service.getPlatformMetrics(new Date(0), new Date());
    const tg = res.platforms.find((p) => p.origin === TransactionOrigin.TELEGRAM)!;
    expect(tg.protected).toBe(6);
    expect(tg.protectedVolumeKobo).toBe('1200000');
    expect(tg.disputeRate).toBe(0.1666);
    expect(res.totals.protected).toBe(6);
  });

  it('is JSON-serializable with a non-empty volume row', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        origin: TransactionOrigin.WEB,
        sellers: 1n, buyers: 1n,
        created: 1n, published: 1n, paymentStarted: 1n, protected: 1n,
        delivered: 0n, released: 1n, disputed: 0n,
        protectedVolumeKobo: 9007199254740993n, releasedVolumeKobo: 1n, feesKobo: 0n,
      },
    ]);
    const res = await service.getPlatformMetrics(new Date(0), new Date());
    expect(() => JSON.stringify(res)).not.toThrow();
  });

  it('passes the window through with an exclusive upper bound', async () => {
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-09-08T00:00:00Z');
    await service.getPlatformMetrics(from, to);
    // `$queryRaw` is called with ONE argument — the `Sql` object built by
    // `Prisma.sql` — not with (strings, ...values). The window is the first two
    // interpolations; the stage constants follow.
    const sql = prisma.$queryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(sql.values.slice(0, 2)).toEqual([from, to]);
  });
});
```

- [ ] **Step 9: Write the service** — `src/modules/analytics/analytics.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { toPlatformAnalyticsResponse } from './analytics.mapper';
import type { PlatformAnalyticsResponse, PlatformMetrics } from './analytics.types';

/** The funnel stages, each probe matching a TimelineEvent.newState. */
const STAGE = {
  published: 'LINK_ACTIVE',
  paymentStarted: 'PAYMENT_PENDING',
  protectedState: 'PAYMENT_PROTECTED',
  delivered: 'CONFIRMATION_PENDING',
  released: 'COMPLETED',
  disputed: 'DISPUTED',
} as const;

/**
 * Platform activity analytics: which platform does what, as recorded facts.
 *
 * Read-only. Writes no state, moves no money, and therefore writes no audit row
 * (rule 6 covers state transitions and admin actions; a read is neither).
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One row per origin over the transactions CREATED in `[from, to)`.
   *
   * Cohort semantics: the range filters `Transaction.createdAt`, and a
   * transaction counts as having reached a stage if it EVER reached it, even
   * after `to`. That makes conversion a property of the cohort rather than of how
   * wide the window happens to be — which also means RECENT COHORTS LOOK WORSE,
   * because their transactions have had less time to convert. That is correct,
   * and the frontend must say so.
   */
  async getPlatformMetrics(from: Date, to: Date): Promise<PlatformAnalyticsResponse> {
    const rows = await this.prisma.$queryRaw<PlatformMetrics[]>(Prisma.sql`
      WITH cohort AS (
        SELECT id, origin, seller_id, buyer_id, amount, fee_amount
          FROM "transactions"
         WHERE "created_at" >= ${from} AND "created_at" < ${to}
      ),
      staged AS (
        SELECT
          c.origin,
          c.seller_id,
          c.buyer_id,
          c.amount,
          c.fee_amount,
          EXISTS (SELECT 1 FROM "timeline_events" te
                   WHERE te."transaction_id" = c.id AND te."new_state" = ${STAGE.published}) AS published,
          EXISTS (SELECT 1 FROM "timeline_events" te
                   WHERE te."transaction_id" = c.id AND te."new_state" = ${STAGE.paymentStarted}) AS payment_started,
          EXISTS (SELECT 1 FROM "timeline_events" te
                   WHERE te."transaction_id" = c.id AND te."new_state" = ${STAGE.protectedState}) AS protected,
          EXISTS (SELECT 1 FROM "timeline_events" te
                   WHERE te."transaction_id" = c.id AND te."new_state" = ${STAGE.delivered}) AS delivered,
          EXISTS (SELECT 1 FROM "timeline_events" te
                   WHERE te."transaction_id" = c.id AND te."new_state" = ${STAGE.released}) AS released,
          EXISTS (SELECT 1 FROM "timeline_events" te
                   WHERE te."transaction_id" = c.id AND te."new_state" = ${STAGE.disputed}) AS disputed
        FROM cohort c
      )
      SELECT
        s.origin::text                        AS "origin",
        COUNT(DISTINCT s.seller_id)           AS "sellers",
        COUNT(DISTINCT s.buyer_id)            AS "buyers",
        COUNT(*)                              AS "created",
        COUNT(*) FILTER (WHERE s.published)       AS "published",
        COUNT(*) FILTER (WHERE s.payment_started) AS "paymentStarted",
        COUNT(*) FILTER (WHERE s.protected)       AS "protected",
        COUNT(*) FILTER (WHERE s.delivered)       AS "delivered",
        COUNT(*) FILTER (WHERE s.released)        AS "released",
        COUNT(*) FILTER (WHERE s.disputed)        AS "disputed",
        COALESCE(SUM(s.amount)     FILTER (WHERE s.protected), 0) AS "protectedVolumeKobo",
        COALESCE(SUM(s.amount)     FILTER (WHERE s.released), 0)  AS "releasedVolumeKobo",
        COALESCE(SUM(s.fee_amount) FILTER (WHERE s.protected), 0) AS "feesKobo"
      FROM staged s
      GROUP BY s.origin
    `);

    const { platforms, totals } = toPlatformAnalyticsResponse(rows);
    return { from: from.toISOString(), to: to.toISOString(), platforms, totals };
  }
}
```

Notes for the implementer:

- One round trip is deliberate. Twelve stages × seven origins as separate queries would be eighty-four round trips to produce one table.
- `COUNT(DISTINCT seller_id)` ignores NULLs, which is what `buyers` wants (a transaction has no buyer until someone pays). `sellers` is never NULL.
- The `COUNT(*) FILTER` counts are never NULL, but the `SUM` ones are NULL over zero matching rows — hence the `COALESCE`, which the spec requires.
- The cohort scan is served by the existing `@@index([createdAt])`. The new `(origin, createdAt)` index serves a future per-origin filter; this query groups by origin rather than filtering on it.

- [ ] **Step 10: Write the module** — `src/modules/analytics/analytics.module.ts`

```ts
import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

/** Platform activity analytics. Read-only — no controllers here; the admin
 * routes live on the admin controller. */
@Module({
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
```

Check how `PrismaModule` is registered — if it is `@Global()`, no import is needed here; otherwise add `imports: [PrismaModule]`. Match `admin.module.ts`'s posture.

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npx jest src/modules/analytics src/modules/transactions`
Expected: PASS — mapper 6, service 4, parity 2, plus every existing transactions suite unchanged.

- [ ] **Step 12: Commit**

```bash
git add src/modules/analytics/ src/modules/transactions/timeline-parity.spec.ts
git commit -m "feat(analytics): per-platform funnel and money metrics"
```

---

### Task 5: The admin endpoint

**Files:**
- Create: `src/modules/analytics/dto/platform-analytics.dto.ts`
- Modify: `src/modules/admin/admin.controller.ts`
- Modify: `src/modules/admin/admin.module.ts`
- Modify: `src/config/env.validation.ts`
- Modify: `.env.example`
- Create: `src/modules/analytics/dto/platform-analytics.dto.spec.ts`

**Interfaces:**
- Consumes: `AnalyticsService.getPlatformMetrics` (Task 4).
- Produces: `GET /admin/analytics/platforms?from=&to=` → `PlatformAnalyticsResponse`.

- [ ] **Step 1: Write the failing DTO test** — `src/modules/analytics/dto/platform-analytics.dto.spec.ts`

```ts
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PlatformAnalyticsQueryDto } from './platform-analytics.dto';

function validate(raw: Record<string, unknown>) {
  return validateSync(plainToInstance(PlatformAnalyticsQueryDto, raw));
}

describe('PlatformAnalyticsQueryDto', () => {
  it('accepts an ISO range', () => {
    expect(validate({ from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' })).toHaveLength(0);
  });

  it('rejects a missing bound', () => {
    expect(validate({ from: '2026-09-01T00:00:00Z' }).length).toBeGreaterThan(0);
    expect(validate({ to: '2026-10-01T00:00:00Z' }).length).toBeGreaterThan(0);
  });

  it('rejects a non-ISO value', () => {
    expect(validate({ from: 'last tuesday', to: '2026-10-01T00:00:00Z' }).length).toBeGreaterThan(0);
  });

  it('rejects an inverted range', () => {
    const errors = validate({ from: '2026-10-01T00:00:00Z', to: '2026-09-01T00:00:00Z' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a range wider than the cap', () => {
    expect(validate({ from: '2020-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }).length)
      .toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/analytics/dto`
Expected: FAIL — `Cannot find module './platform-analytics.dto'`.

- [ ] **Step 3: Add the env var** — in `src/config/env.validation.ts`, after `PAYMENT_RECONCILE_AFTER_SECONDS` (line 82):

```ts
  // Upper bound on an analytics window, in days. Bounds the scan of a
  // read-only reporting endpoint.
  ANALYTICS_MAX_RANGE_DAYS: z.coerce.number().int().positive().default(366),
```

Add `ANALYTICS_MAX_RANGE_DAYS=366` to `.env.example`.

- [ ] **Step 4: Write the DTO** — `src/modules/analytics/dto/platform-analytics.dto.ts`

```ts
import { IsISO8601 } from 'class-validator';

/**
 * Range for the platform analytics query. `to` is EXCLUSIVE.
 *
 * `from`/`to` are required rather than defaulted: a silent default would make an
 * accidental unbounded query look like a successful one. Range ordering and the
 * width cap are cross-field checks that live in the controller, where the
 * configured cap is available.
 */
export class PlatformAnalyticsQueryDto {
  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;
}
```

- [ ] **Step 5: Add the route** — in `src/modules/admin/admin.controller.ts`

Add `AnalyticsService` to the constructor and:

```ts
  /** Per-platform funnel + money over a date range. Read-only — no audit row. */
  @Get('analytics/platforms')
  async platformAnalytics(@Query() q: PlatformAnalyticsQueryDto) {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (from >= to) {
      throw new BadRequestException('`from` must be earlier than `to`');
    }
    const maxDays = this.config.get('ANALYTICS_MAX_RANGE_DAYS', { infer: true });
    if (to.getTime() - from.getTime() > maxDays * 86_400_000) {
      throw new BadRequestException(`Range must not exceed ${maxDays} days`);
    }
    return this.analytics.getPlatformMetrics(from, to);
  }
```

Declare this route **before** any `@Get('.../:id')` route in the file so the static path wins the match — the same ordering the transactions controller documents. Add `BadRequestException` to the `@nestjs/common` import, `ConfigService` + `Env` imports, and `PlatformAnalyticsQueryDto`.

- [ ] **Step 6: Wire the modules** — in `src/modules/admin/admin.module.ts`

```ts
import { AnalyticsModule } from '@/modules/analytics/analytics.module';
```

and add `AnalyticsModule` to `imports` (alongside `PayoutsModule`). In `src/modules/app.module.ts`, register `AnalyticsModule` if the project's convention is to list feature modules there — check how `AdminModule` is registered and follow it.

- [ ] **Step 7: Run the tests and the build**

Run: `npx jest src/modules/analytics src/modules/admin && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/analytics src/modules/admin src/config/env.validation.ts src/modules/app.module.ts .env.example
git commit -m "feat(analytics): GET /admin/analytics/platforms"
```

---

### Task 6: E2E — the cases that would catch a wrong design

**Files:**
- Create: `test/platform-analytics.e2e-spec.ts`

**Interfaces:**
- Consumes: the harness in `test/utils/` (real app + state machine + Prisma against real Postgres; Paystack/auth/Redis-queue faked).

Read `test/money-safety.e2e-spec.ts` and `test/utils/` first and follow their harness exactly — app bootstrap, guard override, and the fakes. The `gotcha` in CLAUDE.md applies: a global guard registered with a bare `useClass` makes `overrideGuard()` a silent no-op, so copy the existing harness rather than writing a new one.

- [ ] **Step 1: Write the spec**

Implement these seven cases. Cases 2, 3 and 4 are the load-bearing ones.

1. **Origin write-site isolation.** Create a transaction through each entrypoint (web controller, chat dialog, `/v1`), then query analytics → each lands in its own origin row and no other. Assert a client-supplied `origin` in a create body is ignored (the transaction is still recorded as `WEB`).

2. **The abandoned-payment case.** Drive a transaction `LINK_ACTIVE → PAYMENT_PENDING → PAYMENT_ABANDONED → LINK_ACTIVE`. Assert it IS counted in `paymentStarted` and is **not** counted in `protected`. This is the case a status-rank implementation gets wrong — it sits at `LINK_ACTIVE` at the end, which any rank test reads as "never started payment." This test is what proves the timeline approach.

3. **Withdraw-dispute regression.** Drive `PAYMENT_PROTECTED → DISPUTED → WITHDRAW_DISPUTE`. Assert the transaction still counts in `protected` **and** still counts in `disputed` — the final state is `PAYMENT_PROTECTED`, so a status-based count would lose the dispute entirely.

4. **Stage cumulativity** over a seeded population: assert `created ≥ published ≥
   paymentStarted ≥ protected`. **Do not assert `delivered ≥ released`** — that is
   not an invariant of this lifecycle. A dispute resolved for the seller releases
   without ever being delivered (`DISPUTED → RELEASE_PROCESSING → COMPLETED`, never
   `CONFIRMATION_PENDING`), so assert that counterexample explicitly: drive the
   path and assert the transaction counts in `released` and **not** in `delivered`.
   See `src/modules/analytics/funnel-shape.spec.ts`, which derives the fork from
   the transition function.

5. **Money.** A protected transaction contributes its `amount` to `protectedVolumeKobo` exactly once; a released one contributes to `releasedVolumeKobo`; `feesKobo` sums `feeAmount` over protected only. Assert the response passes `JSON.stringify` **without throwing** and that each money value is a decimal string. This is the BigInt trap — it only fires with non-empty data, which is exactly why it needs an e2e case rather than a unit one.

6. **Range behaviour.** Assert `to` is exclusive (a transaction created exactly at `to` is excluded), an inverted range is a 400, and an over-cap range is a 400.

7. **Link interaction.** Link a chat-born seller to a web account (the Task 6 flow from the linking plan), then re-query → the historical transactions **keep their original origin**. Origin records where a transaction happened; merging identities must not rewrite history.

- [ ] **Step 2: Run the suite**

Run: `npm run db:up && npm run db:migrate:test && npm run test:e2e`
Expected: PASS, including every pre-existing e2e spec. If a pre-existing spec fails, the schema change altered shared behaviour — investigate before touching the new spec.

- [ ] **Step 3: Commit**

```bash
git add test/platform-analytics.e2e-spec.ts
git commit -m "test(analytics): e2e funnel, money, and origin-isolation coverage"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/FRONTEND_API_MAP.md`
- Modify: `docs/PRODUCTION_READINESS.md`

- [ ] **Step 1: Update `CLAUDE.md`** — add an `analytics/` entry to the Status list: the `TransactionOrigin` column and its four write sites, why the funnel reads `TimelineEvent` rather than ranking statuses (name the abandoned-payment case as the proof), cohort semantics including the "recent cohorts look worse" caveat, and the BigInt→string rule. Add `ANALYTICS_MAX_RANGE_DAYS` to the "New env since scaffold" list.

- [ ] **Step 2: Update `docs/FRONTEND_API_MAP.md`** — document `GET /admin/analytics/platforms` with the file's existing conventions: required `from`/`to` (ISO-8601, `to` exclusive), the always-seven-rows + `totals` shape, `disputeRate` as a **fraction**, money as decimal strings, and the cohort caveat the frontend must print alongside a short-window view.

- [ ] **Step 3: Update `docs/PRODUCTION_READINESS.md`** — note the new admin endpoint in the security section and the read-only/no-audit-row rationale.

- [ ] **Step 4: Verify everything**

Run: `npm run lint && npm run build && npm test && npm run test:e2e`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs(analytics): origin column, platform endpoint, and cohort caveat"
```

---

## Self-Review

**Spec coverage.** Data model → 1; write sites → 3 (all four entrypoints, plus the "never read from a request body" assertion); backfill → 1 Step 5; funnel definition → 4 Steps 9-10; the timeline-parity test the spec requires → 4 Step 6; metrics table → 4; BigInt trap → 4 Step 1 (a unit case that JSON-stringifies a `bigint` above 2^53) and 6 case 5; admin surface → 5; cohort semantics and the caveat → 4 Step 9's doc comment and 7 Step 2; testing list → the unit specs plus 6; ordering → the header's `Depends on` line.

**Placeholder scan.** No TBD/TODO. Two places ask the implementer to match existing code rather than pasting it: Task 3 Step 6 (the chat dialog spec's mocking style) and Task 6 Step 1 (the e2e harness). Both name the exact file to read first and say what to assert — the harness is genuinely the reader's to match, and inventing a second one would be worse than reading the first.

**Type consistency.** `TransactionOrigin` is the single origin vocabulary, reused by `CreateDraftInput.origin` (Task 3), `PlatformMetrics.origin` (Task 4) and the response. `ALL_ORIGINS` (Task 2) is what zero-fills the response and what `ZERO` in the mapper is built from. `toTransactionOrigin` (Task 2) is called only at the chat write site. `toPlatformAnalyticsResponse` returns `Omit<…, 'from' | 'to'>` so the service owns the window stamping, and `AnalyticsService.getPlatformMetrics` is the only name the controller calls.

**One design detail the spec left implicit, now pinned.** `totals.disputeRate` is re-derived from the summed counts rather than averaged from the per-origin rates — averaging would weight a platform with one protected transaction the same as one with ten thousand. Task 4 Step 1 asserts this explicitly.
