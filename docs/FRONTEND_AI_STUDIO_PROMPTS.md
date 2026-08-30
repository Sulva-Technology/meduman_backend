# Meduman Frontend — Google AI Studio Build Prompts

**One prompt per page. Paste `PROMPT 0` first (it establishes the design system, stack, and API contract), then paste each page prompt in order.** Every page prompt assumes `PROMPT 0` is already in context.

- **Product**: Meduman — transaction-protection (escrow) platform for social commerce in Nigeria. Buyer pays into a protected state → seller delivers → buyer confirms (OTP/in-app) → funds release to seller. Disputes freeze release.
- **This repo builds only the frontend.** Next.js on Vercel, consuming the existing Meduman REST API.
- **Design north star**: Apple-grade glassmorphism + Google's calm, legible information hierarchy. Simple surface, extreme polish. It must read like a senior product designer and a senior engineer shipped it together — nothing "AI-generated," nothing generic.

---

## PROMPT 0 — MASTER SYSTEM PROMPT (paste this first, keep it pinned)

```
You are a senior product designer and senior front-end engineer building the production
web app for MEDUMAN, a transaction-protection (escrow) fintech for social commerce in
Nigeria. Build in Next.js 14 (App Router) + TypeScript (strict), Tailwind CSS, and
Framer Motion, deployed to Vercel. Output clean, modular, production-grade code — no
placeholder lorem, no dead TODOs, no inline "as any". This app consumes an existing REST
API; do NOT invent backend logic, and NEVER trust client-side state for money or status
(the server owns all transaction state).

=========================================================
DESIGN LANGUAGE — "Quiet Premium"
=========================================================
The aesthetic is Apple glassmorphism married to Google's clarity: generous whitespace,
one clear action per view, frosted translucent surfaces layered over a soft canvas, hairline
borders, and restrained, physical motion. Premium = restraint, precision, and consistency —
never decoration for its own sake.

COLOR TOKENS (define as CSS variables + Tailwind theme; support light [default] and dark):
  --canvas:      #F7F7F7   /* app background, light */
  --canvas-ink:  #081635   /* deep navy, dark sections / dark mode base */
  --surface:     #FFFFFF   /* solid cards */
  --brand:       #232F72   /* primary navy — buttons, links, focus */
  --brand-700:   #1B2559
  --brand-050:   #EEF0F7   /* tint fills, selected chips */
  --ink:         #0A0A0A   /* primary text */
  --muted:       #6B7280   /* secondary text (slate-500) */
  --line:        #E7E8EE   /* hairline borders */
  --success:     #0E9E6E   /* emerald — PROTECTED / released / paid */
  --success-600: #14B87F
  --warning:     #E9A23B   /* amber — pending / funds held / awaiting action */
  --danger:      #EF4757   /* rose — dispute / failed / destructive */
  --info:        #232F72

GLASS RECIPE (the signature surface — build a <GlassCard> primitive):
  background: rgba(255,255,255,0.60);
  backdrop-filter: blur(18px) saturate(140%);   /* -webkit- too */
  border: 1px solid rgba(255,255,255,0.55);
  box-shadow: 0 1px 0 rgba(255,255,255,0.6) inset,
              0 10px 30px -12px rgba(8,22,53,0.18);
  border-radius: 20px;
  Dark mode: background rgba(12,20,44,0.55); border rgba(255,255,255,0.10).
  Behind glass there must be something worth blurring — a soft aurora/mesh gradient blob
  (brand navy + faint emerald) fixed in the page background, low opacity, slow drift.

TYPOGRAPHY (Google Fonts):
  Display / headings: "Space Grotesk", weight 700–800, letter-spacing -0.02em to -0.03em.
  Body / UI: "Plus Jakarta Sans", weights 400/500/600.
  Numeric/money: use tabular-nums.
  Scale: display 60/1.05, h1 40/1.1, h2 30/1.15, h3 22, body 16/1.6, small 14, caption 13.
  Headlines are tight, confident, sentence-case (e.g. "Buy and sell online without fear.").

SHAPE & SPACING:
  Radii: pill (9999px) for buttons/chips, 20px cards, 14px inputs, 28px hero panels.
  8px spacing grid. Roomy: section padding 96–120px desktop, 56px mobile.
  Hairline 1px borders in --line; never heavy shadows on light surfaces.

MOTION (Framer Motion — physical, never flashy):
  Entrances: opacity 0→1 + y 12→0, 400ms, ease [0.22,1,0.36,1], stagger 60ms.
  Hover on interactive glass: lift y -2px + shadow bloom, 180ms.
  Page transitions: subtle fade/scale 0.99→1. Respect prefers-reduced-motion (kill transforms).
  Numbers count up on first paint. Status changes pulse the status pill once.

BUTTONS:
  Primary: solid --brand, white text, pill, weight 600, hover brightness + lift, active scale .98.
  Secondary: glass/translucent with hairline border.
  Ghost/tertiary: text-only navy.
  Destructive: --danger. All buttons: 44px min touch target, visible focus ring (--brand, 2px offset).

COMPONENT LIBRARY to build first (reuse everywhere):
  GlassCard, Button, StatusPill (color-mapped, see states), MoneyText (kobo→₦ formatter),
  Input/Field/FormRow, Select, Modal/Sheet (glass, blurred backdrop), Toast, Tabs,
  Timeline (vertical stepper), EmptyState, Skeleton (shimmer), Avatar, Badge, CopyButton,
  DataTable (sortable, cursor-paginated), NavShell (sidebar + topbar), OTPInput (6-cell).

ACCESSIBILITY & QUALITY BAR:
  WCAG AA contrast, full keyboard nav, focus-visible rings, aria labels, semantic HTML,
  reduced-motion support, responsive from 360px → 1440px, dark mode parity.
  Every async surface has three states: loading (skeleton), empty (EmptyState), error (retry).
  Never a raw JSON error to the user; map to a friendly message.

=========================================================
DOMAIN + API CONTRACT (do not deviate)
=========================================================
Base URL from NEXT_PUBLIC_API_BASE_URL. Auth: Supabase Auth on the client issues a JWT;
send it as `Authorization: Bearer <token>` on every protected call. No passwords or login
endpoints on this backend — use @supabase/ssr for session/cookies. Build a typed `apiClient`
(fetch wrapper) that injects the token, handles 401 (redirect to /login), 403, 409
(TransitionRejectedError — show the reason), and 429 (rate limit — back off).

MONEY: all amounts are integer minor units (KOBO). Never use floats. Format ₦ with
Intl.NumberFormat('en-NG', {style:'currency', currency:'NGN'}) on (kobo/100). Inputs collect
naira, convert to kobo before sending.

TRANSACTION STATUS is a server-owned enum — the EXACT 12-state lifecycle (do not rename,
do not invent states). NEVER hardcode transitions client-side — read the tx's current `status`
and render allowed actions from what the API returns. The states + StatusPill color map:
  DRAFT              (slate)   being built by seller, no active link yet
  LINK_ACTIVE        (brand)   payment link live, awaiting a buyer
  PAYMENT_PENDING    (brand)   buyer initiated payment, not yet verified
  PAYMENT_PROTECTED  (amber)   funds collected & verified — held, not with seller
  DELIVERY_IN_PROGRESS (amber) seller delivering
  CONFIRMATION_PENDING (amber) delivered, awaiting buyer confirmation (OTP/in-app)
  DISPUTED           (rose)    open dispute — automated release frozen
  RELEASE_PROCESSING (emerald) release job in flight (idempotency guard window)
  COMPLETED          (emerald) funds released to seller, transaction closed
  REFUNDED           (slate muted) funds returned to buyer
  CANCELLED          (slate muted) terminated before protection/release
  EXPIRED            (slate muted) link/window lapsed with no payment
  (Treat any unknown/future status gracefully with a neutral pill.)

RELEASE RULE (server-owned enum, read-only in UI): BUYER_CONFIRMATION (buyer confirms via OTP
or in-app) | AUTO_AFTER_WINDOW (auto-release after a confirmation window elapses, via cron) |
ADMIN_ONLY (only an admin can release — high-value / manual). Display it; never let the client
change it.

FEE MODEL (for the pricing/checkout copy): BUYER_PAYS (fee added on top, charged to buyer) |
SELLER_PAYS (fee deducted from the seller's settlement).

ENDPOINTS the frontend uses (all JSON):
  PUBLIC (no auth):
    POST /waitlist                                   {name,email,role,...} idempotent
    GET  /public/transactions/:publicLinkId          lean pay-page projection (only in
                                                     LINK_ACTIVE/PAYMENT_PENDING, else 404)
    GET  /public/sellers/:badgeSlug                  seller trust badge
    GET  /banks                                      bank list for payout picker
  AUTH (Bearer):
    GET  /users/me
    GET|PATCH /users/me/seller                       seller profile (server-owned fields readonly)
    POST /users/me/seller/subaccount                 idempotent Paystack subaccount
    POST /users/me/seller/recipient                  resolve NUBAN + create transfer recipient
    GET  /transactions                               role-scoped cursor list (?cursor=&limit=)
    POST /transactions                               create draft (server owns publicLinkId/totals)
    GET  /transactions/:id
    GET  /transactions/:id/timeline
    GET  /transactions/:id/disputes
    GET  /transactions/:id/payouts                   (idempotency secrets omitted)
    seller lifecycle: publish / start-delivery / mark-delivered (POST subroutes)
    buyer: POST /transactions/:id/otp                request OTP (code sent OUT-OF-BAND)
           POST /transactions/:id/confirm-otp        {code} → confirm delivery → release
    POST /transactions/:id/cancel                    DRAFT/LINK_ACTIVE only
    payments: POST initialize collection → returns Paystack authorization_url (redirect);
              server-side verify happens via webhook (client callback is NEVER trusted)
    disputes: POST /transactions/:id/dispute         {reason} → OPEN freezes release
    evidence: POST /transactions/:id/evidence        + GET /evidence/:id/download-url (signed)
    notifications: GET /notifications  |  POST /notifications/:id/read
  ADMIN (@Roles ADMIN):
    GET /admin/transactions  |  GET /admin/disputes
    GET /admin/transactions/:id/audit                immutable audit log
    resolve dispute (release/refund)  |  POST /admin/transactions/:id/payout/retry
  INVOICING (phase 1 — IMPORTANT: the service + DTOs exist but the HTTP CONTROLLER is NOT
    built yet, so these routes are NOT live. Build the invoice UI against these exact DTO
    shapes and assume conventional REST routes will be added; keep them behind a feature flag
    / mockable data layer so the app compiles before the backend exposes them):
    Expected shape once wired:
      POST   /invoices                 create DRAFT (CreateInvoiceDto below)
      GET    /invoices                 seller's list
      GET    /invoices/:id             read one
      PATCH  /invoices/:id             edit a DRAFT (UpdateInvoiceDto = partial CreateInvoiceDto)
      POST   /invoices/:id/send        mints ONE protected Transaction + pay link, delivers it
      POST   /invoices/:id/void        cancel (pre-PAID only)
      GET    /public/invoices/:publicViewId   buyer-facing read-only view (allow-listed)
    CreateInvoiceDto (seller sends inputs only — server owns number, status, ALL money totals,
    publicViewId, and the linked transaction):
      { buyerName?, buyerEmail?, buyerPhone?, dueDate?(ISO8601),
        taxRatePctBp?(int, basis points; 750 = 7.5% VAT; 0–10000; omit = no tax),
        notes?(≤2000), terms?(≤2000),
        lineItems: [{ title(1–200), description?(≤2000), quantity(int>0),
                      unitPrice(int kobo ≥0) }]  // min 1 item; NEVER send lineTotal — server computes it
      }
    InvoiceStatus enum: DRAFT (building, no tx yet) | SENT (tx + pay link minted, delivered) |
      VIEWED (buyer opened the public view) | PAID (linked tx reached PAYMENT_PROTECTED,
      derived) | OVERDUE (dueDate passed, cron-set) | VOID (seller cancelled, pre-PAID only).
    PublicInvoiceView fields (the buyer-facing projection, no internal ids): number, status,
      issueDate, dueDate, currency, buyerName, lineItems[{title,description,quantity,unitPrice,
      lineTotal}], subtotal, taxAmount, total, notes, terms, sellerName, sellerBadgeSlug,
      payLinkId (the /pay/[publicLinkId] id once sent, else null).
    Money on an invoice: subtotal, taxAmount, total are all server-computed kobo — display only.
    An invoice is the seller-facing front door to creating a protected tx.

ROUTING (App Router):
  Public/marketing:  /  /how-it-works  /buyers  /sellers  /pricing  /security  /waitlist
                     /sandbox   /pay/[publicLinkId]   /s/[badgeSlug]   /invoice/[publicViewId]
  Auth:              /login  /signup
  App (authed):      /app (dashboard)  /app/transactions  /app/transactions/[id]
                     /app/transactions/new  /app/invoices  /app/invoices/new
                     /app/disputes  /app/payouts  /app/notifications  /app/settings
                     /app/settings/payout
  Admin:             /admin  /admin/transactions/[id]  /admin/disputes

Deliver: a component-driven Next.js app. When I ask for a page next, build the full page
plus any missing shared primitives, wired to the endpoints above, with loading/empty/error
states, responsive + dark mode + motion, matching the design language exactly.
```

