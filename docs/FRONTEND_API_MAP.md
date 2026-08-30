# Frontend ⇄ API Map & Missing-Endpoint Drafts

Frontend = separate Next.js app on Vercel. This backend is API-only. Every
authed call sends the Supabase JWT as `Authorization: Bearer <token>`. Login /
signup / session refresh happen **in the frontend against Supabase Auth** — this
backend has no auth endpoints.

Money is stored/returned as **integer kobo**. Frontend formats with
`₦(amount / 100).toLocaleString('en-NG')`. Never send/parse floats.

**Legend:** ✅ endpoint exists · 🟥 endpoint missing (drafted in Part B) ·
🔒 auth required · 🌐 public.

> **Build status (2026-08-01):** every 🟥 endpoint in Part B is now implemented,
> wired, and green (lint + build + 193 unit tests). The 🟥 markers below are kept
> for provenance — treat them as ✅. Money-sensitive choices from Part B were
> applied as drafted: public pay-page allow-list, `LINK_ACTIVE`/`PAYMENT_PENDING`
> visibility gate, role-scoped cursor lists, participant/admin read guards,
> idempotent+audited subaccount creation. New env: `PAYSTACK_SUBACCOUNT_PERCENTAGE_CHARGE`.
> New migration: `20260801000000_notification_read_at` (additive, unapplied).
> Still human-only before launch: real SMS/WhatsApp OTP transport, AV scan gating
> evidence downloads, and booting once against live Supabase + Redis + Paystack.

---

# Part A — Pages → sections → API

## 0. Global shell (applies to every authed page)

| Section | Purpose | API |
| --- | --- | --- |
| Session bootstrap | On mount, exchange Supabase session for local mirror | ✅ 🔒 `GET /users/me` |
| Role gate | Route guards by `roleFlags` / `appRole` from JWT | (client-side, JWT claims) |
| Notification bell | Unread count + list | 🟥 `GET /notifications`, `POST /notifications/:id/read` (Part B §9 — optional) |
| Error/health | Maintenance banner | ✅ 🌐 `GET /health/ready` (ops only, not user UI) |

Status → UI is driven everywhere by `TransactionStatus` (12 states):
`DRAFT, LINK_ACTIVE, PAYMENT_PENDING, PAYMENT_PROTECTED, DELIVERY_IN_PROGRESS,
CONFIRMATION_PENDING, DISPUTED, RELEASE_PROCESSING, COMPLETED, REFUNDED,
CANCELLED, EXPIRED`. Build one `<StatusBadge status>` + one `<StatusStepper>`
component and reuse.

---

## 1. Marketing / public (no auth)

### 1.1 Landing `/`
| Section | Contents | API |
| --- | --- | --- |
| Hero | Value prop, CTA (Join waitlist / Start selling) | — |
| How it works | 4 steps: pay → held → deliver → confirm → release | — (static) |
| Trust / safety | "Funds held, released only on confirm; disputes freeze release" | — (static) |
| Social-commerce angle | Instagram/WhatsApp/TikTok selling story | — (static) |
| Waitlist form | fullName, email, phone, userType, channel, country, city, useCase, avgTransactionValue (kobo), consent | 🟥 🌐 `POST /waitlist` |
| Footer | Legal, contact | — |

### 1.2 Seller trust badge `/s/:badgeSlug`
Public storefront proof a seller can share.
| Section | Contents | API |
| --- | --- | --- |
| Badge header | Business name, verification status, trust level | 🟥 🌐 `GET /public/sellers/:badgeSlug` (Part B §8) |
| Stats | # completed protected tx, member since | 🟥 (same endpoint, aggregated) |

### 1.3 Auth `/login`, `/signup`, `/auth/callback`
All Supabase-client-side. Backend: none. After session established → `GET /users/me`.
Static content only (legal/consent copy). Legal `/terms`, `/privacy` — static.

---

## 2. Buyer flow

### 2.1 Pay link `/pay/:publicLinkId` 🌐 (buyer arrives from a shared link, may be logged out)
| Section | Contents | API |
| --- | --- | --- |
| Transaction summary | title, description, amount, currency, feeModel, feeAmount, seller display name + trust | 🟥 🌐 `GET /public/transactions/:publicLinkId` (Part B §2) |
| Protection explainer | "Your money is held until you confirm delivery" | — (static) |
| Fee breakdown | Who pays fee (`feeModel`), total buyer pays | (derive from summary) |
| Pay button | Requires buyer to be authed (Supabase) → then init | ✅ 🔒 `POST /payments/initialize` → `{ authorizationUrl }` then redirect to Paystack |
| Unavailable state | If status ∉ {LINK_ACTIVE, PAYMENT_PENDING} → show "link closed/expired/paid" | (from summary `status`) |

