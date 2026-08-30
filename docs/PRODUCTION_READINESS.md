# Production-readiness checklist — Meduman Backend

Status as of 2026-08-01. Grounded in the current tree, not aspirational.

**Where we are:** all domain modules are implemented and unit-tested (30 suites /
226 tests green; lint + build clean), and the whole spine has now **run against a
real Postgres and Redis** — `docker-compose.yml` brings both up locally. All five
migrations apply cleanly to an empty database, the app boots, `/health/ready`
returns `{"status":"ready","db":true,"redis":true}`, and a protected route still
401s without a token. The money-safety e2e suite (12 specs) passes against that
database: seller creates → publishes → buyer pays → server-verify/webhook
protects → seller delivers → buyer confirms (in-app OR OTP; or cron
auto-confirms) → release enqueued → worker sends the Paystack transfer →
`transfer.success` webhook completes. Disputes freeze release; admin resolution
unfreezes or refunds. Payout disbursement is **automated** (decision D-0 in §7).

**What is NOT proven:** nothing has touched **Supabase** or **Paystack** — no
migration has been applied to the hosted database, no real JWT has been verified
(the e2e auth guard is faked), and no transfer has ever been sent to Paystack,
not even in test mode. Render has never deployed this. Those are §0.

Legend: `[ ]` todo · `[~]` partial · `[x]` done. Ordered by blocking priority.

---

## 0. Blockers — cannot process a single real transaction without these

- [x] **Migrations apply to a real Postgres.** All five (`init`,
      `notification_read_at`, `drop_split_fee_model`, `seller_transfer_recipient`,
      `payout_transfer_reference`) applied clean to an empty DB via
      `npm run db:migrate:test` against the docker-compose Postgres. The SQL is no
      longer unproven — but it has still only run locally.
- [x] **App boots against real Postgres + Redis.** `/health` 200, `/health/ready`
      `{"status":"ready","db":true,"redis":true}`, unauthenticated `/users/me` 401.
      DI wiring and both connections are proven. *(Local docker, not Supabase.)*
- [ ] **Apply the migrations to the hosted Supabase DB.** Same command against
      `DIRECT_URL`, then confirm the pooled runtime client (`DATABASE_URL`)
      connects. *(Human-only: needs live credentials.)*
- [ ] **Verify a real Supabase JWT end-to-end.** Every automated test fakes the
      auth guard, so JWKS/HS256 verification, issuer and audience have never been
      exercised against a token Supabase actually issued. *(Human-only.)*
- [ ] **Send one Paystack test-mode transfer.** The transfer path is unit- and
      e2e-tested against a fake. Before launch, run one real test-mode release
      end-to-end and confirm **Transfers OTP is disabled** on the account —
      with it on, `/transfer` returns `status: otp` and automated release stalls.
      *(Human-only: needs test keys + a funded test balance.)*
- [x] **`users/`** — mirror upsert from verified JWT (`syncFromClaims`,
      `GET /users/me`). *(Seller subaccount CRUD still deferred — see §7.)*
- [x] **`payments/`** — collection init + **server-side verify**; amount-mismatch
      hard stop; idempotent verify. Client callback can never protect (Rule 2).
- [x] **`webhooks/`** — signed receiver (HMAC-SHA512 over raw body), `WebhookEvent`
      dedupe (Rule 4), routes `charge.success` → protect and `transfer.success` →
      payout completion.
- [x] **`transactions/` controller** — create draft + seller lifecycle (publish,
      start-delivery, mark-delivered) + buyer confirm (enqueues release) + read,
      all with ownership checks.
- [x] **`payouts/`** — idempotent release authorization (`release:<txId>` unique
      key) from `RELEASE_PROCESSING` only; idempotent `markPaid` completion (Rules
      3 & 4). *(Automated transfer initiation deferred — manual payout mode, §7.)*
- [x] **`disputes/`** — raise (drives DISPUTED) + admin resolve (release/refund),
      excludes the resolved dispute when deciding release; enqueues on release.
- [x] **`audit/`** — append-only `AuditService` (transaction-aware writer).
- [x] **`storage/`** — Supabase signed upload/download URLs, private bucket,
      server-generated traversal-safe paths.
