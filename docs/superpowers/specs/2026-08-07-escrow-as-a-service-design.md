# Escrow-as-a-Service (EaaS) — design spec

Status: approved design, 2026-08-07. Grounded in the current tree.

## Problem

Today this backend is Meduman's **own** vertically-integrated escrow app: the only
auth is per-end-user Supabase JWTs, and everything assumes one marketplace. A
third-party developer who wants to use *our* escrow inside *their* ecommerce — instead
of building their own — has no way in: no machine auth, no tenant isolation, no
outbound events, no versioned public API.

EaaS exposes the existing escrow **engine** (state machine, money-safety rules 1–6,
idempotent payouts, disputes) as a multi-tenant API product a developer's server can
integrate against.

## Locked decisions

- **Custody:** Meduman holds the float. Buyer pays into our Paystack balance; on a
  valid release event we transfer to the merchant's seller. Cleanest dev API.
  **Business/legal track (parallel, NOT code): NG licensing to custody third-party
  funds — can invalidate launch, does not block building.**
- **Payout target:** `Merchant → Seller (1..n)`. A single-seller dev is the
  degenerate case of a marketplace dev.
- **Integration:** server-to-server. Dev's backend calls us with a secret API key.
  Buyers pay via a **hosted pay page we host** (we own Paystack collection). We never
  authenticate the dev's end-users.

## Architecture — thin `/v1` layer over the existing engine

Chosen over a separate deployed service (double ops + network hop) and
schema-per-tenant (migration/ops nightmare on Supabase). Row-level `merchantId`
scoping, one shared engine, one source of truth.

- New `/v1/*` controllers authenticate by API key and call the **same** domain
  services (`TransactionsService`, `PayoutsService`, state machine, `PaystackService`)
  — merchant-scoped. The state machine stays the sole owner of `TransactionStatus`
  (rule 1); protect still comes only from a signed webhook / server-verify (rule 2);
  payouts stay idempotent (rule 4). EaaS adds an **auth + isolation shell**, it does
  not touch money-safety internals.
- First-party Meduman app is unchanged: its rows have `merchantId = null`.

### Tenant / identity model

