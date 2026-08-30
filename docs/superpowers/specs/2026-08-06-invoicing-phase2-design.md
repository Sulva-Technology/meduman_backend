# Invoicing — Phase 2 Design (Direct / Non-Escrow Invoice Mode)

**Date:** 2026-08-06
**Status:** Approved design — ready for implementation plan
**Depends on:** Phase 1 (`2026-08-05-invoicing-phase1-design.md`, shipped)

---

## Context

Phase 1 shipped itemized formal invoices that, when paid, fund a **protected
escrow Transaction** (`Invoice 1—1 Transaction`). Phase 2 adds a second, opt-in
payment mode: a **direct (non-escrow) invoice**, where the buyer's payment
settles **straight to the seller** with no hold, no confirm, no release.

This is a genuinely new money path. Meduman's six money-safety rules are *escrow*
rules; a direct invoice deliberately steps outside the hold/release model. The
design's central concern is therefore **isolation** — direct funds must be
completely unreachable by escrow release code — and **containment** — direct mode
is gated to vetted sellers so the loss of buyer protection has a bounded blast
radius.

Out of scope (own later specs / phases):

- **Direct refunds & disputes.** A direct payment has no held funds to freeze; a
  dispute becomes a manual admin-initiated Paystack refund. Deferred.
- **Chat / DVA direct.** Dedicated-virtual-account split settlement is its own
  wrinkle; Phase 2 is web hosted-checkout only.
- **Phase 3** — recurring / batch billing.

---

## Guiding constraints (from CLAUDE.md)

- **Isolation over reuse where funds are concerned.** Direct invoices never create
  or touch an escrow `Transaction` or the transaction state machine. Escrow
  release logic can never operate on direct money.
- The server owns the payment **mode** and the **PAID** state (rule 1). The client
  never sets either.
- Payment status changes only from a signature-verified webhook or a server-side
  verify (rule 2) — reused verbatim, not re-implemented.
- Money is integer minor units (kobo). Never floats.
- Every send / void / paid writes an immutable AuditLog row (rule 6).
- **Decision D-2 stays intact for escrow:** `initializeTransaction` must never
  attach a subaccount on the protected path. Phase 2 adds an *optional* subaccount
  parameter used **only** by the direct path.

---

## The toggle

`Invoice` gains one field:

```prisma
enum InvoicePaymentMode {
  PROTECTED // Phase 1: funds an escrow Transaction (default)
  DIRECT    // Phase 2: subaccount split-settles straight to the seller
}
```

- `Invoice.paymentMode InvoicePaymentMode @default(PROTECTED)`.
- Chosen at draft (create/edit, DRAFT-only, like every other invoice field),
  **frozen at send**. Server-owned; a client cannot flip a sent invoice's mode.
- `PROTECTED` behaviour is exactly Phase 1 — no change.

---

## Eligibility (send-time hard gates, DIRECT only)

When `send` is called on a `DIRECT` invoice, the server enforces **both** gates
before minting anything; failing either throws a typed `400`:

1. The seller's `SellerProfile.verificationStatus == VERIFIED`.
2. The seller has an active `SellerProfile.paystackSubaccountCode`.

A `PROTECTED` invoice has neither gate (unchanged). The frontend may disable the
direct toggle for ineligible sellers, but the server is the sole enforcer.

---

## Money path — subaccount split at collection

A `DIRECT` invoice **creates no Transaction**. Flow:

1. Buyer opens the public invoice view and chooses to pay.
2. `POST /public/invoices/:publicViewId/pay` (`@Public`) — server-side:
   - Guard: invoice is `DIRECT` and in a payable status (`SENT`/`VIEWED`/
     `OVERDUE`); else `409`.
   - Calls `PaystackService.initializeTransaction` with the seller's
     `subaccount` (their `paystackSubaccountCode`) and the platform percentage
     from `PAYSTACK_SUBACCOUNT_PERCENTAGE_CHARGE`, `amount = invoice.total`,
     `email = invoice.buyerEmail` (required for a direct invoice — enforced at
     send).
   - Creates a `Payment` row bound to the **invoice** (not a transaction),
     status `PENDING`, with our unique generated `providerReference` (the
     idempotency lock).
   - Returns `{ authorizationUrl, reference }`.