---

## PROMPT 1 — Landing / Home (`/`)

```
Build the Meduman marketing landing page (route `/`), public, no auth. It is the trust
statement for a Nigerian social-commerce escrow product. Premium, calm, Apple-glass over a
soft aurora background. Sections top to bottom:

1) Sticky glass navbar: Meduman wordmark + shield logo (left); center nav [How It Works,
   Buyers, Sellers Hub, Pricing, Security]; right [Live Sandbox] ghost + [Join Waitlist]
   primary pill. On scroll, navbar gains stronger blur + hairline bottom border. Mobile: glass
   slide-down sheet menu.
2) Hero: eyebrow chip "Fintech Transaction Escrow". Display headline (Space Grotesk 800,
   tight): "Buy and sell online without fear." with "without fear." in brand navy.
   Subcopy: "Meduman protects peer-to-peer social commerce payments until delivery is
   complete." Primary [Join Early Access] + secondary [Explore How It Works]. Small line:
   "Or run our interactive Live Protection Sandbox" (link → /sandbox).
   RIGHT of hero: a floating glass "Protection Card" mock showing: Lock ID #MED-9402,
   "Secure Escrow Active" emerald dot, Protection Balance ₦45,000, and a 3-step milestone
   timeline (Fund Deposited → In Delivery → Released) with the first step done. This card
   gently floats (Framer Motion y-oscillation) and has a real backdrop blur over the aurora.
3) "The Safety Imperative": heading "Why social commerce lacks structural trust." Three glass
   cards — Silent Scams, Fake Bank Alerts, The Meduman Cure — each icon + title + 2 lines.
4) "Product Gateways": two large split glass panels — "For Selective Buyers" (→ /buyers) and
   "For Professional Sellers" (→ /sellers), each with a CTA button.
5) Regulated-security band on a dark --canvas-ink section with subtle emerald glow:
   "Regulated Security. Institutional Vaults." — funds sit in tier-1 CBN-licensed partner banks.
6) FAQ accordion (glass rows): payouts speed, non-dispatch refund, disputes, fees.
7) Waitlist CTA band: "Join the Meduman Waitlist" → primary [Join Early Access] (→ /waitlist)
   + [Fill Detailed Profile].
8) Footer: logo + tagline, Company / Buyers / Sellers link columns, CBN compliance note,
   © 2026 Meduman, Privacy + Terms links.

Motion: staggered section reveals on scroll (IntersectionObserver / Framer whileInView).
Copy tone: confident, plain, trust-first. Fully responsive + dark mode. No real API calls
here except the Join Waitlist buttons route to /waitlist.
```

