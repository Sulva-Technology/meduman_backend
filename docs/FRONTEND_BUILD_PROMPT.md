# Meduman Frontend — Build Prompt

**Audience:** an AI coding agent (Claude Code) building the app, or a design agent
(Claude Design / v0-style) producing the full UI mockup set.
**Status of the backend:** complete API spine, all endpoints below exist and are
tested. See [`FRONTEND_API_MAP.md`](FRONTEND_API_MAP.md) for provenance and
[`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) for launch blockers.
**Date:** 2026-08-01.

---

## 0. How to use this document

Two entry points — pick one, both use the same specs:

**A. Mockup-only run (Claude Design, Figma-style agent, or an HTML artifact):**
read §1–§7 and §13. Deliver every screen in §13 at mobile (375px) and desktop
(1280px), in light and dark, including the loading / empty / error / disabled
variants named per page. No API calls — use the fixture data in §12.

**B. Full app build (Claude Code):** read the whole document. Build in the
milestone order in §14. Every page's data contract is in §6, and the exact HTTP
contract is in §11. Do not invent endpoints; if a page needs data that §11 does
not expose, stop and report it as a backend gap (§15 lists the known ones).

> One rule that overrides convenience everywhere: **this frontend never decides
> money or transaction state.** It renders server state and calls server actions.
> If a design idea requires the client to compute or assert a status, an amount,
> or a release — the design is wrong, not the API.

---

## 1. Product context

Meduman is a **transaction-protection (escrow) platform for social commerce in
Nigeria** — people who sell over Instagram, WhatsApp, TikTok, and Twitter/X, where
neither side trusts the other to go first.

The flow, in the user's words:

1. Buyer pays into a **protected** state — money is collected but **not** with the seller.
2. Seller delivers.
3. Buyer confirms (in-app tap, or an OTP code sent out-of-band).
4. System releases funds to the seller.
5. A dispute **freezes** any automated release until an admin resolves it.

Marketing site: **already built and live at `meduman.sulvatech.com`.** Its only
verbatim headline available at fetch time is *"Secure Escrow for Social Commerce
Transactions."*

**This build is the product app, not the marketing site.** Ship it at
`app.meduman.sulvatech.com`. It must feel like a sibling of the marketing site —
same wordmark, same palette, same type family — but the app's job is clarity under
stress (someone's ₦180,000 is in flight), not persuasion. Do not rebuild the
landing page; §5 includes only the two public pages the app itself owns (the pay
link and the trust badge), plus a thin `/` that redirects authenticated users to
their dashboard and everyone else to the marketing site.

**Audience realities that must shape the UI:**

- Mobile-first, Android-heavy, often on metered data. Small bundles, no heavy
  hero videos, no client-side chart libraries on first paint.
- Users arrive from a WhatsApp/Instagram DM link — the pay page must work
  **logged out** and explain what Meduman is in one screen.
- Trust is the product. Every screen answers "where is my money right now?"
- Money is Naira. Format `₦180,000.00`. Never show raw kobo.

---

## 2. Non-negotiable frontend rules

These mirror the backend's six money-safety rules. A PR that breaks one is a bug
even if it looks right.

1. **Server owns status.** Never write `status` locally, never optimistically flip
   a transaction to `PAYMENT_PROTECTED` / `COMPLETED`, never derive a status from
   a Paystack redirect. Re-read from the API after every action.
2. **A Paystack callback proves nothing.** `/pay/return` must call
   `POST /payments/:reference/verify` and render whatever the server returns. If
   the server says pending, show pending — even though the user just "paid".
3. **Never show or store money as a float.** All amounts cross the wire as
   integer kobo. Format at the render boundary only:
   `new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(kobo / 100)`.
   Amount inputs collect Naira, convert with `Math.round(naira * 100)`, and send
   the integer.
4. **Every mutation is retry-safe from the user's side.** Disable the button while
   in flight, and after any error re-fetch rather than re-firing blindly. Assume
   the user will double-tap; assume their network will drop mid-request.
5. **Disputes freeze release — say so.** When a transaction is `DISPUTED`, hide or
   disable every release-adjacent CTA and show the freeze banner. Do not offer a
   confirm button the server will reject.
6. **Never render a secret.** The API deliberately omits `idempotencyKey`,
   `providerTransferCode`, `paystackSubaccountCode`, OTP codes, and full account
   numbers. If a payload ever contains one, do not display it — report it.

Additional client-side security rules:

- Service-role keys, the Paystack secret key, and `OTP_HASH_SECRET` **never** exist
  in this app. Client env is limited to `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_BASE_URL`, and
  `NEXT_PUBLIC_APP_URL`.
- Evidence files live in a **private** Supabase bucket. Upload via the one-time
  signed PUT URL the API returns; display via a freshly minted signed GET URL.
  Never cache a signed URL in state longer than its lifetime, never put one in a
  shareable link.
- The OTP code is delivered **out-of-band**. `POST /transactions/:id/otp` returns
  only `{ otpId, expiresAt }`. There is no code in the response — do not build UI
  that expects one, and never log the code the user types.
- Role gating in the client is **UX only**. The server enforces roles; a hidden
  admin button is not a security control. Still hide it.

---

## 3. Tech stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Framework | **Next.js 15, App Router, TypeScript strict** | Deployed on Vercel |
| Styling | **Tailwind CSS v4** + CSS variables for tokens | No CSS-in-JS runtime |
| Primitives | **shadcn/ui** (Radix under the hood) | Restyle to the tokens in §4 — do not ship stock shadcn look |
| Auth | **Supabase Auth** via `@supabase/ssr` | Cookie-based sessions, middleware refresh |
| Server data | React Server Components for first paint | Token forwarded from cookies |
| Client data | **TanStack Query v5** | Mutations, polling, cursor pagination |
| Forms | **react-hook-form + zod** | Zod schemas mirror the DTOs in §11 |
| Icons | **lucide-react** | |
| Dates | **date-fns** (`formatDistanceToNow`) | Africa/Lagos display |
| Toasts | **sonner** | |
| QR | **qrcode.react** (seller share sheet only) | Lazy-loaded |
| Tests | **Vitest + Testing Library**, **Playwright** for the two money paths | |
| Analytics | Vercel Analytics only | No third-party pixels on the pay page |

Constraints: no Redux, no tRPC (the API is a fixed REST surface), no `use client`
on a page shell that could be a server component, no `any`, no runtime-fetching a
font from a third party.

### Project structure

```
src/
  app/
    (marketing-bridge)/page.tsx        # / → redirect: authed → dashboard, else marketing site
    (public)/
      pay/[publicLinkId]/page.tsx      # buyer pay page (works logged out)
      pay/return/page.tsx              # Paystack return → server verify
      s/[badgeSlug]/page.tsx           # seller trust badge
    (auth)/
      login/page.tsx  signup/page.tsx  auth/callback/route.ts
    (app)/
      layout.tsx                       # authed shell: nav, notification bell, role switch
      dashboard/page.tsx               # buyer home
      txn/[id]/page.tsx                # buyer transaction detail
      txn/[id]/dispute/page.tsx
      seller/page.tsx                  # seller home
      seller/new/page.tsx
      seller/txn/[id]/page.tsx
      seller/settings/page.tsx
      notifications/page.tsx
    (admin)/admin/...                  # console, ADMIN role only
  components/
    money/            Money, AmountInput
    transaction/      StatusBadge, StatusStepper, TransactionCard, Timeline, ShareLinkCard
    confirm/          ConfirmSheet, OtpInput
    dispute/          DisputeForm, DisputeStatusPanel, EvidenceUploader, EvidenceList
    ui/               shadcn primitives, restyled
  lib/
    api/              typed fetch client + one file per resource
    supabase/         browser.ts, server.ts, middleware.ts
    format/           money.ts, date.ts
    status/           status-meta.ts   # the single source of §7 status→UI mapping
  types/api.ts        # hand-written mirrors of the API views in §11
middleware.ts         # session refresh + route protection
```

---

## 4. Design direction

**Feel:** a Nigerian fintech that a market seller and a Lekki freelancer both
trust on the first screen. Calm, high-contrast, slightly editorial. Confident
spacing, no clutter, no gradient-soup dashboards, no glassmorphism. Think
"receipt you're glad to receive" rather than "trading terminal."

**Avoid the generic AI-SaaS look:** no purple-to-blue gradient hero, no
`shadow-2xl` cards floating on `slate-50`, no emoji as iconography, no three
identical feature cards. Pick one strong accent and commit.

### Tokens

Define as CSS variables in `globals.css`; both themes required.

```
--bg            #FBFAF8   (dark: #0C0F0E)
--surface       #FFFFFF   (dark: #141917)
--surface-sunk  #F2F1EC   (dark: #1B211E)
--border        #E4E1D9   (dark: #2A322E)
--text          #14181A   (dark: #F2F4F1)
--text-muted    #5C6560   (dark: #9AA5A0)

--brand         #0E6B4F   /* protected green — the money-is-safe colour */
--brand-strong  #0A5240
--brand-soft    #E6F1EC   (dark: #10251E)
--accent        #F2A93B   /* action / awaiting-you amber */
--danger         #C0392B  /* dispute, refund, failure */
--info          #2D6CB5  /* processing / in-flight */
```

Semantic aliases used by `status-meta.ts`: `state.neutral` (draft, cancelled,
expired), `state.waiting` (link active, payment pending), `state.protected`
(payment protected, delivery in progress), `state.action` (confirmation pending —
"you must act"), `state.frozen` (disputed), `state.processing` (release
processing), `state.done` (completed), `state.reversed` (refunded).

### Type

- Display / headings: a grotesk with character — **Bricolage Grotesque** or
  **Satoshi**, self-hosted via `next/font/local`.
- Body / UI: **Inter** (`next/font/google`, `display: 'swap'`).
- Numerals: **tabular figures everywhere money or counts appear**
  (`font-variant-numeric: tabular-nums`). Amounts get a slightly tighter
  tracking and a larger optical size than surrounding text.
- Scale: 12 / 14 / 16 / 20 / 24 / 32 / 44. Body 16px minimum — this audience
  reads on cracked screens in sunlight.

### Layout language

- Mobile: single column, 16px gutters, sticky bottom action bar for the primary
  CTA on every transaction screen (thumb reach matters more than elegance).
- Desktop: 1120px max content width. Transaction detail is a two-column split —
  left = state, amount, actions; right = timeline and evidence.
- Radius: 12px cards, 10px inputs and buttons, 999px badges/pills.
- Elevation: one flat border + one subtle shadow token. Nothing floats twice.
- **The amount is the hero on every transaction screen** — largest element after
  the status, always adjacent to the status so the two are read as one fact.
- Motion: 150–200ms ease-out on state change; the status stepper animates its
  progress when a step completes. Respect `prefers-reduced-motion`. Nothing
  auto-scrolls, nothing bounces.

### Trust affordances (use deliberately, not decoratively)

- A **protection banner** on the pay page: "Your money is held by Meduman until
  you confirm delivery."
- A **held-funds strip** on protected transactions showing the amount and who
  holds it right now.
- The **freeze banner** on disputed transactions (danger tint, explicit: automated
  release is stopped).
- Seller **trust badge** chip (`NEW` / `VERIFIED` / `TRUSTED` / `HIGHLY_TRUSTED`)
  with completed-transaction count.

### Accessibility (hard requirements)

WCAG 2.2 AA contrast; never colour alone to convey state (badge = colour + icon +
label); visible focus rings; 44px minimum touch targets; the OTP input is a real
labelled input group with `autoComplete="one-time-code"` and `inputMode="numeric"`;
every status change announced in an `aria-live="polite"` region; full keyboard
path through confirm and dispute flows; forms report errors adjacent to the field
and in a summary.

---

## 5. Route map

`Auth`: 🌐 public · 🔒 signed in · 👑 `ADMIN` role.

| Route | Auth | Purpose |
| --- | --- | --- |
| `/` | 🌐 | Bridge: authed → `/dashboard` (or `/seller` by last-used role), else → marketing site |
| `/pay/[publicLinkId]` | 🌐 | **Critical path.** Buyer lands from a shared link, sees the protected offer, pays |
| `/pay/return` | 🔒 | Paystack return; server-side verify then route to the transaction |
| `/s/[badgeSlug]` | 🌐 | Seller public trust badge (shareable proof) |
| `/login`, `/signup` | 🌐 | Supabase Auth (email OTP/magic link + password) |
| `/auth/callback` | 🌐 | Supabase code exchange → cookie session → next |
| `/dashboard` | 🔒 | Buyer home: protected purchases by status group |
| `/txn/[id]` | 🔒 | Buyer transaction detail: status, timeline, confirm, dispute, evidence, receipt |
| `/txn/[id]/dispute` | 🔒 | Raise / view dispute + evidence (shared buyer & seller) |
| `/seller` | 🔒 | Seller home: KPIs, settlement banner, transaction list, create CTA |
| `/seller/new` | 🔒 | Create a protected transaction, get the shareable link |
| `/seller/txn/[id]` | 🔒 | Seller detail: share link, lifecycle actions, payout status, dispute |
| `/seller/settings` | 🔒 | Business profile, settlement account, verification, badge link |
| `/notifications` | 🔒 | In-app inbox |
| `/admin` | 👑 | Ops overview: dispute queue, stuck releases, awaiting-confirm counts |
| `/admin/transactions` | 👑 | All transactions, filterable |
| `/admin/transactions/[id]` | 👑 | Transaction + timeline + **audit log** + evidence + payout retry |
| `/admin/disputes` | 👑 | Dispute queue |
| `/admin/disputes/[id]` | 👑 | Resolve for seller (release) or buyer (refund) |
| `/terms`, `/privacy` | 🌐 | Static legal (may link out to the marketing site instead) |
| `/offline`, `not-found`, `error` | 🌐 | Required states — see §10 |

---

## 6. Page specifications

Each spec lists **sections → data source → states**. "Poll" means TanStack Query
`refetchInterval` while the status is in the named set, stopping otherwise.

### 6.1 `/pay/[publicLinkId]` 🌐 — buyer pay page (highest-stakes screen)

This is the screen a stranger opens from a DM. It must sell trust and take money.

**Sections**

1. **Seller identity strip** — business display name, trust-level chip, verified
   tick. From `seller` in the public view.
2. **Offer card** — title, description, **amount as hero**, currency.
3. **Fee breakdown** — driven by `feeModel`:
   - `BUYER_PAYS`: show `Item ₦X` + `Protection fee ₦Y` + **`You pay ₦X+Y`**.
   - `SELLER_PAYS`: show `You pay ₦X`, and a muted line "Seller covers the
     protection fee."
   Compute display only from the returned `amount` and `feeAmount` — never invent
   a fee rate client-side.
4. **How protection works** — 3 compact steps (pay → held → confirm → released),
   static copy, no accordion.
5. **Pay CTA** — sticky on mobile.
   - Signed out → "Sign in to pay securely", preserving
     `?next=/pay/[publicLinkId]` through the auth round trip and returning here.
   - Signed in → `POST /payments/initialize { transactionId }`, then
     `window.location.assign(authorizationUrl)`.
   - ⚠️ The public view **does not include the internal `id`**. Resolve the
     transaction id server-side for the authed user (see §15, gap 1) — or, until
     that lands, initialize from the authed pay page variant. Do not guess an id.
6. **Footer trust row** — "Powered by Meduman · Paystack secured", link to
   `/s/[badgeSlug]`.

**Data:** `GET /public/transactions/:publicLinkId` → `PublicTransactionView`.

**States**

| State | Render |
| --- | --- |
| Loading | Skeleton of identity strip + amount + CTA (no spinner-only screen) |
| 404 (link never existed, or status ∉ {`LINK_ACTIVE`,`PAYMENT_PENDING`}) | "This payment link is closed" — explain it may be paid, cancelled, or expired; CTA to Meduman's marketing site. **Never speculate which.** |
| `PAYMENT_PENDING` | Same page + notice "A payment was already started for this link" and a secondary "I already paid — check status" |
| Rate limited (429) | "Too many attempts, try again in a minute" |
| Payment init fails | Inline error under the CTA, CTA re-enabled, no page reset |

**Performance:** server-rendered, no client JS needed to read the offer. Target
LCP < 1.5s on 3G. This page carries no analytics beyond Vercel.

### 6.2 `/pay/return?reference=…` 🔒

1. **Verifying state** — call `POST /payments/:reference/verify` **from the
   server** on load. Copy: "Confirming your payment with the bank…"
2. **Result** — from the returned `{ status }` only:
   - success → "Your money is protected" + amount + CTA to `/txn/[id]`
   - pending → "Still confirming" + auto-retry (poll verify up to 5×, 3s apart,
     then offer a manual "Check again")
   - failed/abandoned → "Payment didn't go through", CTA back to the pay link
3. Never render success because the redirect happened. Never show a receipt on a
   pending verify.

### 6.3 `/dashboard` 🔒 — buyer home

1. **Header** — greeting, "Protected purchases" count.
2. **Status-group tabs** — Active (`PAYMENT_PROTECTED`, `DELIVERY_IN_PROGRESS`),
   **Needs your confirmation** (`CONFIRMATION_PENDING`, badged and first when
   non-empty), Disputed (`DISPUTED`), Closed (`COMPLETED`, `REFUNDED`,
   `CANCELLED`, `EXPIRED`).
   Each tab issues `GET /transactions?role=buyer&status=…`. The API filters one
   status at a time — either fan out per status in a group and merge, or filter
   client-side from the unfiltered first page. Pick one and comment why.
3. **Transaction cards** — title, seller name, `<Money>`, `<StatusBadge>`,
   relative time, and the *next action* as the card's own CTA.
4. **Cursor pagination** — "Load more" using `nextCursor` (never a page number).
5. **Empty state** — "No protected purchases yet" + one line on how Meduman
   works + "Have a payment link?" input that routes to `/pay/[id]`.

### 6.4 `/txn/[id]` 🔒 — buyer transaction detail

1. **Header** — title, `<Money>`, `<StatusBadge>`, seller, created date.
2. **`<StatusStepper>`** — the 12-state lifecycle collapsed into 5 visible steps
   (see §7).
3. **Held-funds strip** — when protected: "₦X held by Meduman."
4. **Action panel** — driven *only* by the §7 mapping:
   - `CONFIRMATION_PENDING` + `releaseRule = BUYER_CONFIRMATION` → **Confirm
     delivery** → confirmation sheet (irreversible-action copy: "This releases
     ₦X to the seller. This cannot be undone.") → `POST /transactions/:id/confirm`
   - OTP variant → "Send me a code" (`POST /transactions/:id/otp`, tight limit:
     3/min) → `<OtpInput>` with `expiresAt` countdown →
     `POST /transactions/:id/confirm-otp { code }`
   - `AUTO_AFTER_WINDOW` → show the auto-release notice and countdown instead
   - `DISPUTED` → freeze banner, all confirm CTAs gone
   - `RELEASE_PROCESSING` → "Releasing to seller…", poll every 5s
   - terminal → receipt block
5. **Raise dispute** — secondary, visible only in `PAYMENT_PROTECTED`,
   `DELIVERY_IN_PROGRESS`, `CONFIRMATION_PENDING` (the only states the server
   accepts) → routes to `/txn/[id]/dispute`.
6. **Timeline** — `GET /transactions/:id/timeline`, ascending, human-readable
   labels (map event keys to sentences; never dump raw enum names).
7. **Evidence** — list + uploader (§6.9). Gate download on `scanStatus === 'CLEAN'`
   once AV scanning exists; today show a "scanning" state for `PENDING`.
8. **Receipt** — on `COMPLETED`/`REFUNDED`: amount, fee, dates, reference; a
   print stylesheet.

**Poll** while status ∈ {`PAYMENT_PENDING`, `RELEASE_PROCESSING`} (5s) and
{`DELIVERY_IN_PROGRESS`, `CONFIRMATION_PENDING`} (30s). Stop on terminal states.

**Errors:** a `409` from any action means the server rejected the transition —
show "This transaction moved on — refreshing" and re-fetch. Never retry a 409.

### 6.5 `/seller` 🔒 — seller home

1. **Settlement banner** — from `GET /users/me/seller`. If `settlementReady` is
   false, a prominent (not dismissible) banner: "Add your payout account to
   receive released funds" → `/seller/settings`. Show
   `settlementAccountLast4` / `settlementAccountName` when present.
2. **KPI row** — Held now, Released (all time), Awaiting buyer confirmation, Open
   disputes. Derived by summing role-scoped list pages — **label them as
   approximate if not all pages are loaded**, or cap the window ("last 50").
   Never present a computed total as an authoritative balance.
3. **Transaction list** — `GET /transactions?role=seller&status=…`, same card and
   cursor pattern as §6.3, with seller-side next actions.
4. **Create CTA** — sticky primary → `/seller/new`.
5. **Badge link** — copyable `/s/[badgeSlug]` when the profile has one.

### 6.6 `/seller/new` 🔒 — create transaction

Single-page form, three grouped fieldsets, one submit.

1. **What are you selling** — `title` (1–200), `description` (≤2000).
2. **Amount** — `<AmountInput>` in Naira → integer kobo. Show the buyer-facing
   total live, recomputed from `feeModel`.
3. **Terms** — `releaseRule` (`BUYER_CONFIRMATION` default | `AUTO_AFTER_WINDOW`,
   each with a one-line plain-English explanation), `feeModel` (`BUYER_PAYS`
   default | `SELLER_PAYS`), `feeAmount` (kobo).
4. **Submit** → `POST /transactions` → `DRAFT`.
5. **Success state — the share sheet.** This is the moment of value: show
   `https://app.meduman.sulvatech.com/pay/[publicLinkId]` with **Copy link**,
   **Share to WhatsApp** (`https://wa.me/?text=…`), **QR code**, and a prominent
   **Publish link** button (`POST /transactions/:id/publish` → `LINK_ACTIVE`).
   Make it unmistakable that a `DRAFT` link is not yet live.

Validation mirrors `CreateTransactionDto` exactly (§11). `releaseRule: ADMIN_ONLY`
exists in the enum but is **not** offered in the UI.

### 6.7 `/seller/txn/[id]` 🔒 — seller detail

Same header/stepper/timeline as §6.4, with the seller's action ladder:

| Status | Primary action | API |
| --- | --- | --- |
| `DRAFT` | Publish link (+ Cancel) | `POST /:id/publish`, `POST /:id/cancel` |
| `LINK_ACTIVE` | Share link (+ Cancel) | share sheet, `POST /:id/cancel` |
| `PAYMENT_PENDING` | none — "Buyer is paying" | — |
| `PAYMENT_PROTECTED` | Start delivery | `POST /:id/start-delivery` |
| `DELIVERY_IN_PROGRESS` | Mark as delivered | `POST /:id/mark-delivered` |
| `CONFIRMATION_PENDING` | none — "Waiting for buyer to confirm" + nudge copy | — |
| `DISPUTED` | Respond with evidence | evidence upload (§6.9) |
| `RELEASE_PROCESSING` | none — "Payout in progress" | poll `GET /:id/payouts` |
| `COMPLETED` | none — payout summary | `GET /:id/payouts` |

Also: **payout panel** from `GET /transactions/:id/payouts` → `PayoutView[]`
(`status`, `attemptCount`, amount, date). Cancel is destructive-adjacent — confirm
with a dialog, and only render it in `DRAFT`/`LINK_ACTIVE` (the only states the
server allows).

### 6.8 `/seller/settings` 🔒

1. **Business profile** — `businessName`, `category` →
   `PATCH /users/me/seller`. `verificationStatus`, `trustLevel`, `badgeSlug` are
   **read-only** — render them, never as inputs.
2. **Settlement account** — the money-sensitive form:
   - Bank select from `GET /users/me/seller/banks` (searchable — there are ~100).
   - `accountNumber`: exactly 10 digits, `inputMode="numeric"`.
   - Submit → `POST /users/me/seller/recipient`. The server resolves the account
     name with the bank; **display the resolved name back for confirmation** and
     never let the user type it.
   - Show the stored account masked (last 4 only). Never render a full number.
   - Once `settlementReady`, show a verified state, and treat re-submitting as a
     deliberate change (confirm dialog).
   - `POST /users/me/seller/subaccount` exists for the subaccount/split path —
     expose it only if the deployment uses subaccount mode; otherwise keep the
     recipient flow. Ask before building both.
3. **Verification / KYC** — status chip + what's needed. No upload flow yet (§15).
4. **Public badge** — copy link to `/s/[badgeSlug]`.

### 6.9 Disputes & evidence — `/txn/[id]/dispute` 🔒 (shared)

1. **Freeze explainer first** — "Opening a dispute stops any automatic release
   until it's resolved." Users must understand this before submitting.
2. **Raise form** — `reason` (radio list of `DisputeReason`, plain-language
   labels), `description` (≤2000), `desiredOutcome` (`REFUND` | `RELEASE` |
   `REPLACEMENT` | `PARTIAL_REFUND`) →
   `POST /transactions/:transactionId/disputes`.
3. **Dispute status panel** — `GET /transactions/:id/disputes`: `OPEN`,
   `UNDER_REVIEW`, `RESOLVED_RELEASE`, `RESOLVED_REFUND`, `RESOLVED_PARTIAL`,
   `CANCELLED` + resolution note + outcome banner.
4. **Evidence** — `<EvidenceUploader>`:
   `POST /transactions/:id/evidence { filename, mimeType, sizeBytes, disputeId? }`
   → PUT the file to `upload.signedUrl` → refresh list. Client-side gate: only
   `image/png`, `image/jpeg`, `image/webp`, `application/pdf`, ≤10 MB, with a
   friendly pre-flight error rather than a server 400. Show upload progress; retry
   is a new registration, not a re-PUT of a spent URL.
5. Download via `GET /evidence/:id/download-url` minted **on click**, opened in a
   new tab, never persisted.
6. There is **no** "withdraw dispute" endpoint yet — do not build the button (§15).

### 6.10 `/notifications` 🔒

`GET /notifications?status=…` list (channel, template, created, read state);
`POST /notifications/:id/read` on open. Bell in the app shell shows an unread
count from the same query. Notifications are **not** a money surface — always link
through to the transaction rather than offering actions inline.

### 6.11 Admin console 👑

- `/admin` — three queue cards with counts: open disputes
  (`GET /admin/disputes?status=OPEN`), stuck releases
  (`GET /admin/transactions?status=RELEASE_PROCESSING`), awaiting confirmation
  (`?status=CONFIRMATION_PENDING`). Each links to a filtered table.
- `/admin/transactions` — dense table (amount right-aligned tabular, status,
  seller, buyer, created), status/seller/buyer filters, cursor pagination, limit
  up to 100.
- `/admin/transactions/[id]` — everything the participants see **plus** the
  **audit log** (`GET /admin/transactions/:id/audit`: actor, action, old → new
  state, reason, timestamp) rendered as an immutable ledger, visually distinct
  from the user-facing timeline. Plus **payout retry**
  (`POST /admin/transactions/:id/payout/retry`) behind a typed confirmation
  ("type RETRY") — it moves money.
- `/admin/disputes` / `/admin/disputes/[id]` — queue and resolution:
  `POST /disputes/:id/resolve { outcome: 'RELEASE' | 'REFUND', resolution? }`.
  Two-step confirm; state the money consequence in the dialog ("₦X will be
  released to the seller" / "refunded to the buyer").

Admin UI is deliberately plainer: information density over polish, every
destructive or money action confirmed, no bulk actions in v1.

---

## 7. The status → UI mapping (single source of truth)

Implement once in `lib/status/status-meta.ts` and import everywhere. No component
may hard-code status strings.

| `TransactionStatus` | Badge label | Token | Buyer sees | Seller sees |
| --- | --- | --- | --- | --- |
| `DRAFT` | Draft | neutral | (not visible) | Publish link / Cancel |
| `LINK_ACTIVE` | Awaiting payment | waiting | Pay now (public page) | Share link / Cancel |
| `PAYMENT_PENDING` | Payment started | waiting | Finish or verify payment | "Buyer is paying" |
| `PAYMENT_PROTECTED` | Protected | protected | "Your money is held" · dispute available | **Start delivery** |
| `DELIVERY_IN_PROGRESS` | Delivering | protected | "Seller is delivering" · dispute | **Mark delivered** |
| `CONFIRMATION_PENDING` | Confirm delivery | **action** | **Confirm / OTP** · dispute | "Waiting for buyer" |
| `DISPUTED` | Dispute open | frozen | Freeze banner · evidence | Freeze banner · evidence |
| `RELEASE_PROCESSING` | Releasing | processing | "Releasing to seller" | "Payout in progress" |
| `COMPLETED` | Completed | done | Receipt | Payout summary |
| `REFUNDED` | Refunded | reversed | Refund receipt | Refund notice |
| `CANCELLED` | Cancelled | neutral | Closed | Closed |
| `EXPIRED` | Expired | neutral | Link expired | Create a new link |

**Stepper collapse (5 visible steps):** Created → Paid & protected → Delivering →
Confirmation → Released. `DISPUTED` renders as a **frozen** marker on the current
step (not a step of its own). `RELEASE_PROCESSING` is the in-flight state of the
Released step. `CANCELLED`/`EXPIRED`/`REFUNDED` render the stepper terminated
early with a clear end cap.

**Terminal states** (`COMPLETED`, `REFUNDED`, `CANCELLED`, `EXPIRED`) accept **no**
events — render zero action CTAs. A visible-but-disabled button here is a bug.

---

## 8. Auth flow

1. `@supabase/ssr` browser client for sign-in/up; server client reads cookies.
2. `middleware.ts` refreshes the session on every matched request and redirects
   unauthenticated hits on `(app)`/`(admin)` routes to
   `/login?next=<pathname>`.
3. `/auth/callback` exchanges the code, sets cookies, redirects to `next`.
4. **After every sign-in, call `GET /users/me`** to materialize the local user
   mirror. Treat this as part of the login transaction — a signed-in user without
   a mirror will fail later calls confusingly.
5. Roles: `roleFlags` (`BUYER`/`SELLER`/`FREELANCER`/`BUSINESS`) from
   `GET /users/me` drive the buyer↔seller nav switch; `app_metadata.role ===
   'ADMIN'` from the JWT gates `(admin)` routes client-side. Server enforces both.
6. Sending the token: every API call attaches
   `Authorization: Bearer <access_token>`. In server components read it from the
   Supabase server client; in client components get it from the browser client at
   call time (never store it in React state or `localStorage`).
7. `401` from the API → refresh once, then sign out and redirect to `/login`.
   `403` → render a "not permitted" state, do not retry.

---

## 9. Data layer

```ts
// lib/api/client.ts — the only place fetch() is called.
export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...init?.headers,
    },
    cache: 'no-store', // money data is never cached by the CDN
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null), res.statusText);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
```

Rules:

- One typed module per resource (`transactions.ts`, `payments.ts`, …) exporting
  functions whose return types come from `types/api.ts` (§11). No inline fetches
  in components.
- Query keys: `['transactions', { role, status, cursor }]`, `['transaction', id]`,
  `['timeline', id]`, `['disputes', id]`, `['payouts', id]`, `['seller','me']`.
- Every mutation invalidates `['transaction', id]` **and** `['timeline', id]`.
- **Status-code → UX map** (implement centrally):
  `400` field errors from `class-validator` (render per-field where the message
  maps) · `401` refresh/sign-out · `403` "not permitted" · `404` not-found state ·
  `409` transition rejected → "this moved on", refetch, never auto-retry ·
  `429` "slow down", show a countdown · `5xx` retry-with-backoff once, then a
  support-friendly error with a copyable request id.
- Cursor pagination only: `nextCursor` from the response, `useInfiniteQuery`, no
  page numbers anywhere.
- Poll windows exactly as specified per page; never poll a terminal state; pause
  polling when the tab is hidden.

---

## 10. Required global states

Build these before the happy paths — this app is used on bad networks.

- **Skeletons** per page shape (not one generic spinner).
- **Empty states** with a next action, per list.
- **Error boundary** (`error.tsx`) per route group with a retry button.
- **`not-found.tsx`** for bad ids and closed links.
- **Offline banner** — `navigator.onLine` + failed-fetch detection; queue nothing,
  just tell the truth.
- **Stale-data notice** — if a poll fails 3× in a row, show "Showing last known
  status" rather than silently displaying stale money state.
- **Maintenance/degraded** — if the API returns 503, a full-page notice.

---

## 11. API contract (authoritative, do not deviate)

Base URL `NEXT_PUBLIC_API_BASE_URL`. All authed calls send
`Authorization: Bearer <supabase access token>`. All money fields are **integer
kobo**. All ids are UUIDs except `publicLinkId` (32-char hex) and `badgeSlug`.

### Public

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/public/transactions/:publicLinkId` | — | `PublicTransactionView` (404 unless status ∈ {`LINK_ACTIVE`,`PAYMENT_PENDING`}) |
| GET | `/public/sellers/:badgeSlug` | — | `SellerPublicView` |
| POST | `/waitlist` | `CreateWaitlistDto` | `202 { ok: true }` (5/min) |
| GET | `/health`, `/health/ready` | — | ops only, not user UI |

### Authed — transactions

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/transactions` | `CreateTransactionDto` | `Transaction` (`DRAFT`) |
| GET | `/transactions` | query `ListTransactionsDto` | `{ items: Transaction[]; nextCursor: string \| null }` |
| GET | `/transactions/:id` | — | `Transaction` (participant/admin) |
| GET | `/transactions/:id/timeline` | — | `TimelineEvent[]` asc |
| GET | `/transactions/:id/disputes` | — | `Dispute[]` |
| GET | `/transactions/:id/payouts` | — | `PayoutView[]` |
| POST | `/transactions/:id/publish` | — | `Transaction` |
| POST | `/transactions/:id/start-delivery` | — | `Transaction` |
| POST | `/transactions/:id/mark-delivered` | — | `Transaction` |
| POST | `/transactions/:id/confirm` | — | `Transaction` (buyer only) |
| POST | `/transactions/:id/cancel` | — | `Transaction` (`DRAFT`/`LINK_ACTIVE` only) |
| POST | `/transactions/:id/otp` | — | `{ otpId, expiresAt }` — **no code** (3/min) |
| POST | `/transactions/:id/confirm-otp` | `{ code: string }` (4–10 digits) | `Transaction` (10/min) |

### Authed — payments, disputes, evidence, users, notifications

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/payments/initialize` | `{ transactionId: uuid }` | `{ paymentId, reference, authorizationUrl }` |
| POST | `/payments/:reference/verify` | — | `{ status: string }` |
| POST | `/transactions/:transactionId/disputes` | `RaiseDisputeDto` | `Dispute` |
| POST | `/disputes/:id/resolve` 👑 | `{ outcome: 'RELEASE'\|'REFUND', resolution? }` | `Dispute`/`Transaction` |
| POST | `/transactions/:id/evidence` | `CreateEvidenceDto` | `{ evidenceId, upload: SignedUploadUrl }` |
| GET | `/evidence/:evidenceId/download-url` | — | `DownloadUrl` (short-lived) |
| GET | `/users/me` | — | `User` |
| GET | `/users/me/seller` | — | `SellerProfileSelfView` |
| PATCH | `/users/me/seller` | `{ businessName?, category? }` | `SellerProfileSelfView` |
| GET | `/users/me/seller/banks` | — | `BankOption[]` |
| POST | `/users/me/seller/recipient` | `{ bankCode: /^\d{3,6}$/, accountNumber: /^\d{10}$/ }` | `SellerProfileSelfView` |
| POST | `/users/me/seller/subaccount` | `{ businessName, settlementBank, accountNumber }` | `SellerProfileSelfView` |
| GET | `/notifications?status=` | — | `Notification[]` |
| POST | `/notifications/:id/read` | — | `Notification` |

### Admin 👑

| Method | Path | Query/Body | Returns |
| --- | --- | --- | --- |
| GET | `/admin/transactions` | `status?, sellerId?, buyerId?, cursor?, limit?≤100` | cursor page |
| GET | `/admin/disputes` | `status?, cursor?, limit?≤100` | cursor page (includes lean transaction) |
| GET | `/admin/transactions/:id/audit` | — | `AuditLog[]` asc |
| POST | `/admin/transactions/:id/payout/retry` | — | `Payout` |

### Types to mirror in `types/api.ts`

```ts
export type TransactionStatus =
  | 'DRAFT' | 'LINK_ACTIVE' | 'PAYMENT_PENDING' | 'PAYMENT_PROTECTED'
  | 'DELIVERY_IN_PROGRESS' | 'CONFIRMATION_PENDING' | 'DISPUTED'
  | 'RELEASE_PROCESSING' | 'COMPLETED' | 'REFUNDED' | 'CANCELLED' | 'EXPIRED';

export type ReleaseRule = 'BUYER_CONFIRMATION' | 'AUTO_AFTER_WINDOW' | 'ADMIN_ONLY';
export type FeeModel = 'BUYER_PAYS' | 'SELLER_PAYS';
export type TrustLevel = 'NEW' | 'VERIFIED' | 'TRUSTED' | 'HIGHLY_TRUSTED';
export type VerificationStatus = 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
export type PayoutStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'REVERSED';
export type PaymentStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'ABANDONED';
export type DisputeReason =
  | 'ITEM_NOT_RECEIVED' | 'NOT_AS_DESCRIBED' | 'DAMAGED'
  | 'SELLER_UNRESPONSIVE' | 'WRONG_ITEM' | 'FRAUD' | 'OTHER';
export type DisputeStatus =
  | 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED_RELEASE' | 'RESOLVED_REFUND'
  | 'RESOLVED_PARTIAL' | 'CANCELLED';
export type DisputeOutcome = 'REFUND' | 'RELEASE' | 'REPLACEMENT' | 'PARTIAL_REFUND';
export type ScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR';
export type UserRole = 'BUYER' | 'SELLER' | 'FREELANCER' | 'BUSINESS';

export interface Transaction {
  id: string;
  publicLinkId: string;
  sellerId: string;
  buyerId: string | null;
  title: string;
  description: string | null;
  amount: number;           // kobo
  currency: string;         // 'NGN'
  status: TransactionStatus;
  releaseRule: ReleaseRule;
  expectedDeliveryDate: string | null;
  expiresAt: string | null;
  feeModel: FeeModel;
  feeAmount: number;        // kobo
  createdAt: string;
  updatedAt: string;
}

export interface PublicTransactionView {
  publicLinkId: string;
  title: string;
  description: string | null;
  amount: number;
  currency: string;
  feeModel: FeeModel;
  feeAmount: number;
  status: TransactionStatus;
  seller: { displayName: string | null; trustLevel: TrustLevel | null; verified: boolean };
}

export interface SellerPublicView {
  businessName: string | null;
  verificationStatus: VerificationStatus;
  trustLevel: TrustLevel;
  completedTransactions: number;
  memberSince: string;
}

export interface SellerProfileSelfView {
  businessName: string | null;
  category: string | null;
  verificationStatus: VerificationStatus;
  trustLevel: TrustLevel;
  badgeSlug: string | null;
  settlementBankVerified: boolean;
  settlementAccountLast4: string | null;   // masked — never a full number
  settlementAccountName: string | null;
  settlementReady: boolean;
}

export interface PayoutView {
  id: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  attemptCount: number;
  createdAt: string;
}

export interface User {
  id: string; email: string; phone: string | null; fullName: string | null;
  roleFlags: UserRole[]; status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  createdAt: string; updatedAt: string;
}
```

Request DTOs (zod schemas must match exactly):

```ts
// POST /transactions
{ title: string(1..200), description?: string(..2000), amount: int > 0,
  releaseRule?: ReleaseRule, feeModel?: FeeModel, feeAmount?: int }

// POST /transactions/:transactionId/disputes
{ reason: DisputeReason, description?: string(..2000), desiredOutcome?: DisputeOutcome }

// POST /transactions/:id/evidence
{ filename: string(..200),
  mimeType: 'image/png'|'image/jpeg'|'image/webp'|'application/pdf',
  sizeBytes: int 1..10485760, disputeId?: uuid }

// GET /transactions
{ role: 'buyer'|'seller', status?: TransactionStatus, cursor?: string, limit?: int 1..50 }

// POST /waitlist
{ fullName: string(..120), email: email, phone?, userType?, channel?, country?, city?,
  useCase?: string(..500), avgTransactionValue?: int ≥ 0 /* kobo */, consent?: boolean }
```

---

## 12. Fixture data (for mockups and tests)

Use these exact values so mockups and Playwright fixtures agree.

```ts
const seller = { displayName: 'Adaeze Threads', trustLevel: 'TRUSTED', verified: true };
const tx = {
  id: '9f1c0c2e-2b7a-4a58-9c1b-6f2d5a8e4f10',
  publicLinkId: 'a3f19c8d4b2e47f0a1c6d95b8e7f2031',
  title: 'Custom Ankara two-piece (size 12)',
  description: 'Made to measure, delivery in Lagos within 5 working days.',
  amount: 18_000_000,      // ₦180,000.00
  feeAmount: 270_000,      // ₦2,700.00
  feeModel: 'BUYER_PAYS',  // buyer pays ₦182,700.00
  currency: 'NGN',
  releaseRule: 'BUYER_CONFIRMATION',
  status: 'CONFIRMATION_PENDING',
};
const smallTx = { title: 'Vintage denim jacket', amount: 2_550_000 }; // ₦25,500.00
const bigTx   = { title: 'Brand shoot — 2 days', amount: 145_000_000 }; // ₦1,450,000.00
```

Copy voice: Nigerian English, plain, no jargon, no exclamation marks in money
contexts. Say "your money is held by Meduman", not "funds are in escrow". Say
"released to the seller", not "disbursed". Never say "guaranteed".

---

## 13. Mockup deliverables (design run)

Each at **375px and 1280px**, **light and dark**:

1. Pay page — `LINK_ACTIVE` signed out · signed in · `BUYER_PAYS` fee breakdown ·
   `SELLER_PAYS` variant · closed-link 404 · loading skeleton
2. Payment return — verifying · protected · pending · failed
3. Buyer dashboard — populated (mixed statuses) · "needs confirmation" badge state ·
   empty
4. Buyer transaction detail — `PAYMENT_PROTECTED` · `CONFIRMATION_PENDING`
   (in-app) · OTP entry with countdown · confirm-irreversible dialog ·
   `RELEASE_PROCESSING` · `COMPLETED` receipt · `DISPUTED` freeze banner
5. Dispute — freeze explainer + raise form · open dispute with evidence list ·
   resolved-refund outcome
6. Seller dashboard — settlement banner (not ready) · KPI row + list · empty
7. Create transaction — form · live buyer-total preview · success share sheet
   (copy / WhatsApp / QR / publish)
8. Seller transaction detail — `LINK_ACTIVE` share · `PAYMENT_PROTECTED` start
   delivery · `CONFIRMATION_PENDING` waiting · `COMPLETED` payout summary
9. Seller settings — profile · bank select · resolved-account confirmation ·
   verified settlement state
10. Trust badge page `/s/[badgeSlug]`
11. Notifications inbox — unread and empty
12. Admin — overview queues · transactions table · transaction detail with audit
    ledger · dispute resolution dialog
13. Component sheet — `StatusBadge` × 12 states, `StatusStepper` × 5 steps +
    frozen + early-terminated, `Money` sizes, `OtpInput`, `EvidenceUploader`
    (idle/uploading/error/scanning), buttons, inputs, toasts, skeletons

---

## 14. Build order

Each milestone ends with `npm run lint && npm run build && npm test` green.

| # | Milestone | Acceptance |
| --- | --- | --- |
| 1 | Foundation | Tokens, fonts, `Money`, `StatusBadge`, `StatusStepper`, `status-meta.ts`, API client, error map. Component sheet renders all 12 states. |
| 2 | Auth + shell | Login/signup/callback, middleware, `GET /users/me` on sign-in, authed shell with role switch + bell. Unauthed hit on `/dashboard` redirects with `next`. |
| 3 | **Buyer money path** | Pay page → initialize → Paystack → return → **server verify** → transaction detail shows `PAYMENT_PROTECTED`. Playwright test: a fake callback with no verify never shows success. |
| 4 | Seller lifecycle | Create → share sheet → publish → start delivery → mark delivered. |
| 5 | **Confirm + release** | In-app confirm and OTP confirm; `RELEASE_PROCESSING` polling → `COMPLETED` receipt. Playwright test: no confirm CTA exists on any terminal or `DISPUTED` state. |
| 6 | Disputes + evidence | Raise, freeze banner, evidence upload via signed URL, download on click. |
| 7 | Dashboards | Both lists, cursor pagination, status groups, empties, seller KPIs + settlement banner. |
| 8 | Settlement + settings | Bank select, recipient creation, masked display, resolved-name confirmation. |
| 9 | Notifications + trust badge | Inbox, unread count, public badge page. |
| 10 | Admin console | Tables, audit ledger, dispute resolution, guarded payout retry. |
| 11 | Polish | A11y audit (axe clean), Lighthouse ≥ 95 on the pay page, offline/stale states, print receipt, dark mode pass. |

---

## 15. Known gaps — do not paper over these

Report, don't invent:

1. **Pay-page transaction id.** `PublicTransactionView` omits the internal `id`,
   but `POST /payments/initialize` needs `transactionId`. Needs either a
   `transactionId` on the authed pay-page read or an
   `initialize-by-publicLinkId` variant. Flag it; do not derive an id client-side.
2. **Line items.** `TransactionItem` exists in the schema with no create endpoint —
   `/seller/new` ships without line items.
3. **Withdraw dispute.** The state machine has `WITHDRAW_DISPUTE`; there is no HTTP
   route. No button.
4. **KYC uploads.** `verificationStatus` is displayed only; there is no document
   upload endpoint.
5. **Evidence AV scanning.** `scanStatus` is always `PENDING` today. Build the
   gate now (`CLEAN`-only downloads once scanning lands) and show a "scanning"
   state meanwhile.
6. **OTP delivery transport.** SMS/WhatsApp delivery is a stub in the backend, so
   in non-production the code appears in server logs. The UI must still assume
   out-of-band delivery and offer a resend (re-call `POST /:id/otp`).
7. **Seller aggregate totals.** No aggregate endpoint exists; KPI numbers are
   client sums over loaded pages. Label the window honestly.

## 16. Out of scope

No marketing/landing pages (already live), no blog or CMS, no chat/DM interface,
no in-app wallet or balance, no crypto, no multi-currency, no admin user
management, no bulk actions, no React Native app, no server-side rendering of any
Paystack widget (always redirect to `authorizationUrl`).
