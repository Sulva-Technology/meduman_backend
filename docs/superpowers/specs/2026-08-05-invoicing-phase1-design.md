# Invoicing — Phase 1 Design (Escrow-only Invoice Core)

**Date:** 2026-08-05
**Status:** Approved design — ready for implementation plan
**Author:** brainstorm session

---

## Context

Meduman is a transaction-protection (escrow) backend. A `Transaction` already
carries a single `amount`, a shareable `publicLinkId` pay link, and
`TransactionItem[]` rows — but those items carry **no price**; all money lives in
the transaction's single `amount`. There is no invoice number, due date, tax, or
itemized billing document today.

This spec covers **Phase 1 of invoicing only**: itemized, formal invoices that,
when paid, fund a **protected (escrow) Transaction** using the existing state
machine. No new money path is introduced.

Out of scope (own later specs):

- **Phase 2** — direct (non-escrow) payment mode + per-invoice "protected vs
  direct" toggle. This is a genuinely new money path and gets its own
  money-safety review.
- **Phase 3** — recurring / batch billing (schedules, subscriptions, bulk send).

---

## Guiding constraints (from CLAUDE.md — non-negotiable)

- The six money-safety rules stand. Phase 1 introduces **no new money path** —
  invoice payment flows through the existing collection → verify → protect →
  release machinery unchanged.
- Server is the sole owner of all money math and of the PAID state (rule 1). The
  client never sends totals or sets an invoice to PAID.
- Money is integer minor units (kobo). Never floats.
- One domain per module. New module `src/modules/invoices/`, wired into
  `app.module.ts`.
- **No frontend / React / SSR / PDF rendering in this backend.** The backend owns
  the invoice number and a structured JSON projection; the Next.js frontend
  renders and prints the document.
- Every send / void / remind writes an immutable AuditLog row (rule 6).

---

## Core model: Invoice is a front-end onto one Transaction

An `Invoice` is a **richer front-end onto exactly one `Transaction`**
(`Invoice 1—1 Transaction`, nullable until the invoice is sent).

- While the invoice is `DRAFT`, no Transaction exists yet — the seller is still
  editing lines, dates, and tax.
- On **send**, the backend creates a Transaction (driven `DRAFT → LINK_ACTIVE`
  through the existing state machine — never a direct status write), sets its
  `amount` to the invoice's server-computed `total`, and mints the pay link via
  the existing `publicLinkId`.
- The buyer pays through the existing hosted-checkout / DVA path. Payment status
  changes only via a signed webhook or server-side verify (rule 2). Funds are
  held in escrow exactly as today.
- `Invoice.status = PAID` is **derived** — set only in response to the linked
  Transaction reaching `PAYMENT_PROTECTED`, never from a client call (rule 1).

This keeps the state machine the sole owner of `TransactionStatus`, and keeps the
invoice's own lifecycle a separate concern that never leaks into transaction
state.

---

## Data model

New Prisma models + one enum. Additive migration; no change to existing money
tables.