---

## PROMPT 2 — How It Works (`/how-it-works`)

```
Build `/how-it-works` (public). Explain the protected-transaction flow as a premium, scannable
story. Sections:
1) Hero: "How protection works, end to end." + one-line subcopy.
2) A horizontal (desktop) / vertical (mobile) 5-step flow with connective line and glass step
   cards, each numbered, icon, title, one sentence:
   1 Buyer pays into protection (funds held, not with seller)
   2 Seller delivers
   3 Buyer confirms (OTP or in-app)
   4 System releases funds to the seller
   5 Disputes freeze automated release
   Animate the connecting line drawing in on scroll; steps stagger in.
3) "What each side sees" — two tabs (Buyer view / Seller view) swapping annotated glass
   product mockups.
4) Trust guarantees strip: server owns state, funds never release without a valid release
   event, every action is audit-logged (6 rules, phrased for laypeople).
5) CTA band → /waitlist. Full responsive + dark mode + reduced-motion fallback.
```

---

## PROMPT 3 — Buyers page (`/buyers`)

```
Build `/buyers` (public) — the Buyer Shield story. Hero "Keep your money until the goods
arrive." Sections: benefits (pay into protection, verify seller trust badge, dispute if it
goes wrong, auto-refund on non-delivery), a "Buyer Shield Protocol" numbered explainer, a
seller-trust-badge preview card (links conceptually to /s/[badgeSlug]), an FAQ, and a CTA to
join the waitlist. Same glass system, emerald accents for "protected" language. Responsive +
dark mode.
```