> Money note: the public summary is **read-only** and exposes no buyer identity,
> no internal ids, no payment rows. Payment can only be created by an authed
> buyer; status is server-owned (rules 1 & 2).

### 2.2 Payment return `/pay/return?reference=…` 🔒
Paystack redirects here after checkout.
| Section | Contents | API |
| --- | --- | --- |
| Verifying spinner | Server-side verify (never trust the callback) | ✅ 🔒 `POST /payments/:reference/verify` → `{ status }` |
| Result | Protected ✓ / pending / failed → link to tx detail | (poll verify or show status) |

### 2.3 Buyer transaction detail `/txn/:id` 🔒
| Section | Contents | API |
| --- | --- | --- |
| Header | title, amount, `<StatusBadge>` | ✅ `GET /transactions/:id` |
| Status stepper | 12-state progress | (from tx.status) |
| Timeline feed | Human events (payment.protected, delivery.marked, …) | 🟥 `GET /transactions/:id/timeline` (Part B §4) |
| Delivery panel | What seller marked delivered / expected date | (from tx + timeline) |
| Confirm actions | In-app confirm **or** OTP step-up | ✅ `POST /transactions/:id/confirm` · ✅ `POST /transactions/:id/otp` then ✅ `POST /transactions/:id/confirm-otp` |
| Dispute CTA | Raise dispute (freezes release) | ✅ `POST /transactions/:transactionId/disputes` |
| Evidence | Attach proof (chat screenshots etc.) | 🟥 `POST /transactions/:id/evidence` + `GET /evidence/:id/download-url` (Part B §5) |
| Receipt | On COMPLETED/REFUNDED: amount, refs | (from tx) |

Confirm sub-states: show OTP entry when the buyer requested a code (out-of-band
delivery — code never returned by the API); show plain confirm when `releaseRule`
is in-app. Both call `apply(BUYER_CONFIRM)` server-side then enqueue release.

### 2.4 Buyer dashboard `/dashboard` 🔒
| Section | Contents | API |
| --- | --- | --- |
| Tabs / filters | By status group: active, awaiting-confirm, disputed, closed | 🟥 `GET /transactions?role=buyer&status=…&cursor=…` (Part B §3) |
| Tx cards | title, counterparty, amount, status | (list response) |
| Empty state | "No protected purchases yet" | — |

---

## 3. Seller flow

### 3.1 Seller dashboard `/seller` 🔒
| Section | Contents | API |
| --- | --- | --- |
| KPI row | held total, released total, open disputes, awaiting-confirm | 🟥 `GET /transactions?role=seller&…` (aggregate client-side) + 🟥 `GET /payouts?role=seller` (Part B §7, optional) |
| Verification banner | Prompt to finish subaccount/bank setup if not settlement-ready | 🟥 `GET /users/me/seller` (Part B §8) |
| Tx list | Filter by status | 🟥 `GET /transactions?role=seller&status=…` |
| Create CTA | New transaction | → `/seller/new` |

### 3.2 Create transaction `/seller/new` 🔒
| Section | Contents | API |
| --- | --- | --- |
| Details form | title, description, amount (kobo), currency | ✅ `POST /transactions` |
| Terms | releaseRule (BUYER_CONFIRMATION / AUTO_AFTER_WINDOW), feeModel, feeAmount, expectedDeliveryDate | ✅ (same body) |
| Items (optional) | line items | 🟥 not exposed yet — `TransactionItem` has no create endpoint (see §10 gaps) |
| Result | DRAFT created → share link `publicLinkId` | (response) |