```prisma
enum InvoiceStatus {
  DRAFT    // seller building it; no Transaction yet
  SENT     // Transaction + pay link minted, delivered to buyer contact
  VIEWED   // buyer opened the public view
  PAID     // linked Transaction reached PAYMENT_PROTECTED (derived)
  OVERDUE  // dueDate passed, not yet PAID (cron-set)
  VOID     // seller cancelled (pre-PAID only)
}

model Invoice {
  id            String        @id @default(uuid()) @db.Uuid
  sellerId      String        @db.Uuid
  seller        User          @relation("SellerInvoices", fields: [sellerId], references: [id])

  /// Seller-sequential human number, e.g. "INV-0001". Unique per seller.
  number        String

  /// Buyer contact captured at draft time. buyerId is filled once the buyer
  /// pays and an auth user is known (mirrors Transaction.buyerId).
  buyerId       String?       @db.Uuid
  buyer         User?         @relation("BuyerInvoices", fields: [buyerId], references: [id])
  buyerName     String?
  buyerEmail    String?
  buyerPhone    String?

  status        InvoiceStatus @default(DRAFT)
  issueDate     DateTime      @default(now())
  dueDate       DateTime?

  currency      String        @default("NGN")
  /// All money = minor units (kobo), server-computed, never client-supplied.
  subtotal      Int           @default(0)
  taxRatePctBp  Int?          // basis points; 750 = 7.5% VAT. null = no tax.
  taxAmount     Int           @default(0)
  total         Int           @default(0)

  notes         String?
  terms         String?

  /// Null until sent. One Transaction per invoice.
  transactionId String?       @unique @db.Uuid
  transaction   Transaction?  @relation(fields: [transactionId], references: [id])

  /// Unguessable public identifier for the buyer-facing read-only view.
  publicViewId  String        @unique

  sentAt        DateTime?
  viewedAt      DateTime?
  paidAt        DateTime?
  voidedAt      DateTime?
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt

  lineItems     InvoiceLineItem[]

  @@unique([sellerId, number])
  @@index([sellerId, status])
  @@index([status, dueDate])   // overdue scan
  @@map("invoices")
}

model InvoiceLineItem {
  id          String   @id @default(uuid()) @db.Uuid
  invoiceId   String   @db.Uuid
  invoice     Invoice  @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  title       String
  description String?
  quantity    Int      @default(1)
  unitPrice   Int      // kobo
  lineTotal   Int      // kobo, server-computed = unitPrice * quantity
  position    Int      @default(0) // display order
  createdAt   DateTime @default(now())

  @@index([invoiceId])
  @@map("invoice_line_items")
}

/// Per-seller atomic invoice-number sequence.
model InvoiceCounter {
  sellerId String @id @db.Uuid
  nextSeq  Int    @default(1)

  @@map("invoice_counters")
}
```

Back-reference added to existing models:

- `User` — `invoicesAsSeller Invoice[] @relation("SellerInvoices")`,
  `invoicesAsBuyer Invoice[] @relation("BuyerInvoices")`.
- `Transaction` — `invoice Invoice?` (the inverse of `Invoice.transaction`).

---

## Money math (server sole owner)

Computed server-side on every draft create/edit and frozen at send:

```
lineTotal = unitPrice * quantity          // per line
subtotal  = Σ lineTotal
taxAmount = taxRatePctBp == null ? 0 : round(subtotal * taxRatePctBp / 10000)
total     = subtotal + taxAmount
```

- All values are integer kobo. Rounding uses integer math (round half up on the
  single division).
- The client sends **line inputs only** (`title`, `quantity`, `unitPrice`,
  optional `taxRatePctBp`). It never sends `lineTotal`, `subtotal`, `taxAmount`,
  or `total`; any such field in the request body is ignored (rule 1).
- `total` must be `> 0` to send. Empty / zero-total invoices cannot be sent.

---

## Lifecycle & guards

```
DRAFT ──edit──► DRAFT
DRAFT ──send──► SENT ──(buyer opens)──► VIEWED
SENT|VIEWED ──(tx → PAYMENT_PROTECTED)──► PAID
SENT|VIEWED ──(cron, dueDate passed)──► OVERDUE ──(tx → PAYMENT_PROTECTED)──► PAID
DRAFT|SENT|VIEWED|OVERDUE ──void──► VOID   (pre-PAID only)
```

- **Edit** allowed only in `DRAFT`. Once sent, the invoice (and its total, which
  is now a Transaction amount) is frozen.
- **Send** allowed only from `DRAFT`, only when `total > 0`. Idempotent: a second
  send on an already-sent invoice is a no-op returning the existing link (no
  second Transaction, no double delivery).
- **Void** allowed only pre-PAID. Voiding also cancels the linked Transaction
  (existing `CANCEL` transition, valid only in `DRAFT`/`LINK_ACTIVE` — a paid or
  in-delivery invoice cannot be voided).
- **PAID** is only ever set by the derivation hook (below), never by an endpoint.
- **OVERDUE** is a soft, reversible display state; it does not block payment. If a
  buyer pays an overdue invoice it still moves to PAID.