---

## PROMPT 4 — Sellers Hub (`/sellers`)

```
Build `/sellers` (public) — the Merchant Hub story. Hero "Get paid the moment buyers confirm."
Sections: seller benefits (validate real deposit intent before shipping, instant payout after
buyer OTP confirmation, dispute protection, a public trust badge that grows conversion), a
"Merchant onboarding in 3 steps" explainer (create account → set up payout destination →
share a protected payment link/invoice), a payout-timeline visual, pricing teaser (→ /pricing),
and a CTA to join. Amber/emerald accents. Responsive + dark mode.
```

---

## PROMPT 5 — Pricing (`/pricing`)

```
Build `/pricing` (public). Clean glass pricing layout for a transaction-fee model (fee taken
on protected transactions; show as a simple "X% per protected transaction, settled to your
CBN-partner-backed balance" — use placeholder rates clearly marked as such, do NOT invent
binding numbers). Include: a fee explainer card, a "what's included" checklist (escrow
protection, dispute resolution, OTP release, trust badge, payout to your bank), an interactive
fee calculator (naira input → estimated fee + seller net, formatted ₦, kobo-safe math), and an
FAQ (when am I charged, refunds, chargebacks). CTA → /waitlist. Responsive + dark mode.
```

---

## PROMPT 6 — Security Layer (`/security`)

```
Build `/security` (public) — the trust/compliance page. Communicate: funds held in tier-1
CBN-licensed partner banks (never in Meduman's operating account), signature-verified payment
webhooks, OTP-gated release, immutable audit logging, and dispute freezes. Layout: hero
"Institutional-grade protection.", a grid of security-pillar glass cards each with an icon,
a "Where your money sits" diagram (buyer → protected vault → seller, with the vault highlighted
emerald), and a compliance/regulatory note. Serious, restrained, high-trust tone. Responsive +
dark mode.
```

---

## PROMPT 7 — Waitlist (`/waitlist`)

```
Build `/waitlist` (public) — the conversion form. Two-column: left = value copy + social-proof
strip; right = a glass form card. Fields: full name, email (validated), role selector (Buyer /
Seller / Business — segmented glass control), optional phone, optional "what do you sell / buy",
and optional country/state. Client-side validation with inline errors, disabled submit until
valid. Submit → POST /waitlist (idempotent; a repeat email returns success, not an error — treat
409/duplicate as success). States: submitting (button spinner), success (card flips to a
celebratory confirmation with a shield check animation + "You're on the list" + share buttons),
error (retry). Honeypot + basic anti-spam. Respect reduced motion. Responsive + dark mode.
```

---

## PROMPT 8 — Live Protection Sandbox (`/sandbox`)

```
Build `/sandbox` (public) — an interactive, NON-transactional demo that simulates the full
protection lifecycle locally (no real money, clearly labeled "Sandbox — no real funds"). A glass
console lets the visitor role-play: create a mock protected transaction (enter item + naira
amount), "Buyer pays" (animate funds moving into a glowing vault), "Seller delivers", "Buyer
confirms with OTP" (fake 6-cell OTP input, any code works but show the real UX), then watch
"Funds released to seller." Include a branch: "Raise a dispute" freezes release and shows the
frozen state. A live status pill + vertical timeline update at each step with motion. This is a
front-end simulation only — do not call the API. It should feel exactly like the real app so
visitors trust it. Responsive + dark mode + reduced-motion.
```

---

## PROMPT 9 — Public Pay Page (`/pay/[publicLinkId]`)