### 3.3 Seller transaction detail `/seller/txn/:id` 🔒
| Section | Contents | API |
| --- | --- | --- |
| Header + status | | ✅ `GET /transactions/:id` |
| Share link | `https://app/pay/:publicLinkId` + copy/QR | (from tx) |
| Lifecycle buttons | Publish → Start delivery → Mark delivered | ✅ `POST /transactions/:id/publish` · `…/start-delivery` · `…/mark-delivered` |
| Cancel | Cancel a DRAFT / LINK_ACTIVE before protection | 🟥 `POST /transactions/:id/cancel` (Part B §6) |
| Timeline | | 🟥 `GET /transactions/:id/timeline` (Part B §4) |
| Dispute panel | View dispute + upload evidence | 🟥 `GET /transactions/:id/disputes` + evidence (Part B §5) |
| Payout status | Payout state once released | 🟥 `GET /transactions/:id/payouts` (Part B §7, optional) |

### 3.4 Seller settings / onboarding `/seller/settings` 🔒
| Section | Contents | API |
| --- | --- | --- |
| Business profile | businessName, category, channelLinks | 🟥 `PATCH /users/me/seller` (Part B §8) |
| Settlement | Bank → Paystack subaccount (manual payout) | 🟥 `POST /users/me/seller/subaccount` (Part B §8 — depends on Paystack recipient seam, readiness §7) |
| Verification | KYC status | 🟥 `GET /users/me/seller` |
| Public badge | badgeSlug link | (from seller profile) |

---

## 4. Disputes & evidence (shared buyer/seller)

### 4.1 Dispute detail `/txn/:id/dispute` 🔒
| Section | Contents | API |
| --- | --- | --- |
| Raise form | reason (enum), description, desiredOutcome | ✅ `POST /transactions/:transactionId/disputes` |
| Dispute status | OPEN / UNDER_REVIEW / RESOLVED_* + resolution note | 🟥 `GET /transactions/:id/disputes` (Part B §5) |
| Evidence list | Uploaded proofs (signed download URLs) | 🟥 `POST /transactions/:id/evidence`, `GET /evidence/:id/download-url` (Part B §5) |
| Outcome banner | On resolve: release-to-seller / refund-to-buyer | (from tx.status + dispute) |

---

## 5. Admin console `/admin/*` 🔒 (`@Roles('ADMIN')`)

| Page | Sections | API |
| --- | --- | --- |
| `/admin` overview | Queues: open disputes, stuck RELEASE_PROCESSING, awaiting-confirm counts | 🟥 `GET /admin/transactions?status=…` (Part B §7) |
| `/admin/transactions` | Full tx table + search + status filter | 🟥 `GET /admin/transactions` |
| `/admin/transactions/:id` | Tx + timeline + audit log + evidence | ✅ `GET /transactions/:id` (admin allowed) + 🟥 `GET /transactions/:id/audit` (Part B §7) |
| `/admin/disputes` | Dispute queue | 🟥 `GET /admin/disputes` |
| `/admin/disputes/:id` | Resolve for seller (release) / buyer (refund) | ✅ `POST /disputes/:id/resolve` |

---

# Part B — Missing-endpoint drafts

Drafts follow the existing module patterns (global `SupabaseJwtGuard` +
`RolesGuard`, `@Public()` to opt out, `@CurrentUser()` claims, `ParseUUIDPipe`,
DTO validation). **Not yet wired/built** — promote after you approve the design
choices flagged in each ⚠️. All reads are ownership-scoped; none mutate money
state except through the existing state machine.

Ordering: 1 waitlist · 2 public tx · 3 list tx · 4 timeline · 5 evidence ·
6 cancel · 7 admin/payout/audit reads · 8 seller subaccount · 9 notifications.

---

## §1 — `POST /waitlist` 🌐 (landing signup)

`src/modules/waitlist/dto/create-waitlist.dto.ts`
```ts
import {
  IsBoolean, IsEmail, IsInt, IsOptional, IsString, MaxLength, Min,
} from 'class-validator';

export class CreateWaitlistDto {
  @IsString() @MaxLength(120) fullName!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(40) userType?: string;
  @IsOptional() @IsString() @MaxLength(80) channel?: string;
  @IsOptional() @IsString() @MaxLength(80) country?: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsString() @MaxLength(500) useCase?: string;
  /** Self-reported avg tx value in KOBO (integer). */
  @IsOptional() @IsInt() @Min(0) avgTransactionValue?: number;
  @IsOptional() @IsBoolean() consent?: boolean;
}
```

