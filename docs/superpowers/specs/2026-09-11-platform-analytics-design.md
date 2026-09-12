# Platform activity analytics — design

**Date:** 2026-09-11
**Status:** Approved, pending implementation plan

## Goal

Answer "which platform does what" with numbers that are facts rather than
inferences: how many people transact on Telegram vs WhatsApp vs the website, how
far they get, and how much money moves — per platform, over a date range.

Two things make this new work rather than a query over existing tables:

1. **Nothing records where a transaction came from.** `Transaction` carries
   `sellerId` / `buyerId` / `merchantId`, and `merchantId` distinguishes EaaS
   only. Chat vs web is currently only *inferable* from `User → ChatIdentity`,
   and that inference is wrong in the ordinary case: a user with a Telegram
   identity who sells on the website would be attributed to Telegram.
2. **Current `status` cannot tell you a transaction passed through a stage.** The
   lifecycle is not linear, so no ordering over status values yields "reached
   payment started."

## Non-goals

- Per-user analytics or cohorts.
- Real-time/streaming metrics. This is a read endpoint over the primary database.
- A visualisation layer — this repo is backend-only; the Next.js app renders the
  numbers.
- Fee/revenue reporting beyond exposing the existing `feeAmount`. No new money
  math.

## The non-linearity problem (why this drives the whole design)

`TransactionStatus` has twelve values and the transition table is **not a
ladder**. From `transition.spec.ts`:

| Transition | Consequence |
| --- | --- |
| `PAYMENT_PENDING → LINK_ACTIVE` (`PAYMENT_ABANDONED`) | A tx that started payment and abandoned sits at `LINK_ACTIVE` |
| `DISPUTED → PAYMENT_PROTECTED` (`WITHDRAW_DISPUTE`) | A disputed tx returns to a lower rank |
| `RELEASE_PROCESSING → DISPUTED` (`ADMIN_INTERVENTION`) | A tx in release falls back |
| `RELEASE_PROCESSING → RELEASE_PROCESSING` (`PAYOUT_RETRY`) | Self-loop |

So a "rank ≥ stage" trick is **provably wrong**: the abandoned-payment case would
be counted as never having started payment, understating the drop-off that the
funnel exists to expose.

`TimelineEvent` is the honest source. `TransactionsService.apply()` writes a
timeline row atomically with every status change, with `oldState` / `newState`, so
the full history is present. "Reached stage X" becomes `EXISTS (timeline row with
newState = X)`.

This is a load-bearing assumption, so it gets its own test: **every transition
permitted by the state machine must produce a timeline row.** If that parity ever
breaks, the funnel silently under-reports.

## Data model

```prisma
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

`X` is included for symmetry with `ChatPlatform` even though the X adapter is a
stub that cannot yet complete a transaction — adding the value now avoids a
migration later.

```prisma
model Transaction {
  /// Where this transaction was created. Server-owned, written once by the
  /// creating entrypoint, never client-supplied, never updated.
  origin TransactionOrigin @default(WEB)
  ...
  @@index([origin, createdAt])
}

model TimelineEvent {
  ...
  @@index([transactionId, newState])   // serves the funnel EXISTS probe
}
```

The `(transactionId, newState)` composite is what makes the per-stage `EXISTS`
an index probe rather than a scan of each transaction's events.

**No `origin` column on `Invoice`.** Invoices are created only through
`POST /invoices` today, so such a column would be `WEB` on every row. YAGNI: a
future chat invoice path adds it, and the backfill is trivial because the default
is already correct.

### Write sites

Origin is set by exactly three entrypoints, each passing a literal:

| Entrypoint | Origin |
| --- | --- |
| `POST /transactions` (web controller) | `WEB` |
| Chat `/sell` dialog | the identity's `ChatPlatform`, mapped 1:1 |
| `POST /v1/transactions` (EaaS) | `EAAS` |
| `InvoicesService.send` (mints the transaction) | `WEB` — with a comment that a future chat invoice path must pass its platform |

**`origin` is never read from a request body.** `CreateTransactionDto` and the
`/v1` create DTO do not gain an `origin` field. This is the same posture as
`TransactionStatus` (rule 1): a client cannot claim a platform it is not on.

### Backfill

The migration adds the column with `DEFAULT 'WEB'`, then a data backfill, applied
in the migration itself:

```sql
-- EaaS is unambiguous: the tenant column is the record.
UPDATE transactions SET origin = 'EAAS'
 WHERE merchant_id IS NOT NULL;