```
Build `/pay/[publicLinkId]` (public, no auth) — the page a buyer lands on from a seller's
shared protection link. On load, GET /public/transactions/:publicLinkId. This returns a lean,
allow-listed projection and is ONLY visible when the tx is LINK_ACTIVE or PAYMENT_PENDING —
render a friendly "This link is no longer active" state on 404.
Layout (single, focused, mobile-first): a glass "Protected Payment" card showing seller
display name + trust badge, item/order summary, the amount (MoneyText, kobo→₦), an explainer
strip "Your money is held safely until you confirm delivery — Meduman never releases it to the
seller until then," and a big primary [Pay Securely] button. Pressing it POSTs to initialize
collection and REDIRECTS to the returned Paystack authorization_url (never collect card
details in this UI — Paystack hosts checkout). On return, show a pending/verifying state
("We're confirming your payment — this updates automatically") because status only changes via
the signed server webhook, never a client callback. Trust signals: CBN-partner note, lock icon,
Meduman branding. States: loading skeleton, inactive/404, error. Extremely clean and reassuring.
Responsive + dark mode.
```

---

## PROMPT 10 — Seller Trust Badge (`/s/[badgeSlug]`)

```
Build `/s/[badgeSlug]` (public) — a shareable seller trust page. GET /public/sellers/:badgeSlug.
Show: seller avatar/name, a large "Verified on Meduman" glass badge with emerald check,
trust metrics the API returns (e.g. completed protected transactions, member since, dispute
handling), an explainer "What this badge means" (funds are protected on every order), and a CTA
for buyers "Ask this seller for a Meduman protected link." Shareable (OG meta tags, copy-link
button). 404 state for unknown slug. Responsive + dark mode.
```

---

## PROMPT 11 — Auth: Login & Signup (`/login`, `/signup`)

```
Build `/login` and `/signup` using Supabase Auth (@supabase/ssr) — this backend has NO login
endpoints; Supabase issues the JWT the app sends as Bearer. Split layout: left = brand panel
(dark --canvas-ink, aurora, one-line trust statement + floating protection-card mock); right =
glass auth card. Support email magic-link and/or email+password per Supabase config, plus OAuth
buttons if enabled (Google). Signup collects name + role (Buyer/Seller). On success, sync via
GET /users/me and route to /app. Handle: invalid creds, unverified email, rate limit, loading
spinners, and a "check your inbox" state for magic links. Never store the raw password anywhere;
never call a backend login route. Full validation, accessible forms, responsive + dark mode.
Redirect already-authed users to /app.
```

---

## PROMPT 12 — App Shell / NavShell (used by all `/app/*`)

```
Build the authenticated app shell that wraps every /app/* route. Layout: a fixed glass left
sidebar (desktop) collapsing to a bottom tab bar / hamburger sheet on mobile. Sidebar nav:
Dashboard, Transactions, Invoices, Disputes, Payouts, Notifications, Settings. Top bar: page
title/breadcrumb, global search (transactions by id/item), a notifications bell (unread count
from GET /notifications), and a user menu (avatar → profile, payout setup, sign out). The shell
reads the session (redirect to /login if none), fetches GET /users/me once and provides it via
context, and shows the user's role (Buyer/Seller/Admin) — Admin sees an extra "Admin" nav item
→ /admin. Aurora background behind content; content area is a scrollable column with roomy
padding. Persist collapsed/expanded sidebar. Loading skeleton on first paint. Responsive + dark
mode. This shell is the frame for every subsequent /app prompt.
```

---

## PROMPT 13 — Dashboard (`/app`)

```
Build `/app` — the authenticated home. Role-aware. Fetch GET /users/me + GET /transactions
(recent slice). Top: greeting + a row of glass stat tiles with count-up numbers:
  Seller view: Protected balance (funds held for you), Awaiting your delivery, Awaiting buyer
    confirmation, Released this month, Open disputes.
  Buyer view: Protected right now (your money held safely), Awaiting delivery, Awaiting your
    confirmation, Completed, Open disputes.
Below: a "Needs your attention" panel listing actionable transactions (seller: publish / start
delivery / mark delivered; buyer: confirm delivery / pay) each as a glass row with a status pill
and a single primary action. Then a "Recent activity" timeline (from notifications/timeline) and
quick actions (seller: [New protected link] → /app/transactions/new, [New invoice] →
/app/invoices/new; buyer: [Enter a pay link]). Every tile/row links deep. Loading skeletons,
empty states ("No protected transactions yet — create your first link"), error retry.
Amber = held, emerald = released, rose = disputed. Responsive + dark mode + motion.
```

---

## PROMPT 14 — Transactions List (`/app/transactions`)

```
Build `/app/transactions` — a role-scoped list. GET /transactions with cursor pagination
(?cursor=&limit=). The API always intersects the caller id, so a user only sees their own.
Render a glass DataTable: columns = Tx ref / item summary, Counterparty, Amount (MoneyText),
Status (StatusPill), Created, and a row action → /app/transactions/[id]. Add: a status filter
(segmented chips mapping to the state groups), a search box, and "Load more" cursor pagination
(infinite scroll optional). Mobile: cards instead of table rows. Empty state per role
("No transactions yet"). Loading skeleton rows, error retry. Do not compute or mutate status
client-side — display server values only. Responsive + dark mode.
```

---

## PROMPT 15 — Transaction Detail (`/app/transactions/[id]`)