`src/modules/waitlist/waitlist.service.ts`
```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import type { CreateWaitlistDto } from './dto/create-waitlist.dto';

@Injectable()
export class WaitlistService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent on email — a re-submit updates the existing lead, never 500s. */
  async join(dto: CreateWaitlistDto): Promise<{ ok: true }> {
    await this.prisma.waitlistEntry.upsert({
      where: { email: dto.email },
      create: { ...dto },
      update: { ...dto },
    });
    // Return nothing identifying — this is an unauthenticated endpoint.
    return { ok: true };
  }
}
```

`src/modules/waitlist/waitlist.controller.ts`
```ts
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { WaitlistService } from './waitlist.service';
import { CreateWaitlistDto } from './dto/create-waitlist.dto';

@Controller('waitlist')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  // Public + unauthenticated → throttle hard against spam/enumeration.
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  @HttpCode(202)
  join(@Body() dto: CreateWaitlistDto) {
    return this.waitlist.join(dto);
  }
}
```
Wire `WaitlistModule` into `app.module.ts`. ⚠️ Decision: return `202 {ok}` only —
don't leak whether the email already existed (enumeration).

---

## §2 — `GET /public/transactions/:publicLinkId` 🌐 (pay page)

⚠️ **Money-safety decision (needs your sign-off):** this is the only unauthenticated
read of a transaction. It must expose a **lean, allow-listed** projection — no
`buyerId`, no internal `id`, no payments/payouts/timeline — and only for statuses
where showing the link is meaningful. Everything else → 404 (don't confirm a link
exists in a closed/disputed state).

Add to `TransactionsService`:
```ts
// Statuses for which the public pay page may render the link.
const PUBLIC_VISIBLE_STATUSES = ['LINK_ACTIVE', 'PAYMENT_PENDING'] as const;

export interface PublicTransactionView {
  publicLinkId: string;
  title: string;
  description: string | null;
  amount: number;        // kobo
  currency: string;
  feeModel: FeeModel;
  feeAmount: number;     // kobo
  status: TransactionStatus;
  seller: { displayName: string | null; trustLevel: TrustLevel | null; verified: boolean };
}

async getPublicByLinkId(publicLinkId: string): Promise<PublicTransactionView> {
  const tx = await this.prisma.transaction.findUnique({
    where: { publicLinkId },
    // ⚠️ Verify the reverse relation name on User for SellerProfile in schema
    // (add `sellerProfile SellerProfile?` to model User if not present).
    include: { seller: { include: { profile: true, sellerProfile: true } } },
  });
  if (
    !tx ||
    !PUBLIC_VISIBLE_STATUSES.includes(tx.status as (typeof PUBLIC_VISIBLE_STATUSES)[number])
  ) {
    throw new NotFoundException('Payment link not found or no longer active');
  }
  return {
    publicLinkId: tx.publicLinkId,
    title: tx.title,
    description: tx.description,
    amount: tx.amount,
    currency: tx.currency,
    feeModel: tx.feeModel,
    feeAmount: tx.feeAmount,
    status: tx.status,
    seller: {
      displayName: tx.seller.sellerProfile?.businessName ?? tx.seller.fullName ?? null,
      trustLevel: tx.seller.sellerProfile?.trustLevel ?? null,
      verified: tx.seller.sellerProfile?.verificationStatus === 'VERIFIED',
    },
  };
}
```

`src/modules/transactions/public-transactions.controller.ts`
```ts
import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { TransactionsService } from './transactions.service';

@Controller('public/transactions')
export class PublicTransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':publicLinkId')
  get(@Param('publicLinkId') publicLinkId: string) {
    return this.transactions.getPublicByLinkId(publicLinkId);
  }
}
```
Register the controller in `TransactionsModule`. ⚠️ `publicLinkId` is a 32-char
random hex (not a UUID) — do **not** use `ParseUUIDPipe` here.

---

## §3 — `GET /transactions` 🔒 (buyer/seller dashboards, role-scoped list)

⚠️ Decision: `role` query decides the scope; the server always intersects with the
caller's id, so a buyer can never list another user's transactions. Cursor
pagination on `createdAt,id`.

DTO `src/modules/transactions/dto/list-transactions.dto.ts`
```ts
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { TransactionStatus } from '@prisma/client';

export class ListTransactionsDto {
  @IsIn(['buyer', 'seller']) role!: 'buyer' | 'seller';
  @IsOptional() @IsEnum(TransactionStatus) status?: TransactionStatus;
  @IsOptional() @IsString() cursor?: string;            // last id from prev page
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}
```