- [x] **`queue/`** — BullMQ payout queue + shared Redis connection; `QueueService`
      enqueue with deterministic jobId dedupe; `worker.ts` runs the processor;
      graceful shutdown.
- [x] **Cron scan** — `AutoReleaseService.scanAndRelease` finds AUTO_AFTER_WINDOW
      transactions past their window (no open dispute) and enqueues release;
      `cron.ts` wired.

**e2e specs — `test/money-safety.e2e-spec.ts`** (harness in `test/utils/`). They
run the real app + state machine + Prisma writes against a REAL Postgres, faking
only external seams (Paystack — real HMAC, no network; auth guard; Redis/queue).
Only Postgres is needed. **12 specs, all passing.** They **skip** unless
`DATABASE_URL` is set, so unconfigured CI stays green. To run:

```bash
npm run db:up && npm run db:migrate:test && npm run test:e2e
```

- [x] End-to-end per lifecycle path: pay → protect → deliver → confirm → release;
      and the auto-confirm-after-window path.
- [x] Idempotency: replay the same webhook / retry the same payout job → **no
      double release**, and exactly one Paystack transfer sent (Rule 4).
- [x] Dispute-freeze: open a dispute mid-flight → confirmation into
      `RELEASE_PROCESSING` refused (409), no payout (Rule 5).
- [x] Signature: reject a webhook with a bad HMAC (401, nothing recorded) + a
      replayed `providerEventId` deduped (Rules 2/4).
- [x] Audit-completeness: a full lifecycle writes ≥5 `AuditLog` status-change rows
      (Rule 6).
- [x] Money values stay integer kobo end-to-end (payment + payout amounts).
- [x] Transfer automation: only the signed `transfer.success` webhook completes a
      transaction; a seller with no payout destination never has funds moved; a
      `transfer.failed` webhook records the failure and completes nothing.

## 2. Security hardening

- [x] **Rate limiting** — `@nestjs/throttler` global guard (100 req/60s per IP);
      webhooks `@SkipThrottle`; tighter per-route limits on OTP request (3/min) +
      confirm (10/min). *(Tune payment-init later.)*
- [x] **Security headers** — `helmet()` wired in `main.ts`.
- [x] **OTP hardening** — `otp/` module: keyed HMAC hash-at-rest (never
      plaintext), attempt cap (`OTP_MAX_ATTEMPTS`), single-use (`consumedAt`),
      expiry (`OTP_TTL_SECONDS`), constant-time compare, generic (no-oracle)
      client errors. 26 unit tests. *(Delivery channel now built — §7.)*
- [x] **Webhook replay window** — signed-but-stale events (payload timestamp older
      than `WEBHOOK_MAX_AGE_SECONDS`, default 24h) accepted 200 but not processed,
      on top of the `providerEventId` unique guard.
- [ ] **CORS** — `main.ts` already reads `FRONTEND_ORIGIN` allowlist (`[~]` in
      place). Confirm the production origins list is exact, no wildcards.
- [~] **Secrets** — `render.yaml` uses `sync: false` for all secrets (`[x]`). Pino
      logger redacts auth/cookie/paystack-sig headers + OTP `code`/`codeHash`.
      Still confirm no other PII/Paystack keys leak in custom log lines.
- [ ] **Auth** — guards are global secure-by-default (`[x]`). Audit every
      `@Public()` route before launch. **Note the `/v1` EaaS controllers are
      `@Public()` on purpose** — that only steps the Supabase JWT guard aside;
      `ApiKeyGuard` is their real gate.
- [ ] **New env var `EAAS_API_KEY_SECRET`** (zod-required, min 16 chars) — keys
      the HMAC-SHA256 hash-at-rest of every merchant API key. Must be set in
      Render (`sync: false`) before deploy, and **rotating it invalidates every
      issued key**, so treat rotation as a re-issue exercise for all merchants.
- [ ] **Outbound webhook SSRF hardening** — `EAAS_WEBHOOK_SIGNING_KEY` (zod-required,
      min 32 chars) keys the event signature HMAC. Webhook endpoint registration
      enforces SSRF: blocks private IPs, loopback, link-local, metadata addresses;
      requires https for live (`livemodeEnabled=true`), http for test. **This guard
      is static (literal-IP); DNS-rebind hardening (resolve-and-pin at send) +
      blocking 0.0.0.0 / IPv4-mapped IPv6 are follow-ups before external merchants
      point live URLs at us.** Both must be set in Render (`sync: false`).