3. Buyer pays on Paystack. Paystack **split-settles**: the seller's share to
   their subaccount, the platform percentage to the platform. **Funds are never
   held by the platform.**
4. Settlement is confirmed by the signed `charge.success` webhook, or by a
   server-side verify on the return URL (rule 2).

The escrow init path is untouched: `initializeTransaction`'s new `subaccount`
argument is optional and only ever supplied here.

---

## Payment record — polymorphic (Payment belongs to a Transaction OR an Invoice)

Reuse the `Payment` model so the verify + exact-amount hard-stop + rule-2 logic
stays single-sourced. Schema change:

```prisma
model Payment {
  // ...existing fields...
  transactionId String?      @db.Uuid   // was required; now nullable
  transaction   Transaction? @relation(fields: [transactionId], references: [id])
  invoiceId     String?      @db.Uuid   // NEW — set for a direct invoice payment
  invoice       Invoice?     @relation(fields: [invoiceId], references: [id])
  // ...
}
```

- **DB CHECK constraint:** exactly one of `transactionId` / `invoiceId` is set
  (`num_nonnulls(transactionId, invoiceId) = 1`). Authored in the migration SQL.
- `providerReference` stays `@unique` — the idempotency lock for both paths.
- `Invoice` gains `payments Payment[]` (a direct invoice may have earlier
  PENDING/ABANDONED attempts plus at most one SUCCESS).

The webhook / verify receiver resolves the `Payment` by `providerReference`, then
**branches on which FK is set**:

- `transactionId` present → the existing escrow protect path (Phase 1),
  unchanged.
- `invoiceId` present → the new **direct settle** path (below).

This is the single branch point; no escrow code runs for a direct payment and no
direct code runs for an escrow payment.

---

## Direct settle + PAID derivation

On a signed `charge.success` (or server-verify) for an invoice-bound Payment:

1. Idempotency: if the Payment is already `SUCCESS`, no-op (but still re-run the
   PAID derivation so a prior partial failure heals — mirrors the Phase 1 fix).
2. Server-side verify at Paystack under `providerReference`.
3. **Exact amount-match hard stop:** `verified.amount == invoice.total`, else
   log + refuse (throw `AmountMismatchError`), Payment not marked SUCCESS.
4. `Payment → SUCCESS` (+ `verifiedAt`, raw payload).
5. `InvoicesService.markPaidDirect(invoiceId)` flips the invoice
   `SENT|VIEWED|OVERDUE → PAID` via a guarded `updateMany` (idempotent, never
   regresses VOID/PAID), stamps `paidAt`, writes an audit row (actor = system).

`markPaidDirect` is the DIRECT sibling of Phase 1's `markPaidByTransaction`. Both
are reachable **only** from the signed-webhook / server-verify settle path, never
from an HTTP request. A `PROTECTED` invoice is never touched by `markPaidDirect`
and a `DIRECT` invoice is never touched by `markPaidByTransaction` (the branch on
the Payment FK guarantees this).

---

## Lifecycle, void, public view

- **Status enum unchanged.** A DIRECT invoice moves
  `DRAFT → SENT → VIEWED → PAID → (OVERDUE) → VOID`, same as protected.
- **send (DIRECT):** after the eligibility gates, allocate the seller-sequential
  number, flip `DRAFT → SENT`, enqueue delivery — but **mint no Transaction**.
  `buyerEmail` is required at send for a DIRECT invoice (needed for the charge);
  missing → `400`.
- **void (DIRECT):** pre-PAID only. No Transaction to cancel — flip to `VOID`;
  best-effort mark any `PENDING` Payment for the invoice `ABANDONED`. Never voids
  a PAID invoice.
- **Public view:** projection adds `paymentMode` and a `payable` boolean
  (`status in SENT/VIEWED/OVERDUE`). For a DIRECT invoice `payLinkId` is `null`
  (no Transaction); the buyer pays via `POST /public/invoices/:publicViewId/pay`.
  For a PROTECTED invoice, `payLinkId` remains the Transaction's `publicLinkId`
  as in Phase 1. The projection still leaks no internal ids.

---

## Six money-safety rules — mapping for DIRECT