### PAID derivation hook

When a Transaction reaches `PAYMENT_PROTECTED`, if it has a linked invoice, that
invoice is moved `SENT|VIEWED|OVERDUE → PAID` (`paidAt` stamped). Implemented by
having the invoice module observe the same signal that already drives the
transaction into `PAYMENT_PROTECTED` (the payments/webhooks protect path). No new
trust in client input; the trigger is the same signed-webhook / server-verify
event that already owns rule 2.

---

## Delivery

Reuse the existing `notifications` BullMQ queue and the pluggable sender seam.
On send, enqueue an invoice-delivery job carrying the public view URL and the
non-secret invoice metadata (number, total, due date, seller name). New template
for the invoice message. Channel follows the buyer contact captured on the
invoice (email / chat); reuse whatever transport is configured. Reminders
(`/remind`) re-enqueue the same delivery, throttled.

---

## HTTP surface

All seller routes are ownership-checked (invoice.sellerId == caller). Admin reads
via `@Roles('ADMIN')`. Public view is unauthenticated but keyed on the
unguessable `publicViewId` and returns an allow-listed lean projection only.

```
POST   /invoices                       create draft (seller) — lines, dates, tax
PATCH  /invoices/:id                   edit draft only
POST   /invoices/:id/send              mint tx + link, deliver, DRAFT → SENT
POST   /invoices/:id/void              pre-PAID only; cancels linked tx
POST   /invoices/:id/remind            re-deliver (throttled)
GET    /invoices                       seller list, cursor, role-scoped
GET    /invoices/:id                   owner / admin
GET    /public/invoices/:publicViewId  public read-only view; marks VIEWED
```

**Public projection** (allow-list, never leaks internal ids / seller PII beyond
what belongs on an invoice): number, issueDate, dueDate, currency, line items
(title, qty, unitPrice, lineTotal), subtotal, taxAmount, total, seller display
name / badge, status, and the pay link (`publicLinkId`) once sent. Never the
`transactionId`, `sellerId`, buyer auth id, or any payout/idempotency field.

---

## Audit (rule 6)

`send`, `void`, and `remind` each write an AuditLog row (actor, timestamp, old
state, new state, reason). The PAID derivation also writes one (actor = system).

---

## Migration

Single additive migration:

- Create `invoices`, `invoice_line_items`, `invoice_counters` tables.
- Create `InvoiceStatus` enum.
- Add `Transaction.invoiceId` inverse relation (no column change on
  `transactions` — the FK lives on `invoices.transactionId`).

No change to any existing money table. Follows the existing offline
`migrate diff` authoring convention; applied to the local test DB before e2e.

---

## Testing

Unit:

- Money math: `lineTotal`/`subtotal`/`taxAmount`/`total` correctness, kobo
  integer rounding, multi-line sums.
- Client cannot set totals: totals in the request body are ignored; server
  recompute wins.
- Lifecycle guards: edit rejected when not DRAFT; send rejected when total == 0;
  send is idempotent (no second Transaction); void rejected once PAID.
- PAID derivation: reaching `PAYMENT_PROTECTED` flips the linked invoice to PAID
  and only then.
- Public-view non-leak: projection excludes `transactionId`, `sellerId`, buyer
  auth id, payout/idempotency fields.
- Number allocation: per-seller sequence is atomic (no duplicate `number` under
  concurrent send).

E2e (money-safety, real Postgres): sending an invoice mints exactly one
Transaction and one pay link; paying it protects funds via the normal path; the
invoice cannot be marked PAID by any client call; voiding a sent-but-unpaid
invoice cancels its Transaction.

---

## Open decisions — resolved

1. **Invoice number** — seller-sequential `INV-<zero-padded seq>` via
   `InvoiceCounter`, unique per seller. ✅
2. **Tax** — single rate `taxRatePctBp` (basis points) + computed `taxAmount`.
   Multi-tax deferred. ✅
3. **PDF** — frontend renders; backend serves structured JSON + owns the number.
   No PDF library in this backend. ✅
```