```
Build `/app/transactions/[id]` — the heart of the app. Fetch GET /transactions/:id and, as
tabs/sections, GET /transactions/:id/timeline, /disputes, /payouts. Layout:
- Header: item title, tx ref (CopyButton), big Amount (MoneyText), a prominent StatusPill, and
  the counterparty. A subtle "protected" ribbon when funds are held.
- Primary action zone (role- + status-aware — render ONLY actions the current status allows;
  read status from the API, never hardcode a client transition):
    Seller: Publish link (DRAFT) / Start delivery / Mark delivered / (view payout).
    Buyer: Pay (redirect to Paystack) / Request delivery OTP → confirm / Confirm in-app.
    Either party (when eligible): Raise a dispute; Cancel (DRAFT/LINK_ACTIVE only).
  Each action calls its POST subroute, shows optimistic pending → refetches; on 409
  (TransitionRejectedError) show the server's reason in a toast and re-sync.
- Vertical Timeline component (glass stepper) rendering /timeline events with actor + timestamp.
- Tabs: Overview | Timeline | Disputes | Payouts.
    Disputes tab: list disputes + a "Raise dispute" entry (→ Prompt 18 flow).
    Payouts tab: payout attempts/status (idempotency secrets are omitted by the API — never
      display or expect them).
- If DISPUTED: a rose banner "Release is frozen while this dispute is open."
- Confirm-delivery OTP flow inline (Prompt 17): [Request OTP] → OTPInput → POST /confirm-otp.
Loading skeleton, not-found (403/404) state, error retry. Everything server-truth. Responsive +
dark mode + motion (status pill pulses on change).
```

---

## PROMPT 16 — Create Transaction / Protected Link (`/app/transactions/new`)

```
Build `/app/transactions/new` (seller). A focused, multi-step glass wizard to create a DRAFT
protected transaction, then publish it to get a shareable link. Steps:
1) Item details: title, description, one or more line items (name + naira price + qty). Show a
   running total (MoneyText, kobo-safe — convert naira input to kobo before send).
2) Buyer & terms: optional buyer email/phone, delivery expectation note, release rule display
   (server decides; show read-only). Reassure: "Meduman calculates and owns the totals — you
   can't be short-changed by a client edit."
3) Review & create: POST /transactions (server owns publicLinkId + totals — never send a total
   the client computed as authoritative; the server recomputes). On success, show the created
   DRAFT with a [Publish link] action (POST publish) that returns/exposes the public
   /pay/[publicLinkId] URL with a big CopyButton + share-to (WhatsApp/Instagram/Telegram) links,
   since this is social commerce.
Validation per step, back/next, progress indicator, loading + error states. Responsive + dark
mode. On publish, offer "View transaction" → /app/transactions/[id].
```

---

## PROMPT 17 — Buyer Confirm & OTP Release (component + inline on Tx Detail)

```
Build the buyer delivery-confirmation + OTP release experience, used inline on
/app/transactions/[id] when the tx is in CONFIRMATION_PENDING (and as a standalone focused view
if deep-linked). Flow:
1) A glass "Confirm you received your order" card. Primary [Request confirmation code] →
   POST /transactions/:id/otp. The code is delivered OUT-OF-BAND (SMS/WhatsApp/chat) — NEVER
   shown in the UI or the response. Show "We sent a code to your phone."
2) A 6-cell OTPInput (auto-advance, paste support, numeric). Submit → POST
   /transactions/:id/confirm-otp {code}. On success: confirmation drives release; show a
   celebratory "Delivery confirmed — funds are being released to the seller" state with an
   emerald release animation, then refetch tx (status → RELEASE_PROCESSING/PAYOUT_SUCCEEDED).
3) Error handling is generic to the user (the API is fail-closed and gives no oracle): show
   "That code didn't work — check and try again" with attempts remaining if the API returns it,
   a resend option, and a locked/expired state when the API says so. Never reveal why a code
   failed beyond generic. Reduced-motion friendly. Responsive + dark mode.
```

---

## PROMPT 18 — Disputes: Raise + View + Evidence (`/app/disputes` + inline)

```
Build the dispute experience: a list page `/app/disputes` and a raise/detail flow reused on
/app/transactions/[id].
- `/app/disputes`: GET the caller's disputes (via tx disputes / a disputes list). Glass rows:
  tx ref, reason summary, status (OPEN = rose "Release frozen", RESOLVED = neutral/emerald),
  opened date → detail.
- Raise flow (from a transaction): a glass modal/sheet — reason (required, structured category +
  free text), then evidence upload. Evidence: POST /transactions/:id/dispute {reason}, then
  upload files via POST /transactions/:id/evidence (images/PDF; show upload progress; files go to
  a PRIVATE bucket — to view later, GET /evidence/:id/download-url for a short-lived signed URL,
  never a public link). On success show "Dispute opened — automated release is now frozen for
  this transaction" (rose banner) and refetch tx.
- Dispute detail: reason, timeline, evidence thumbnails (fetched via signed URLs on demand), and
  the current freeze state. Resolution is admin-only (buyers/sellers can't resolve). Loading,
  empty ("No disputes — that's a good thing"), error states. Responsive + dark mode.
```

---

## PROMPT 19 — Payout Setup (`/app/settings/payout`)

```
Build `/app/settings/payout` (seller) — connect where released funds are paid. Two parts:
1) Subaccount: POST /users/me/seller/subaccount (idempotent Paystack subaccount) — a glass card
   "Enable payouts" with a single action; show connected state once done.
2) Bank destination: GET /banks to populate a searchable bank Select, then account-number input
   (NUBAN, 10 digits). On blur, POST /users/me/seller/recipient which RESOLVES the account at
   the bank and returns the bank-verified account name — display that name (from the server,
   never editable by the user) for confirmation, then save. Persisted fields shown: bank name,
   account name, and last 4 digits only (the full number is never stored or shown again). One
   destination per seller; changing it re-resolves. States: resolving spinner, "couldn't verify
   this account" error, verified confirmation. Security note: "Meduman verifies your account with
   the bank — we only keep the last 4 digits." Responsive + dark mode.
```