Service method:
```ts
async listForUser(
  userId: string,
  q: ListTransactionsDto,
): Promise<{ items: Transaction[]; nextCursor: string | null }> {
  const take = q.limit ?? 20;
  const where = {
    ...(q.role === 'buyer' ? { buyerId: userId } : { sellerId: userId }),
    ...(q.status ? { status: q.status } : {}),
  };
  const rows = await this.prisma.transaction.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,                                   // +1 to detect next page
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take);
  const nextCursor = rows.length > take ? items[items.length - 1].id : null;
  return { items, nextCursor };
}
```

Add to `TransactionsController` (place the static route **before** `@Get(':id')`):
```ts
@Get()
list(
  @CurrentUser() claims: SupabaseJwtClaims,
  @Query() q: ListTransactionsDto,
) {
  return this.transactions.listForUser(claims.sub, q);
}
```
(Import `Query` from `@nestjs/common`, `ListTransactionsDto` from `./dto/...`.)

---

## §4 — `GET /transactions/:id/timeline` 🔒 (detail-page feed)

Participant-or-admin, mirrors the ownership check already in `get()`.
```ts
// TransactionsService
async getTimeline(id: string): Promise<TimelineEvent[]> {
  await this.getById(id); // 404 if missing
  return this.prisma.timelineEvent.findMany({
    where: { transactionId: id },
    orderBy: { createdAt: 'asc' },
  });
}
```
```ts
// TransactionsController
@Get(':id/timeline')
async timeline(
  @CurrentUser() claims: SupabaseJwtClaims,
  @Param('id', new ParseUUIDPipe()) id: string,
) {
  const tx = await this.transactions.getById(id);
  const participant = tx.sellerId === claims.sub || tx.buyerId === claims.sub;
  if (!participant && claims.appRole !== 'ADMIN') {
    throw new ForbiddenException('Not a participant of this transaction');
  }
  return this.transactions.getTimeline(id);
}
```
> Extract the participant check into a private `assertParticipant(tx, claims)`
> helper — it now repeats across `get`, `timeline`, `disputes`, `evidence`.

---

## §5 — Evidence upload/download 🔒 (proof files)

`StorageService` already has `createUploadUrl` / `createDownloadUrl` /
`buildEvidencePath`. Missing = an HTTP seam + the `Evidence` row.

⚠️ Decisions: (a) client sends `filename`, `mimeType`, `sizeBytes` (allow-list
mime + cap size); (b) the server picks the path (traversal-safe already);
(c) the returned signed **upload** URL is one-time; (d) download URLs are minted
per-request, never stored. Files are private forever (no public URLs).

DTO:
```ts
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;

export class CreateEvidenceDto {
  @IsString() @MaxLength(200) filename!: string;
  @IsIn(ALLOWED_MIME) mimeType!: (typeof ALLOWED_MIME)[number];
  @IsInt() @Min(1) @Max(10 * 1024 * 1024) sizeBytes!: number; // 10 MB cap
  @IsOptional() @IsUUID() disputeId?: string;
}
```

Controller (new `EvidenceController`, injects `StorageService`, `PrismaService`,
`TransactionsService`):
```ts
@Post('transactions/:id/evidence')
async create(
  @CurrentUser() claims: SupabaseJwtClaims,
  @Param('id', new ParseUUIDPipe()) id: string,
  @Body() dto: CreateEvidenceDto,
) {
  const tx = await this.transactions.getById(id);
  const participant = tx.sellerId === claims.sub || tx.buyerId === claims.sub;
  if (!participant && claims.appRole !== 'ADMIN') {
    throw new ForbiddenException('Not a participant of this transaction');
  }
  const path = this.storage.buildEvidencePath(id, dto.filename);
  const upload = await this.storage.createUploadUrl(path);   // one-time PUT target
  const evidence = await this.prisma.evidence.create({
    data: {
      transactionId: id,
      uploadedBy: claims.sub,
      storagePath: path,
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
      ...(dto.disputeId ? { disputeId: dto.disputeId } : {}),
    },
  });
  return { evidenceId: evidence.id, upload }; // client PUTs the file to upload.signedUrl
}

@Get('evidence/:evidenceId/download-url')
async download(
  @CurrentUser() claims: SupabaseJwtClaims,
  @Param('evidenceId', new ParseUUIDPipe()) evidenceId: string,
) {
  const ev = await this.prisma.evidence.findUnique({
    where: { id: evidenceId },
    include: { transaction: true },
  });
  if (!ev) throw new NotFoundException('Evidence not found');
  const tx = ev.transaction;
  const participant = tx.sellerId === claims.sub || tx.buyerId === claims.sub;
  if (!participant && claims.appRole !== 'ADMIN') {
    throw new ForbiddenException('Not permitted');
  }
  return this.storage.createDownloadUrl(ev.storagePath); // short-lived signed GET
}
```
> `scanStatus` starts `PENDING`; a later AV-scan job flips it. Frontend should
> gate download on `scanStatus === 'CLEAN'` once scanning is wired.