| Rule | Direct-mode status |
|------|--------------------|
| 1. Server owns state/amount | ✅ Server owns `paymentMode` (frozen at send) and PAID (derivation only). Totals server-computed (Phase 1). |
| 2. Payment status only from signed webhook / server-verify | ✅ Reused verbatim — the direct settle runs the same verify + amount-match. |
| 3. Funds release only on a valid release event | N/A — there is no release; Paystack split-settles at collection. |
| 4. Idempotent payout | Preserved analog: unique `providerReference` + the `SENT/VIEWED/OVERDUE` PAID guard make settle idempotent; a duplicate webhook can't double-mark. |
| 5. Open dispute freezes release | N/A — no held funds. **This is the deliberate tradeoff of direct mode, contained by the VERIFIED-seller gate.** |
| 6. Audit every transition/admin action | ✅ send / void / paid write AuditLog rows. |

---

## HTTP surface (delta from Phase 1)

- `POST /invoices` / `PATCH /invoices/:id` — accept optional `paymentMode`
  (DRAFT-only, defaults PROTECTED).
- `POST /invoices/:id/send` — enforces the DIRECT eligibility gates + required
  `buyerEmail`.
- `POST /public/invoices/:publicViewId/pay` — **new**, `@Public`. Inits the
  direct charge, returns `{ authorizationUrl, reference }`. Rejects non-DIRECT or
  non-payable invoices.
- Webhook receiver — gains the invoice-bound branch (resolve Payment → direct
  settle). No new route; the existing signed receiver dedupe + replay window
  still apply.

No new environment variables (reuses `PAYSTACK_SUBACCOUNT_PERCENTAGE_CHARGE`).

---

## Migration

Single additive migration:

- `InvoicePaymentMode` enum; `invoices.paymentMode` column (default `PROTECTED`).
- `payments.invoiceId` nullable column + FK to `invoices`.
- `payments.transactionId` made nullable.
- CHECK constraint `num_nonnulls("transactionId","invoiceId") = 1` on `payments`.
- Index on `payments.invoiceId`.

Existing rows: every current Payment has a `transactionId` and no `invoiceId`, so
the CHECK holds for all of them — safe to add.

---

## Testing

Unit:

- **Eligibility gate:** `send` on a DIRECT invoice refuses when the seller is
  unverified, and when the seller has no subaccount; passes when both hold.
- **Server owns mode:** a client cannot change `paymentMode` after send; a create
  with a bogus mode is validated by the DTO enum.
- **Direct pay init:** `POST .../pay` calls `initializeTransaction` **with the
  subaccount attached** and the invoice total; creates a Payment bound to the
  invoice (not a transaction) with our reference; rejects a PROTECTED or
  non-payable invoice.
- **Amount-match hard stop:** a mismatched verify amount refuses and does not mark
  the invoice PAID.
- **PAID only via settle:** `markPaidDirect` flips only on the signed settle path
  and only from `SENT/VIEWED/OVERDUE`; no endpoint sets PAID; idempotent.
- **Polymorphic Payment:** the exactly-one-of guard holds; the webhook branch
  routes an invoice-bound Payment to direct settle and a tx-bound Payment to
  escrow protect.
- **void (DIRECT):** flips VOID with no Transaction, abandons a pending Payment.

E2e (real Postgres, escrow/auth/Redis faked as today):

- A DIRECT invoice, when sent, mints **no Transaction** (zero transaction rows for
  it) yet is payable.
- Paying a DIRECT invoice (simulated signed settle) marks it PAID and records a
  SUCCESS Payment bound to the invoice; no escrow release path runs.
- The DIRECT eligibility gate blocks an unverified seller end-to-end.
- The CHECK constraint rejects a Payment with both/neither FK.

---

## Open decisions — resolved

1. **Direct money mechanism** — subaccount split at collection (Paystack settles
   the seller directly; platform never holds direct funds). ✅
2. **Relationship to the escrow Transaction** — fully separate; direct invoices
   never create or touch a Transaction. ✅
3. **Payment record** — reuse `Payment`, made polymorphic (`transactionId` OR
   `invoiceId`, exactly one), keeping verify/amount-match single-sourced. ✅
4. **Eligibility** — VERIFIED sellers with an active subaccount only. ✅
5. **Pay surface** — web hosted-checkout only; chat/DVA-direct deferred. ✅
6. **Refunds/disputes for direct** — out of scope Phase 2 (manual admin refund
   later). ✅
```