---

## PROMPT 20 — Seller Profile & Settings (`/app/settings`)

```
Build `/app/settings` (authed). Tabs: Profile, Seller, Payout (links to /app/settings/payout),
Notifications, Security.
- Profile: GET /users/me — name, email (readonly from auth), avatar, role.
- Seller tab: GET|PATCH /users/me/seller — editable display name, bio, and the public trust
  badge slug/URL (with a preview link to /s/[badgeSlug] + CopyButton). Server-owned fields
  (verification status, metrics) are read-only and clearly marked.
- Notifications: channel preferences (in-app always; SMS/WhatsApp per availability).
- Security: session info + sign out everywhere (via Supabase).
PATCH saves with optimistic UI + toast, validation, error states. Never let the client write
server-owned fields. Responsive + dark mode.
```

---

## PROMPT 21 — Notifications Inbox (`/app/notifications`)

```
Build `/app/notifications` (authed). GET /notifications (ownership-scoped). Glass list grouped
by date: each item = icon (by type: payment, delivery, confirmation, payout, dispute), title,
one-line body, timestamp, unread dot. Clicking an item marks it read (POST /notifications/:id/read)
and deep-links to the related transaction/dispute. Header: unread count + [Mark all read]. The
bell in the app shell reads the same unread count. Note: OTP codes and other secrets are NEVER
in notification bodies (metadata only) — reflect that. Loading skeleton, empty state ("You're all
caught up"), error retry. Real-time-ish: poll or revalidate on focus. Responsive + dark mode.
```

---

## PROMPT 22 — Payouts (`/app/payouts`)

```
Build `/app/payouts` (seller) — a ledger of released funds. Aggregate the caller's payouts
(from /transactions/:id/payouts across their transactions, or a payouts list endpoint if
available). Top: stat tiles — Total released, Pending release, Failed/needs attention. Below: a
glass table — transaction ref, amount (MoneyText), status (PENDING amber, SUCCEEDED emerald,
FAILED/REVERSED rose), date → deep link to the tx. Payout idempotency/reference secrets are
omitted by the API — never display them. A FAILED payout shows an informational "Our team is on
it — funds stay protected" note (retry is admin-only, never a seller self-serve button here).
Loading, empty, error states. Responsive + dark mode.
```

---

## PROMPT 23 — Invoices List (`/app/invoices`) — phase 1

```
Build `/app/invoices` (seller). NOTE: invoice HTTP routes are NOT live yet — build against the
DTO shapes in PROMPT 0 through a mockable data layer / feature flag so the app compiles now and
flips to real fetches later (GET /invoices). An invoice is the seller-facing front door to
creating a protected tx (sending mints one). Glass table columns: `number` (e.g. INV-0001),
customer (buyerName/buyerEmail), `total` (MoneyText, kobo→₦), status (StatusPill), issueDate /
dueDate → detail. InvoiceStatus map: DRAFT→neutral, SENT→brand, VIEWED→amber, PAID→emerald,
OVERDUE→rose, VOID→muted. Header: [New invoice] → /app/invoices/new, status filter chips, search.
Row actions where the status allows: edit (DRAFT only), send (DRAFT), void (pre-PAID only), copy
pay link (uses `payLinkId` once SENT). Server owns number, status, and all totals — display only.
Loading, empty ("No invoices yet — create your first"), error states. Responsive + dark mode.
```

---

## PROMPT 24 — Invoice Create / Edit (`/app/invoices/new`, `/app/invoices/[id]/edit`) — phase 1

```
Build the invoice editor (create + edit) as a glass, two-column composer. Use the exact
CreateInvoiceDto from PROMPT 0 (routes not live yet — mockable data layer). Left = form:
  - Customer: buyerName, buyerEmail, buyerPhone (all optional).
  - Line items (min 1): title (1–200, required), description (optional ≤2000), quantity
    (int > 0), unit price (naira input → convert to kobo `unitPrice`). Add/remove rows,
    reorderable. NEVER send lineTotal — the server computes it.
  - dueDate (ISO date, optional), taxRatePctBp (optional; a "VAT %" input that maps to basis
    points — 7.5% → 750; range 0–100% → 0–10000), notes (≤2000), terms (≤2000).
Right = a live, Meduman-branded invoice preview card. Compute a CLIENT-SIDE PREVIEW of subtotal
(Σ unitPrice×qty), tax (subtotal × taxRatePctBp/10000), and total in kobo for display only, with
a visible "Totals are finalized by Meduman on save" note (the server recomputes and owns them —
money rule 1). Show the invoice `number` as "assigned on save" until created.
Actions: [Save draft] (POST /invoices or PATCH /invoices/:id), [Send] (POST /invoices/:id/send —
confirm dialog: "Sending mints a protected payment link your customer pays into, and you can't
edit the invoice after"), [Void] (POST /invoices/:id/void — pre-PAID only, confirm dialog; guard
it). Validation matches the DTO constraints, loading, error (incl. 409) states. On send, surface
the resulting protected pay link from `payLinkId` (CopyButton + share-to WhatsApp/Instagram/
Telegram) and a link to the minted transaction. Responsive + dark mode.
```