---

## §6 — `POST /transactions/:id/cancel` 🔒 (seller aborts a draft/link)

The state machine already has a `CANCEL` event. Thin controller method, seller-only,
reusing the existing `sellerAction` helper:
```ts
@Post(':id/cancel')
cancel(
  @CurrentUser() claims: SupabaseJwtClaims,
  @Param('id', new ParseUUIDPipe()) id: string,
) {
  return this.sellerAction(claims, id, { type: 'CANCEL' });
}
```
> No money moved — the machine rejects `CANCEL` from any protected/released state,
> so this can only kill a `DRAFT`/`LINK_ACTIVE` (verify the exact legal edges in
> `state-machine`). Writes timeline + audit like every transition (rule 6).

---

## §7 — Admin / payout / audit reads 🔒

### `GET /admin/transactions` (`@Roles('ADMIN')`)
Same cursor pattern as §3 but **no** user-id intersection; adds optional
`sellerId` / `buyerId` / `status` filters. Keep in a new `AdminController` so the
`@Roles('ADMIN')` guard is scoped to the whole controller.

### `GET /admin/disputes` (`@Roles('ADMIN')`)
```ts
listDisputes(q) {
  return this.prisma.dispute.findMany({
    where: { ...(q.status ? { status: q.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: (q.limit ?? 20),
    include: { transaction: { select: { id: true, title: true, amount: true, status: true } } },
  });
}
```

### `GET /transactions/:id/audit` (`@Roles('ADMIN')`)
Read-only view of the append-only `AuditLog` for one transaction:
```ts
this.prisma.auditLog.findMany({
  where: { targetType: 'Transaction', targetId: id },
  orderBy: { createdAt: 'asc' },
});
```

### `GET /transactions/:id/payouts` / `GET /transactions/:id/disputes` 🔒
Participant-or-admin (reuse `assertParticipant`). Straight `findMany` by
`transactionId`. Payout view should **omit** `idempotencyKey` /
`providerTransferCode` from the client projection — return
`{ id, amount, currency, status, attemptCount, createdAt }` only.

---

## §8 — Seller profile + Paystack subaccount 🔒

⚠️ **Blocked on a real Paystack seam** (readiness §7). `PaystackService` has a
`subaccount` call but seller onboarding (bank → `subaccount_code`) isn't wired,
and there is **no `SellerProfileService` yet**. Draft shape:

- `GET /users/me/seller` → the caller's `SellerProfile` (create-on-read if absent),
  projecting `businessName, category, verificationStatus, trustLevel, badgeSlug,
  settlementBankVerified` and a boolean `settlementReady =
  !!paystackSubaccountCode && settlementBankVerified`. Never return the raw
  `paystackSubaccountCode` to the client.
- `PATCH /users/me/seller` → update `businessName`, `category` (and profile
  `channelLinks`). Server-owned fields (`verificationStatus`, `trustLevel`,
  `badgeSlug`) are **not** client-writable.
- `POST /users/me/seller/subaccount` → body: bank code + account number. Server
  calls Paystack to create the subaccount, stores `paystackSubaccountCode`, sets
  `settlementBankVerified` from Paystack's response. **Money-sensitive** — must be
  idempotent per user and audit-logged (rule 6). Do this one only when the
  Paystack recipient onboarding call is finalized.

### `GET /public/sellers/:badgeSlug` 🌐 (trust badge)
Lean projection: `businessName, verificationStatus, trustLevel`, plus an
aggregate count of `COMPLETED` transactions and `createdAt`. No ids, no settlement
fields.

---

## §9 — Notifications 🔒 (optional, bell UI)

- `GET /notifications?status=…` → the caller's `Notification` rows
  (`where: { userId: claims.sub }`), newest first, projecting
  `id, channel, templateKey, payload, status, createdAt`.