-- Otherwise attribute to chat ONLY when the seller holds exactly one chat
-- identity. Two identities means the origin is genuinely ambiguous, and a guess
-- would be worse than the WEB default it keeps.
UPDATE transactions t SET origin = (
  SELECT ci.platform FROM chat_identities ci WHERE ci.user_id = t.seller_id
)
 WHERE t.merchant_id IS NULL
   AND (SELECT COUNT(*) FROM chat_identities ci WHERE ci.user_id = t.seller_id) = 1;
```

Best-effort and **stated as such** — historical rows have no recorded origin, so
this reconstructs the most likely one. The spec's migration carries a comment
saying the pre-backfill period is an estimate and that no report should treat it
as authoritative. Every row created after this migration has a recorded origin and
needs no estimate.

## Funnel definition

**Cohort semantics:** the range filters `Transaction.createdAt`. A transaction
created in range counts as having reached a stage if it *ever* reached it,
including after `to`.

This is deliberate — it makes conversion a property of the cohort rather than of
how long the window happens to be — and it carries a caveat that must be printed
with the numbers: **recent cohorts look worse**, because their transactions have
had less time to convert. A frontend showing the last 7 days alongside the last
90 will see the 7-day row understate conversion. That is correct, not a bug.

| Column | Reached when a timeline row has |
| --- | --- |
| `created` | (the transaction itself) |
| `published` | `newState = LINK_ACTIVE` |
| `paymentStarted` | `newState = PAYMENT_PENDING` |
| `protected` | `newState = PAYMENT_PROTECTED` |
| `delivered` | `newState = CONFIRMATION_PENDING` |
| `released` | `newState = COMPLETED` |
| `disputed` | `newState = DISPUTED` |

Stages are cumulative up to `protected`: every path into `PAYMENT_PROTECTED`
passes through `PAYMENT_PENDING`, and every path into `PAYMENT_PENDING` passes
through `LINK_ACTIVE`. Those counts therefore cannot invert, and the funnel is
safe to render as a funnel down to that column.

**`delivered` and `released` are NOT a chain, and `delivered >= released` is not
an invariant.** After protection the lifecycle forks: a dispute resolved for the
seller goes `DISPUTED → RELEASE_PROCESSING → COMPLETED` and never passes through
`CONFIRMATION_PENDING`. So a cohort containing such a dispute has more released
transactions than delivered ones, and a chart that assumes the counts narrow all
the way down will misrender it. Both stages are still honest — each is exactly
"a timeline row with `newState = <that state>` exists" — which is the point: the
columns record what happened, and what happened does not always include a
delivery confirmation. `src/modules/analytics/funnel-shape.spec.ts` derives this
from the transition function so the correction cannot rot.

## Metrics

```
GET /admin/analytics/platforms?from=<iso>&to=<iso>
```

All seven origins are always returned, zero-filled, so the table has a stable
shape a dashboard can render without special-casing absent platforms. A `totals`
row aggregates every origin.

| Field | Definition |
| --- | --- |
| `origin` | the enum value |
| `sellers` | distinct `sellerId` on transactions of this origin created in range |
| `buyers` | distinct `buyerId` (non-null) on the same |
| `created` … `released` | the stage cohort counts |
| `disputed` | reached `DISPUTED` |
| `disputeRate` | `disputed / protected` as a **fraction** (`0.0210` = 2.10%), 4dp; `0` when `protected = 0` |
| `protectedVolumeKobo` | `SUM(amount)` over stage-`protected` transactions |
| `releasedVolumeKobo` | `SUM(amount)` over stage-`released` transactions |
| `feesKobo` | `SUM(feeAmount)` over stage-`protected` transactions |

**`sellers` / `buyers` replace a single "users" column deliberately.** Origin
records where a transaction was *created*, which is the seller's context, so a
single user count would conflate "sells on Telegram" with "bought on Telegram."
Two columns say what they mean; one column would need a paragraph of caveats.

Volume is `amount` (the protected amount). Gross collected by the buyer is
`amount + feeAmount` when `feeModel = BUYER_PAYS`; the fee is exposed separately
so the frontend can present either without this endpoint doing fee math.

`from` / `to` are required, ISO-8601, `to` exclusive, and the range is capped
(`ANALYTICS_MAX_RANGE_DAYS`, default 366) to bound the scan.

## The BigInt trap

Postgres `SUM(int)` returns `bigint`. Prisma `$queryRaw` therefore hands back a
JavaScript **`BigInt`**, and `JSON.stringify` **throws**
(`TypeError: Do not know how to serialize a BigInt`) — so a naive endpoint that
returns the raw rows 500s the moment any volume row is non-empty, which is to say
in production but never in a unit test with empty data.

`SUM` is also `NULL` over zero rows, so the query coalesces to `0` and the mapper
converts every aggregate to a **string** before it leaves the service. Money
crossing the wire as a decimal string is the same convention the rest of the API
uses for kobo values, and strings cannot lose precision the way a JSON number
above 2⁵³ would.

`COUNT(*)` returns `bigint` too and gets the same treatment.

## Admin surface

```
GET /admin/analytics/platforms?from=&to=
```

`@Roles('ADMIN')`, throttled. Read-only, moves no money, writes no state — so no
audit row (rule 6 covers state transitions and admin *actions*, and a read is
neither). Implementation: a single `$queryRaw` grouping by `origin`, one `EXISTS`
subquery per stage, executed through the pooled runtime client.

The query is deliberately one round trip. Twelve stages × seven origins as
separate queries would be eighty-four round trips to produce one table.

## Testing

**Unit** — the origin mapper (`ChatPlatform → TransactionOrigin` is total and 1:1);
the BigInt→string serialization, including a non-empty volume row (the case that
breaks a naive implementation); `disputeRate` when `protected = 0`; range
validation and the cap; the DTO rejects an `origin` field if one is ever added to
a create payload.

**E2E** (`test/platform-analytics.e2e-spec.ts`, real Postgres) — the ones that
would catch a wrong design:

1. **Origin write-site isolation.** Create a transaction through each entrypoint
   (web controller, chat dialog, `/v1`), then query analytics → each lands in its
   own origin row and no other. Assert a client-supplied `origin` in a create body
   is ignored.
2. **The abandoned-payment case.** Drive a transaction `LINK_ACTIVE →
   PAYMENT_PENDING → PAYMENT_ABANDONED → LINK_ACTIVE`. Assert it is counted in
   `paymentStarted` and **not** in `protected`. This is the case a status-rank
   implementation gets wrong, so it is the test that proves the timeline approach.
3. **Stage cumulativity, not monotonicity.** Over a seeded population, assert
   `created ≥ published ≥ paymentStarted ≥ protected` — the part that is an
   invariant. **Do not assert `delivered ≥ released`**: a dispute resolved for the
   seller releases without ever being delivered (see the funnel table above), so
   assert the counterexample explicitly instead — a transaction driven
   `PAYMENT_PROTECTED → DISPUTED → RESOLVE_DISPUTE_FOR_SELLER → PAYOUT_SUCCEEDED`
   counts in `released` and **not** in `delivered`.
4. **Withdraw-dispute regression.** Drive `PAYMENT_PROTECTED → DISPUTED →
   WITHDRAW_DISPUTE` and assert the transaction still counts as `protected` and
   still counts in `disputed`.
5. **Money.** A protected transaction contributes its `amount` to
   `protectedVolumeKobo` exactly once; a released one contributes to
   `releasedVolumeKobo`; the response serializes without throwing and the value is
   a decimal string.
6. **Link interaction.** Link a chat-born seller to a web account, then re-query →
   the historical transactions **keep their original origin**. Origin is a record
   of where a transaction happened, and merging identities must not rewrite
   history.

## Ordering

This ships **after** account linking. Linking changes which `User` owns which
transaction; analytics reads that ownership. Landing analytics first would mean
calibrating against a data model about to move.

## Deferred

- Per-platform funnels broken down by seller vs buyer.
- Time-series (daily/weekly buckets) — the same query with a `date_trunc` group.
- An `origin` column on `Payout` — payouts inherit their transaction's origin, so
  a column would be redundant today.