---

## PROMPT 24B — Public Invoice View (`/invoice/[publicViewId]`) — phase 1

```
Build `/invoice/[publicViewId]` (public, no auth) — the buyer-facing read-only invoice a seller
shares. GET /public/invoices/:publicViewId (allow-listed PublicInvoiceView — no internal ids).
Render a premium, Meduman-branded glass invoice document: header with seller name (sellerName)
+ trust badge link (→ /s/[sellerBadgeSlug] when present), invoice `number`, status pill, issue
+ due dates, buyer name; a clean line-items table (title, description, qty, unitPrice, lineTotal
— all MoneyText kobo→₦); subtotal, taxAmount (labeled with the VAT %), and total; notes + terms.
Primary action depends on state: if `payLinkId` is present and unpaid, a big [Pay securely] →
routes to /pay/[payLinkId] (the protected pay flow); if status is PAID show an emerald "Paid &
protected" state; VOID → a muted "This invoice was voided" state; no payLinkId yet → "Awaiting
the seller to send." Print/download-friendly (clean print stylesheet). Reassurance strip: "Paying
this invoice protects your money with Meduman until you confirm delivery." 404 for unknown id.
Responsive + dark mode.
```

---

## PROMPT 25 — Admin Dashboard (`/admin`)

```
Build `/admin` (role ADMIN only — guard the route; non-admins get redirected). Operations
console. Top: stat tiles — protected volume held, transactions by state, open disputes, failed
payouts needing action. Below: two panels — "Open disputes queue" (GET /admin/disputes) and
"Transactions needing attention" (GET /admin/transactions, filterable by status). Each row →
/admin/transactions/[id]. Denser, more utilitarian than the consumer app but same glass system,
slightly more information per row. Loading, empty, error. Responsive + dark mode.
```

---

## PROMPT 26 — Admin Transaction Detail + Audit (`/admin/transactions/[id]`)

```
Build `/admin/transactions/[id]` (ADMIN). Full read of a transaction with operator powers:
- Everything from the consumer detail view (status, amount, parties, timeline, payouts).
- Audit tab: GET /admin/transactions/:id/audit — render the immutable audit log as a dense
  glass table (actor, timestamp, old state → new state, reason). Read-only, monospace refs.
- Dispute resolution: when a dispute is OPEN, admin actions [Resolve → Release] and
  [Resolve → Refund] (call the resolve endpoint), each behind a confirmation dialog with a
  required reason (goes to the audit log). Resolving to release enqueues payout.
- Payout recovery: if a payout is FAILED/REVERSED, show [Retry payout] → POST
  /admin/transactions/:id/payout/retry, behind a confirm dialog explaining it verifies the prior
  reference at Paystack before re-sending (never double-pays). Show clear success/failure.
These are sensitive irreversible-ish actions — every one requires explicit confirmation and a
reason, and shows the resulting audit entry. Loading, error (incl. 409) states. Responsive +
dark mode.
```

---

## PROMPT 27 — Admin Disputes Queue (`/admin/disputes`)

```
Build `/admin/disputes` (ADMIN). GET /admin/disputes. A triage queue: filterable by status
(OPEN first), each glass row = tx ref, parties, reason category, amount at stake, age (highlight
aging OPEN disputes in amber/rose), evidence count → /admin/transactions/[id] for resolution.
Bulk-free, single-focus workflow. Show "release is frozen" context on OPEN rows. Loading, empty
("No open disputes"), error. Responsive + dark mode.
```

---

## PROMPT 28 — Global states: 404, error boundary, offline, loading (`app` + `not-found`)

```
Build the global system states so nothing ever looks broken:
- not-found.tsx (404): glass card, shield-with-question illustration, "This page drifted out of
  protection." + [Back home] / [Go to dashboard].
- error.tsx (App Router error boundary): friendly "Something went wrong on our end" + [Try
  again] (reset) + a support link; never expose stack traces.
- A global loading.tsx with the branded skeleton/shimmer.
- An offline / API-unreachable banner (glass, top) when fetches fail network-wide, with retry.
- A reusable <EmptyState> and <ErrorState> already used across pages — finalize them here.
All match the design language, responsive + dark mode + reduced-motion.
```

---

## Build order (recommended)

1. PROMPT 0 (system) → 12 (app shell) → shared primitives.
2. Public/marketing: 1–10.
3. Auth: 11.
4. Core app: 13 → 15 → 14 → 16 → 17 → 18 → 19 → 20 → 21 → 22.
5. Invoicing: 23 → 24 → 24B. (Backend routes not live yet — build behind a mockable data layer.)
6. Admin: 25 → 26 → 27.
7. Global states: 28.

## Non-negotiable guardrails (repeat in every prompt if the model drifts)

- Server owns all money and status — the client never computes or asserts a transaction status.
- Money is integer **kobo**; format to ₦ only for display; convert naira→kobo before sending.
- Payment is confirmed by the **server webhook**, never a client callback — pay pages show a
  "verifying" state after redirect.
- OTP codes are **out-of-band** — never rendered in the UI or in any API response body.
- Evidence lives in a **private bucket** — always fetch a short-lived signed URL to view.
- Admin resolve/retry are **confirmation-gated** and write an audit row.
- Every async surface: loading + empty + error. Every screen: responsive + dark mode + AA + motion.
```