- `POST /notifications/:id/read` → set `status`/read flag (ownership-checked).

Low priority — only needed if the frontend wants an in-app inbox. OTP delivery is
already handled out-of-band by the worker, independent of this.

---

## §10 — Invoicing (Phase 1) 🔒 / 🌐 (itemized formal invoices → escrow)

Built and wired. An invoice is a richer front-end onto **one** protected
Transaction; paying it funds escrow through the normal path. Server owns every
money field and the PAID state — the client sends line inputs only.

Seller routes (🔒, ownership-scoped):

- `POST /invoices` — create DRAFT. Body: `buyerName?`, `buyerEmail?`,
  `buyerPhone?`, `dueDate?` (ISO), `taxRatePctBp?` (basis points, 750 = 7.5%),
  `notes?`, `terms?`, `lineItems[]` (`title`, `quantity`, `unitPrice` in **kobo**,
  `description?`). Totals are **server-computed** — any `subtotal`/`taxAmount`/
  `total` in the body is ignored.
- `PATCH /invoices/:id` — edit a DRAFT (replaces line items, recomputes totals).
- `POST /invoices/:id/send` — mint the protected tx + pay link, allocate the
  seller-sequential number `INV-0001`, DRAFT→SENT, deliver. Idempotent.
- `POST /invoices/:id/void` — pre-PAID only; cancels the linked tx.
- `POST /invoices/:id/remind` — re-deliver (rate-limited). `204`.
- `GET /invoices` — seller cursor list (`?status=&cursor=&limit=`).
- `GET /invoices/:id` — owner-guarded full read (includes line items).

Public route (🌐):

- `GET /public/invoices/:publicViewId` — `@Public()`, unguessable id. Allow-listed
  projection: number, status, dates, currency, line items, subtotal/tax/total,
  buyer name, seller display name + badge, and the `payLinkId` (once sent).
  Marks the invoice VIEWED on first open. **Never** returns `transactionId`,
  `sellerId`, buyer auth id, or payout/idempotency fields. 404 for a DRAFT.

Status lifecycle: `DRAFT → SENT → VIEWED → PAID → (OVERDUE) → VOID`. **PAID is
derived** from the payment protect path only (never a client call); OVERDUE is a
soft cron flag that never blocks payment. **Frontend renders the printable
document / PDF** — this backend serves the structured JSON + owns the number.

Phase 2 (direct/non-escrow toggle) and Phase 3 (recurring/batch) are separate,
not yet built.

# Part C — Backend gaps summary (build order)

| # | Endpoint | Unblocks | Risk | Depends on |
| --- | --- | --- | --- | --- |
| 1 | `POST /waitlist` | Landing | low | — |
| 2 | `GET /public/transactions/:publicLinkId` | Buyer pay page (**critical path**) | med (exposure) | seller reverse-relation in schema |
| 3 | `GET /transactions` (list) | All dashboards | low | — |
| 4 | `GET /transactions/:id/timeline` | Detail feeds | low | — |
| 5 | Evidence upload/download | Proof + disputes | med | Supabase Storage bucket live |
| 6 | `POST /transactions/:id/cancel` | Seller detail | low | verify CANCEL edges |
| 7 | Admin/payout/audit reads | Admin console | low | — |
| 8 | Seller subaccount/profile | Payouts / settlement | **high** | Paystack recipient seam (readiness §7), new `SellerProfileService` |
| 9 | Notifications inbox | Optional bell | low | — |

Also not yet exposed (decide if the frontend needs them):
`TransactionItem` create/edit (line items on `/seller/new`), buyer-side
"withdraw dispute" (`WITHDRAW_DISPUTE` event exists in the machine), and
resend-OTP UX (already covered by re-calling `POST /:id/otp`).

## Open decisions for you
1. **§2 exposure** — confirm the public pay-page field allow-list and the
   visible-status set (`LINK_ACTIVE`, `PAYMENT_PENDING`).
2. **Pagination** — cursor (drafted) vs page/offset. Cursor is safer for money
   tables that grow.
3. **§8 ordering** — do we wire the real Paystack subaccount call now, or ship a
   profile-only stub and gate settlement behind a feature flag?
4. Should these become **real wired files + tests + `npm run build`** now, or stay
   as reviewed drafts in this doc?