EaaS sellers and buyers do **not** log in via Supabase. Reuse the existing
`User` + `SellerProfile` tables by minting **merchant-scoped `User` rows with no
Supabase auth account** (the same "synthetic user" idea already used by
`ChatIdentityService`, minus the Supabase `admin.createUser` call — these users never
hit a JWT-authed route; the merchant's API key authenticates on their behalf).

- **Seller** = a `User` (roleFlags `[SELLER]`) + `SellerProfile`, both tagged
  `merchantId`. Payout destination stays `SellerProfile.providerRecipientCode`
  (reuse the existing bank-resolve → transfer-recipient onboarding verbatim).
- **Buyer** = the hosted pay page mints a merchant-scoped `User` on first payment
  (so `BUYER_CONFIRM` / OTP release step-up reuse unchanged); `Transaction.buyerId`
  points to it.

## Slices

Each slice is its own spec → plan → build cycle. **This spec details Slice 1**;
2 and 3 are outlined and get their own specs when reached.

### Slice 1 — Tenancy + API-key auth + `/v1` core (build first)

**New models**

- `Merchant` — the tenant.
  - `id`, `name`, `livemodeEnabled` (gate before real live keys work), `status`
    (`ACTIVE`/`SUSPENDED`), timestamps.
- `MerchantApiKey` — issued secret keys.
  - `id`, `merchantId` FK, `keyPrefix` (`sk_test`/`sk_live` + short public suffix,
    shown in dashboards/logs), `keyHash` (HMAC-SHA256 at rest — reuse the OTP
    hash-at-rest pattern; **plaintext returned exactly once at creation, never
    stored**), `livemode` (bool, derived from prefix), `lastUsedAt`, `revokedAt`.
  - `@@unique([keyHash])`. Lookup is by hash, constant-time.

**Schema deltas (additive migration)**

- Add nullable `merchantId String? @db.Uuid` + index to `User`, `SellerProfile`,
  `Transaction`, `Payout`. FK → `Merchant`. Null = first-party Meduman rows.
- `Payment` inherits scope through its `Transaction` (no column needed).

**Auth**

- `ApiKeyGuard` (new, in `common/`): reads `Authorization: Bearer sk_...`, hashes,
  looks up a non-revoked `MerchantApiKey`, attaches `merchant` + `livemode` to the
  request. Rejects a revoked/unknown key (401) and a `sk_live` key when
  `merchant.livemodeEnabled = false` (403).
- `@CurrentMerchant()` param decorator. `/v1/*` routes use `ApiKeyGuard` **instead
  of** `SupabaseJwtGuard` (opt the whole `/v1` controller set out of the global JWT
  guard; the API-key guard is its gate). First-party routes are untouched.

**Isolation invariant (money-safety-critical)**

Every `/v1` read and write intersects `merchantId = currentMerchant.id`. A merchant
can never read or mutate another merchant's (or a first-party) transaction, seller,
or payout. Enforced in the service methods the `/v1` controllers call — add
merchant-scoped variants where the existing method is user-scoped, never by trusting
a client-supplied id alone. Covered by an e2e cross-tenant-isolation spec.

**`/v1` endpoints (thin over existing services)**

- `POST /v1/sellers` — create a merchant-scoped seller (mints the `User` +
  `SellerProfile`). Body: display/business name, optional contact.
- `POST /v1/sellers/:id/recipient` — bank code + account number → resolve at
  Paystack → store transfer recipient (reuse existing recipient onboarding; the
  full account number is never persisted or audited).
- `GET /v1/sellers` / `GET /v1/sellers/:id` — merchant-scoped list/read.
- `POST /v1/transactions` — create a protected transaction (draft) for one of the
  merchant's sellers. Body: `sellerId`, `amount` (kobo), `currency`, `title`,
  `description?`, `releaseRule?`, `expectedDeliveryDate?`, buyer contact (email/name
  for the hosted page). Server owns all money fields; client-sent status/totals
  ignored (rule 1). Returns the transaction + the hosted `payLinkUrl`
  (`publicLinkId`).
- `GET /v1/transactions` — merchant-scoped cursor list (`?status=&cursor=&limit=`).
- `GET /v1/transactions/:id` — merchant-scoped read (lean projection; no internal
  idempotency secrets).
- `POST /v1/transactions/:id/publish` — DRAFT → LINK_ACTIVE via the state machine.
- Buyer pay + confirm + release use the **existing hosted pay page + webhook +
  payout path unchanged** — no new money endpoints. The pay page mints the
  merchant-scoped buyer `User` and drives the normal protect → confirm → release.

**Test mode**

- `sk_test` transactions carry `livemode = false` and never touch live Paystack —
  routed to Paystack test keys (or a stubbed collector in the sandbox). `sk_live`
  requires `merchant.livemodeEnabled`. Full separate sandbox infra is out of scope
  for Slice 1; the `livemode` tag + key-prefix gate is the minimum.

**Admin (first-party, JWT + `@Roles('ADMIN')`)**

- `POST /admin/merchants` (create tenant, returns a first key once),
  `POST /admin/merchants/:id/keys` (rotate/issue), `POST /admin/merchants/:id/keys/:keyId/revoke`,
  `PATCH /admin/merchants/:id` (enable livemode / suspend). Merchants are onboarded
  by Meduman admins in Slice 1 (self-serve dashboard is later).

**Tests (Slice 1)**

- Unit: API-key hash/verify + prefix→livemode; `ApiKeyGuard` accept/revoke/live-gate;
  merchant-scoped list/read excludes other tenants; transaction create ignores
  client money fields.
- e2e (real Postgres): cross-tenant isolation (merchant A cannot read/mutate
  merchant B's tx/seller/payout); full EaaS lifecycle (create seller + recipient →
  create tx → publish → hosted pay protects → confirm → release transfers to the
  merchant's seller) still honors rules 1–6; `sk_live` blocked when livemode
  disabled.

### Slice 2 — Outbound signed webhooks (next)

`WebhookEndpoint` per merchant (`url`, `signingSecret`). Emit `transaction.protected`,
`funds.released` / `payout.completed`, `dispute.opened`, `dispute.resolved`,
`transaction.cancelled`. HMAC-signed, delivered on a new BullMQ `webhook-out` queue
with retry/backoff; `OutboundEvent` row for dedupe + delivery log. Own spec.

### Slice 3 — Developer ergonomics (last)

`/v1` `Idempotency-Key` header contract (surface the existing internal idempotency),
published OpenAPI spec, docs, optional SDK. Own spec.

## Out of scope

- The NG fund-custody licensing decision (business/legal track, gating launch).
- Self-serve merchant signup dashboard (admin-onboarded in Slice 1).
- Publishable/client keys (S2S only, per the locked integration decision).
- Per-merchant billing/usage metering (later).

## Money-safety statement

EaaS changes **who** may call and **whose** rows are visible. It does not change how
money moves: the state machine remains the sole owner of state (rule 1), payment
protect still requires a signed webhook / server-verify (rule 2), release still needs
a valid release event (rule 3), payouts stay idempotent (rule 4), an open dispute
still freezes release (rule 5), every transition still writes an audit row (rule 6).
The new isolation invariant is itself money-safety-critical and is e2e-tested.