## 3. Observability & ops

- [x] **Structured JSON logging** — `nestjs-pino` wired as the app logger in
      main/worker/cron (`observability/logger.config.ts`): LOG_LEVEL-driven, secret
      redaction, request correlation ids. *(App now boots for real; redaction
      itself is unit-tested, not observed in a live log stream.)*
- [x] **Error tracking** — conditional Sentry (`observability/sentry.ts`,
      `initSentry`) on API/worker/cron; no-op without `SENTRY_DSN`. *(Wired, not
      runtime-verified.)*
- [x] **Readiness probe** — `GET /health/ready` pings Postgres + Redis and returns
      503 if either is down (`/health` stays liveness-only). Both `@SkipThrottle`.
- [~] **Queue observability** — retry/backoff policy done (payout 5×, notification
      3×, exponential; `removeOnFail` retains dead jobs). Still todo: failed-job
      **alerting** + dead-letter drain (needs monitoring infra).
- [ ] **Metrics/alerting** — payout failure rate, webhook error rate, stuck
      transactions, queue depth. Alert on release failures.
- [ ] **Paystack reconciliation job** — daily sweep comparing our ledger to
      Paystack settlements; flag drift.

## 4. Data & migrations

- [~] Migration workflow proven **locally** (`npm run db:migrate:test` → clean
      apply on an empty DB) and gated in `render.yaml` via `preDeployCommand`
      using `DIRECT_URL`, with runtime on pooled `DATABASE_URL` (don't swap them).
      Still unproven against Supabase + pgbouncer.
- [ ] Seed (`prisma/seed.ts`) is dev-only — ensure it never runs against prod.
- [ ] Backups / PITR confirmed on the Supabase project; document restore steps.
- [ ] Index review for hot queries (status scans, `releaseAfter` cron scan,
      idempotency-key lookups).

## 5. Release engineering & CI/CD

- [x] **CI pipeline** — `.github/workflows/ci.yml` runs `npm ci` → prisma generate
      → lint → build → unit tests → **money-safety e2e** against a throwaway
      Postgres service on push/PR to `main`. *(Never executed on GitHub — this
      repo has no remote yet.)*
- [x] **Migration gate** — `render.yaml` runs `prisma migrate deploy` as the API
      service's `preDeployCommand`, so it happens once per deploy before traffic
      shifts, never from a `startCommand` where three services would race.
      *(Blueprint edited, never applied — Render has not deployed this repo.)*
- [ ] **Staging environment** on Render mirroring prod (separate Supabase project,
      Paystack **test** keys) for release smoke tests.
- [ ] **Rollback plan** documented (revert deploy + migration-down strategy).
- [ ] **Load test** the payment-init and webhook paths at expected peak.
- [ ] **Runbook** for common incidents: stuck payout, webhook backlog, DB failover.

## 6. Compliance / business

- [ ] Legal review of fund-holding flow (Meduman holds buyer funds pre-release) —
      confirm Paystack subaccount / settlement model is licensed correctly for NG.
- [ ] **EaaS multi-tenant custody (blocker before any external merchant goes
      livemode).** Slice 1 lets a third-party merchant orchestrate escrow over
      `/v1`, but custody stays with the platform: we hold *their* buyers' funds on
      *their* sellers' behalf. That multiplies the NG licensing question in §6
      above — it is no longer only our own transactions being held. Legal sign-off
      on holding third-party-originated funds (and on the merchant contract that
      assigns liability for disputes and chargebacks) is required before an admin
      flips `livemodeEnabled` for a real external merchant. `sk_test` keys and the
      `livemodeEnabled=false` default are the technical hold that enforces this.
- [ ] Data-retention & PII policy for evidence uploads and audit logs.
- [ ] Terms/dispute-resolution SLA encoded (auto-release window is currently
      `AUTO_RELEASE_WINDOW_HOURS=72` default).

## 7. Design decisions

### Decision records

**D-0 — Automated payout initiation. Decided 2026-08-01 (owner): automate.**
Payouts move from *manual payout mode* to automated Paystack transfers. On
release the worker calls `POST /transfer` with `reference = release:<txId>`;
the existing signed `transfer.success` webhook completes the payout. Requires
seller transfer-recipient onboarding (`providerRecipientCode`, additive
migration) and `transfer.failed` / `transfer.reversed` handling. **Paystack
"Transfers OTP" must stay DISABLED** on the live account — with it enabled
`/transfer` returns `status: otp` and needs an out-of-band code, which breaks
unattended release. Verify this setting before go-live and after any Paystack
account change.

**D-1 — Auto-release window: kept, opt-in, not the default. Decided 2026-08-01
(Claude, owner deferred).** "Release when both sides agree" is the default:
`ReleaseRule.BUYER_CONFIRMATION` (seller marks delivered **+** buyer confirms
in-app or by OTP). `AUTO_AFTER_WINDOW` stays in the enum as a per-transaction
opt-in fallback; the cron scan is unchanged and an open dispute still freezes it
(Rule 5). *Why:* with no fallback, a buyer who simply stops responding strands
the seller's funds indefinitely and every such case becomes manual support work;
silence-as-consent after a stated window is standard escrow practice. *Product
follow-up:* the pay page must show the buyer the auto-release deadline before
they pay, otherwise the fallback is not defensible in a dispute.

**D-2 — Paystack subaccounts: dormant and structurally disabled. Decided
2026-08-01 (Claude, owner deferred).** With real transfers, split settlement is
redundant and actively dangerous: a `subaccount` attached at charge time settles
the seller's share directly and the platform never holds the funds — which
defeats the entire product. So `subaccount` is removed from the charge-init
input type, making it impossible to attach at collection. The
`SellerProfile.paystackSubaccountCode` column and `PaystackService.createSubaccount`
stay in place but dormant, and `POST /users/me/seller/subaccount` is marked
deprecated. A unit test asserts the charge-init payload never carries a
`subaccount` key. *Cleanup later:* drop the column and endpoint once no
environment references them.

**D-3 — `SPLIT` fee model dropped. Decided 2026-08-01 (owner).** `FeeModel` is
now `BUYER_PAYS | SELLER_PAYS` only. *Why:* the implementation was
revenue-losing and inconsistent — the charge side never added the buyer's half
(`chargeAmount = amount` for SPLIT) while the settle side deducted only
`floor(feeAmount/2)` from the seller, so the platform silently collected about
half the fee it had booked. Rather than fix the rounding contract, the model is
removed: two models with unambiguous math beat three with a rounding rule nobody
can recite. Requires an enum-narrowing migration plus DTO/seed cleanup.

### Still open

- [~] **OTP release step-up** — issue/verify **built** (`otp/`) and delivery
      **built** (`notifications/`): `issue()` enqueues a `notification` job that
      sends the code via the pluggable `NOTIFICATION_SENDER`. Remaining is only the
      **real transport** — the default `LogNotificationSender` is a stub; bind a
      Termii/Twilio/WhatsApp implementation before launch. In-app `POST /:id/confirm`
      (no OTP) still exists as the alternative path.
- [ ] **Seller transfer-recipient onboarding UX** — bank picker + account-name
      confirmation on the frontend, backed by `GET /banks` and the resolve step.

---

### Remaining path to launch

The code spine is complete, and rules 1–6 are now proven end-to-end against a
real database — not just unit-tested. Every remaining blocker is a **credential
or an account setting**, not code:

1. **Supabase** — apply the migrations to the hosted DB; verify one real JWT.
2. **Paystack** — confirm **Transfers OTP is disabled**, then run one test-mode
   release end-to-end (§0). Nothing has ever been sent to Paystack.
3. **A real OTP transport** — bind `NOTIFICATION_SENDER` to an SMS/WhatsApp
   provider; today buyer codes only reach a log line (§7).
4. **Render** — apply the blueprint, set the `meduman-shared` env group, deploy
   API + worker + cron; smoke-test on staging with test keys (§5).
5. **Compliance** — the fund-holding model still needs legal sign-off (§6). This
   is the only item that can invalidate the design rather than delay it.

Sequence matters: do 1 and 2 before 4, because a deploy without a verified JWT
path or a working transfer is a deploy that cannot complete a transaction.
