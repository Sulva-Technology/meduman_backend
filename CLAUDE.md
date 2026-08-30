# CLAUDE.md — Meduman Backend

Memory for every session. Read this before writing code. Keep it current.

## What Meduman is

Transaction-protection platform for social commerce in Nigeria. Flow:

1. **Buyer pays** into a protected transaction state (funds held, not with seller).
2. **Seller delivers.**
3. **Buyer confirms** (OTP or in-app).
4. System **releases funds** to the seller.
5. **Disputes freeze** automated release.

This repo is the **standalone backend only**. The frontend is a separate
Next.js app on Vercel that consumes this API. **Never add frontend code, React,
or server-rendered pages here.**

---

## Six money-safety rules (verbatim — these override convenience everywhere)

1. The server is the sole owner of transaction state. Never trust a status or amount sent by the client.
2. Payment status changes only in response to a signature-verified Paystack webhook or a server-side Paystack verify call. Never from a client callback.
3. Funds never release without a valid release event that satisfies the transaction's release rule.
4. Every payout must be idempotent. A duplicate webhook or retried job must never cause a double release.
5. An open dispute freezes all automated release for that transaction.
6. Every state transition and every admin action writes an immutable audit log row (actor, timestamp, old state, new state, reason).

---

## Architecture constraints (non-negotiable)

- **NestJS + TypeScript**, strict mode. Modular — one module per domain service.
- **Prisma ORM** against Supabase-hosted Postgres. Two URLs:
  - `DATABASE_URL` → pooled (pgbouncer) → the **runtime** client.
  - `DIRECT_URL` → direct connection → **migrations only**.
- **Supabase Auth** issues JWTs. This backend **verifies** them (JWKS or HS256
  secret, config-driven via `SUPABASE_JWT_STRATEGY`). No password storage, no
  login endpoints here.
- **Supabase Storage** for evidence/proof uploads. Bucket is **private** — files
  are never publicly readable. Access via short-lived **signed URLs** this
  backend generates.
- **Paystack** for collection, subaccounts (manual payout mode), transfers, and
  webhooks.
- **BullMQ + Redis** for background jobs. Long-running or retryable work **never**
  happens inside an HTTP request.
- Deployed on **Render**: one web service (API), one background worker, one cron.

---

## Folder conventions

```
src/
  main.ts            # API web-service entrypoint (rawBody on for webhooks)
  worker.ts          # BullMQ worker entrypoint — no HTTP
  cron.ts            # cron entrypoint — runs once, enqueues, exits
  app.module.ts      # root wiring
  config/            # typed env schema (zod) + global ConfigModule (fail-fast)
  prisma/            # PrismaModule + PrismaService (pooled runtime client)
  common/            # shared guards, filters, interceptors, decorators
  modules/           # one folder per domain service:
    auth/            #   verify Supabase JWTs, @CurrentUser, role guard
    users/           #   user mirror + seller subaccounts
    transactions/    #   THE state machine (server owns TransactionStatus)
    payments/        #   Paystack collection + server-side verify
    payouts/         #   idempotent transfers (BullMQ), release execution
    webhooks/        #   Paystack signed-webhook receiver (raw-body HMAC)
    disputes/        #   raise/resolve; OPEN freezes release
    storage/         #   Supabase signed upload/download URLs
    audit/           #   append-only audit-log writer (AuditService)
    queue/           #   BullMQ registration + Redis connection
    health/          #   /health liveness
prisma/schema.prisma # two-URL datasource; enums are the ONLY legal states
test/                # e2e specs (*.e2e-spec.ts)
```

Each module: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/`, and
`*.spec.ts` colocated. Path alias `@/*` → `src/*`.

Money is stored as **integer minor units (kobo)** — never floats.

---

## Commands

| Task              | Command                       |
| ----------------- | ----------------------------- |
| Install           | `npm ci`                      |
| Dev (API, watch)  | `npm run dev`                 |
| Dev (worker)      | `npm run worker:dev`          |
| Dev (cron)        | `npm run cron:dev`            |
| Build             | `npm run build`               |
| Start API (prod)  | `npm run start`               |
| Start worker      | `npm run worker`              |
| Run cron once     | `npm run cron`                |
| Lint              | `npm run lint`                |
| Format            | `npm run format`              |
| Test (unit)       | `npm test`                    |
| Test (e2e)        | `npm run test:e2e`            |
| Generate client   | `npm run prisma:generate`     |
| Migrate (dev)     | `npm run prisma:migrate`      |
| Migrate (deploy)  | `npm run prisma:migrate:deploy` |

Migrations use `DIRECT_URL`. Runtime uses `DATABASE_URL`. Don't swap them.

---

## Before you write code — checklist

- [ ] Does this touch money or transaction state? If yes, re-read the six rules above.
- [ ] Is the state transition server-decided, not client-supplied? (Rule 1)
- [ ] If it marks a payment paid: does it come from a signed webhook or server-side verify — never a client callback? (Rule 2)
- [ ] If it releases funds: is there a valid release event satisfying the transaction's release rule? (Rule 3)
- [ ] Is the payout guarded by a unique idempotency key so a retry/dup webhook can't double-pay? (Rule 4)
- [ ] Does an open dispute block this path? (Rule 5)
- [ ] Does every transition/admin action write an audit-log row? (Rule 6)
- [ ] Is long/retryable work on a BullMQ queue, not in the HTTP request?
- [ ] Are money values integer minor units (kobo), never floats?
- [ ] New module? One domain per module, wired into `app.module.ts`.
- [ ] Verify before claiming done: `npm run lint && npm run build && npm test`.
- [ ] No frontend/React/SSR added.

---

## Status

- **Scaffold** — done. Strict TS, ESLint/Prettier, Jest, render.yaml.
- **Prisma schema** — done. Full domain: identity (User/Profile/SellerProfile/
  WaitlistEntry), transactions (Transaction/TransactionItem), money (Payment/
  Payout), disputes (Dispute/Evidence), OtpCode, TimelineEvent, append-only
  AuditLog, Notification, WebhookEvent (idempotency), AdminUser. Money = `Int`
  kobo everywhere. `TransactionStatus` = the exact 12-state lifecycle. Financial
  uniques: `providerReference`, `idempotencyKey`, `providerTransferCode`,
  `providerEventId`, `publicLinkId`, `badgeSlug`. Init migration authored at
  `prisma/migrations/20260713000000_init` (SQL generated offline via
  `migrate diff` — NOT yet applied to a DB). Seed at `prisma/seed.ts`
  (`npm run prisma:seed`): 2 users, 6 admins (one per role), 1 tx per lifecycle
  state. Actor ids on audit/timeline/dispute are polymorphic (user/admin/system)
  so intentionally NOT foreign-keyed.
- **auth/** — done. `verifySupabaseJwt` (HS256 + JWKS families), `SupabaseJwtService`
  (config-driven strategy), `SupabaseJwtGuard` + `RolesGuard` registered globally
  (secure-by-default; opt out with `@Public()`), `@CurrentUser()` / `@Roles()`
  decorators. 18 unit tests. DB user-sync deferred to `users/`.
- **transactions/state-machine/** — done. Pure, dependency-free core (no HTTP/
  Prisma-runtime/Paystack; enums pulled via `import type` only). `transition(from,
  event, context)` returns `{ok,nextState}` or `{ok:false,reason}` — typed
  `RejectionReason`, never a thrown string. Encodes all 12-state edges + 3 guards:
  client-sourced payment can never protect (only WEBHOOK/SERVER_VERIFY), open
  dispute freezes every path into RELEASE_PROCESSING, auto-confirm needs
  AUTO_AFTER_WINDOW rule + elapsed window + no dispute. 43 unit tests, 100% branch
  coverage. `TransactionsService.apply()` is the thin persistence wrapper: loads
  tx (+ open disputes), calls the machine, and on a permit writes status +
  TimelineEvent + AuditLog in ONE `$transaction` with an optimistic
  `updateMany(where status=from)` guard; on reject throws `TransitionRejectedError`
  (409) and writes nothing. 6 service tests.
- **users/** — done. `UsersService.syncFromClaims` upserts the local User mirror
  from verified JWT claims; `GET /users/me`. Seller subaccount CRUD deferred (see
  §7 of the readiness doc — needs Paystack recipient/subaccount onboarding call).
- **common/paystack/** — done. `PaystackService`: typed HTTP client (init/verify/
  transfer/subaccount) + HMAC-SHA512 webhook-signature verify. Single Paystack seam.
- **payments/** — done. `initializeCollection` drives BUYER_INITIATE_CHECKOUT +
  opens a Paystack charge; `verifyAndProtect` does server-side verify, amount-match
  hard stop, idempotent (SUCCESS = no-op), then drives PAYMENT_VERIFIED with a
  trusted source. Client callback can never protect (Rule 2).
- **webhooks/** — done. Signed receiver (raw-body HMAC), `WebhookEvent` dedupe
  (Rule 4); routes `charge.success` → protect, `transfer.success` → payout complete.
- **transactions/ controller** — done. Create draft (server-owned publicLinkId) +
  seller lifecycle (publish/start-delivery/mark-delivered) + buyer confirm
  (enqueues release) + participant/admin read, all ownership-checked.
- **payouts/** — done, **automated** (decision D-0). `executeRelease` authorizes one
  idempotent PENDING payout (`release:<txId>` unique) only from RELEASE_PROCESSING,
  re-checks for an open dispute, then sends the Paystack transfer to the seller's
  own `providerRecipientCode` using the idempotency key as the provider reference
  (two independent dedupe locks). `markPaid` completes it from the signed
  `transfer.success` webhook and drives PAYOUT_SUCCEEDED; `markFailed` records
  `transfer.failed`/`transfer.reversed` **without** completing anything — the
  transaction stays frozen in RELEASE_PROCESSING for an operator. A crash between
  send and persist is recovered via `verifyTransfer` (adopt, never re-pay). No
  recipient = no transfer (funds stay held). `retryTransfer` is the admin-only
  recovery path (`POST /admin/transactions/:id/payout/retry`): FAILED/REVERSED
  only, verifies the prior reference at Paystack first and completes from it if it
  actually succeeded, otherwise re-sends under a fresh reference
  (`release:<txId>:r<n>` — Paystack rejects a reused one). Every send/failure/retry
  writes an audit row (Rule 6).
- **disputes/** — done. Raise (→ DISPUTED) + admin resolve (release/refund),
  excluding the resolved dispute from the freeze check; enqueues release on the
  seller outcome.
- **audit/** — done. Append-only `AuditService` (transaction-aware writer, Rule 6).
- **storage/** — done. Supabase signed upload/download URLs, private bucket,
  server-generated traversal-safe paths.
- **queue/** — done. BullMQ payout queue + shared Redis connection; `QueueService`
  enqueue with deterministic jobId dedupe; `worker.ts` runs the processor;
  `cron.ts` → `AutoReleaseService.scanAndRelease` (auto-confirm past window).
- **otp/** — done. `OtpService` issues/verifies one-time codes for buyer delivery
  confirmation (release step-up): crypto-random numeric code, keyed HMAC-SHA256
  hash-at-rest (never plaintext), single-use (`consumedAt`), attempt-capped
  (`OTP_MAX_ATTEMPTS`), expiring (`OTP_TTL_SECONDS`), constant-time compared. Issue
  only in CONFIRMATION_PENDING; prior unconsumed codes invalidated. Verify is
  fail-closed + generic to the client (no oracle), precise reason in logs/audit
  (Rule 6). `OtpController`: `POST /transactions/:id/otp` (buyer requests, code
  delivered OUT-OF-BAND — never in the HTTP body) + `POST /:id/confirm-otp`
  (verify → drive BUYER_CONFIRM → enqueue release). New env: `OTP_HASH_SECRET`
  (required), `OTP_MAX_ATTEMPTS`. Pure crypto in `otp.crypto.ts`. 26 unit tests.
  Delivery channel (WhatsApp/SMS/bot) still a separate seam — see readiness §7.
- **notifications/** — done. Out-of-band OTP delivery: `NotificationsService`
  producer (`enqueueOtpCode`, runs in-request) + consumer (`deliverOtpCode`, runs
  in worker) over a new BullMQ `notification` queue. Pluggable transport seam
  (`NOTIFICATION_SENDER` token) — default `LogNotificationSender` stub (logs code
  in non-prod only, masks recipient); swap for a real SMS/WhatsApp provider before
  launch. Plaintext code rides ONLY the transient job (removeOnComplete) — the
  persisted `Notification` row carries non-secret metadata only. `OtpService.issue`
  now enqueues delivery. Worker runs both queues. 6 unit tests.
- **observability/** — done. Structured JSON logging via `nestjs-pino`
  (`buildLoggerConfig`: LOG_LEVEL + secret redaction — auth/cookie/paystack-sig
  headers, OTP `code`/`codeHash`), wired as the app logger in main/worker/cron with
  request correlation ids. Conditional Sentry (`initSentry` — no-op without
  `SENTRY_DSN`) on all three entrypoints. 4 unit tests.
- **webhooks/ replay window** — done. Signed-but-stale events (payload timestamp
  older than `WEBHOOK_MAX_AGE_SECONDS`, default 24h) are accepted with 200 but not
  processed — a replay backstop on top of the `providerEventId` dedupe.
- **Hardening** — `helmet`, global `@nestjs/throttler` (webhooks skip; tighter
  per-route limits on OTP request/confirm), `GET /health/ready` (Postgres + Redis).
- **frontend-facing endpoints** — done. Map + rationale in
  [`docs/FRONTEND_API_MAP.md`](docs/FRONTEND_API_MAP.md). Added: `POST /waitlist`
  (public, idempotent), `GET /public/transactions/:publicLinkId` (public pay page —
  allow-listed lean projection, visible only in LINK_ACTIVE/PAYMENT_PENDING, 404
  otherwise), `GET /public/sellers/:badgeSlug` (trust badge), `GET /transactions`
  (role-scoped cursor list — caller id always intersected), `GET /transactions/:id/
  timeline|disputes|payouts` (participant/admin; payout projection omits
  idempotency secrets), `POST /transactions/:id/cancel` (CANCEL — DRAFT/LINK_ACTIVE
  only), evidence seam (`POST /transactions/:id/evidence` + `GET /evidence/:id/
  download-url` — private bucket signed URLs, participant/admin), admin reads
  (`GET /admin/transactions|disputes`, `GET /admin/transactions/:id/audit`, all
  `@Roles('ADMIN')`), seller profile (`GET|PATCH /users/me/seller`,
  `POST /users/me/seller/subaccount` — idempotent Paystack subaccount, audited,
  server-owned fields never client-writable), notifications inbox
  (`GET /notifications`, `POST /notifications/:id/read` — ownership-scoped). New
  env `PAYSTACK_SUBACCOUNT_PERCENTAGE_CHARGE`; new additive migration
  `20260801000000_notification_read_at` (Notification.readAt — UNAPPLIED). 8 new
  money-safety unit tests (public-projection non-leak, list scoping, subaccount
  idempotency). Real SMS/WhatsApp OTP transport + evidence AV-scan gating still
  seams (readiness §7).

- **invoices/ (Phase 1) — done, PROVEN against real Postgres.** Itemized, formal
  invoices that fund a **protected escrow Transaction** — no new money path. Design:
  [`docs/superpowers/specs/2026-08-05-invoicing-phase1-design.md`](docs/superpowers/specs/2026-08-05-invoicing-phase1-design.md).
  An `Invoice` is a richer front-end onto exactly **one** Transaction (`1—1`,
  nullable until sent). `InvoicesService`: `createDraft`/`edit` (DRAFT-only) with
  **server-computed totals** (pure `invoice.compute.ts`, integer kobo, client-sent
  totals ignored — rule 1); `send` mints one protected tx (drives `SELLER_PUBLISH`
  through the state machine), allocates an **atomic per-seller number** `INV-0001`
  (`InvoiceCounter` upsert), flips DRAFT→SENT, enqueues delivery — **idempotent**
  (re-send mints no second tx); `void` (pre-PAID only) cancels the linked tx via
  `CANCEL`; `remind` re-delivers (route-throttled); `scanOverdue` (cron) flips
  past-due SENT/VIEWED→OVERDUE (soft, reversible, never blocks payment).
  **PAID is derived** — set ONLY by `markPaidByTransaction`, called from the
  payments protect path when the tx hits PAYMENT_PROTECTED (the same signed-webhook
  / server-verify event that owns rule 2), guarded `status in (SENT,VIEWED,OVERDUE)`
  so it's idempotent and never regresses VOID/PAID. Never from a client call.
  Delivery rides the existing `notification` queue (`enqueueInvoice`/`deliverInvoice`,
  `invoice.sent` template — chat surface if the buyer has a `ChatIdentity`, else
  email). Endpoints: `POST /invoices`, `PATCH /invoices/:id`,
  `POST /invoices/:id/send|void|remind`, `GET /invoices` (seller cursor list),
  `GET /invoices/:id` (owner-guarded), `GET /public/invoices/:publicViewId`
  (`@Public()`, allow-listed lean projection — marks VIEWED, never leaks
  `transactionId`/`sellerId`/buyer id/payout fields). Every send/void/remind/paid
  writes an AuditLog row (rule 6). Additive migration
  `20260803000000_invoicing_phase1` (3 tables + `InvoiceStatus` enum + the
  `invoices.transactionId` FK — **applied clean to the local test DB**). New dep
  `@nestjs/mapped-types`. **Frontend renders the PDF/document — this backend owns
  the number + structured JSON only** (no PDF lib here). Tests: money math, lifecycle
  guards, PAID-derivation, public-view non-leak, atomic number, send idempotency
  (unit) + `test/invoicing-money-safety.e2e-spec.ts` (5 e2e: one tx per sent
  invoice, server-owned totals, PAID only via protect, idempotent PAID/send,
  void-cancels-tx). **Phase 2 (direct/non-escrow toggle) and Phase 3 (recurring/
  batch) deferred to their own specs.**

- **chat/ slices 2 & 3 (adapters) — code done, gated on external approval.**
  **Meta adapter** (`adapters/meta/meta.adapter.ts`) covers **WhatsApp +
  Instagram + Messenger** on one class: X-Hub-Signature-256 HMAC over the raw
  body, the `GET :platform/webhook` verify-token handshake (`verifyChallenge`),
  and Graph send — WhatsApp Cloud-API payload shape vs the Messenger/Instagram
  Send-API shape selected by `product`. Instantiated once per configured platform
  in `ChatModule`; a platform whose credential set is incomplete is simply not
  registered. **X adapter** (`adapters/x/x.adapter.ts`) is a deliberate **stub**
  (needs a paid API tier + Account Activity API): fails signature closed, parses
  nothing, send throws — registered only when `X_ADAPTER_ENABLED=true`. Chat
  **dispute** command wired (`/dispute` → `DisputesService.raise`, OPEN freezes
  release, rule 5). New env `META_APP_SECRET`, `META_VERIFY_TOKEN`,
  `META_GRAPH_VERSION`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
  `MESSENGER_PAGE_ACCESS_TOKEN`, `MESSENGER_PAGE_ID`, `INSTAGRAM_ACCESS_TOKEN`,
  `INSTAGRAM_ACCOUNT_ID`, `X_ADAPTER_ENABLED`. Tests: Meta signature + challenge +
  parse (both shapes), X stub fail-closed, `/dispute` routing.

- **chat/ photo & document evidence — code done, unproven against real CDNs.**
  Adapters gained `downloadMedia` + media parsing: Telegram (`photo`→largest size,
  `document`; `getFile`→file download, caption becomes text) and Meta
  (WhatsApp id→Graph media-url→bytes; Messenger/Instagram attachment url fetched
  directly — both with the page/WABA bearer). New `ChatEvidenceService.capture`
  pulls the bytes via the adapter, enforces an allow-list (`image/*` jpeg|png|webp|
  gif, `application/pdf`) + a 10 MiB cap, re-uploads to the PRIVATE Supabase bucket
  via new `StorageService.uploadFile` (server-side `upload`, never linked from the
  platform CDN), and writes an `Evidence` row (`scanStatus PENDING`). Dialog: after
  `/dispute` the session enters `DISPUTE_EVIDENCE` and a photo/document with no
  slash-command attaches to the caller's open dispute (participant-checked); a
  caption that IS a command still runs as a command. New `ChatStep.DISPUTE_EVIDENCE`
  + `ChatDraft.disputeId`; `ChatInboundJobData.media` carries attachments through
  the queue; `handle()` takes the adapter so media can be fetched in the worker. No
  new env, no schema change (reuses `SUPABASE_*` + existing adapter tokens + the
  `Evidence` model). Tests: Telegram/Meta media parse + `downloadMedia` (faked
  fetch), `ChatEvidenceService` capture + mime rejection, `StorageService.uploadFile`,
  dialog attach/refuse/unsupported-channel. **Unproven bit (needs credentials, not
  code): no real Telegram/Meta media has been downloaded and no byte has hit a real
  Supabase bucket** — the CDN download + re-upload is only exercised against faked
  HTTP, same posture as every other external seam here.

- **seller payout onboarding** — done. `POST /users/me/seller/recipient` resolves
  the NUBAN account with Paystack (`/bank/resolve`), creates the transfer recipient
  from the **bank-resolved** name (never client text), and stores only
  `providerRecipientCode` + bank code + last 4 + account name — the full account
  number is never persisted or audited. One destination per seller. `GET /banks`
  backs the picker.
- **e2e money-safety specs** — **passing** (`test/money-safety.e2e-spec.ts` +
  harness in `test/utils/`). Real app + state machine + Prisma against a real
  Postgres; only Paystack (real HMAC, no network) / auth / Redis-queue are faked,
  so they need Postgres only. 12 specs: all six rules + kobo + transfer automation
  (one transfer per release, no-recipient never moves money, `transfer.failed`
  completes nothing). **Skip unless `DATABASE_URL` is set** (unconfigured CI stays
  green). Now also run in CI against a Postgres service container.
- **local dev services** — `docker-compose.yml` (postgres:16 on **55432**,
  redis:7 on **56379** — non-default ports so nothing collides) + `.env.test`
  (fake local values, committed). `npm run db:up` → `npm run db:migrate:test` →
  `npm run test:e2e`.
- **chat/ Telegram — PROVEN locally end-to-end + one real bug fixed.** New
  `npm run chat:sim` ([`scripts/chat-sim.ts`](scripts/chat-sim.ts) +
  [`test/utils/chat-simulator.ts`](test/utils/chat-simulator.ts)) drives real
  Telegram Update JSON through the real stack (dialog + state machine + Prisma +
  OTP + signed Paystack webhook) against the docker Postgres, faking only the
  external seams (Paystack/Supabase-admin/auth/Telegram-`send`), and prints the
  full seller→buyer→pay→deliver→OTP→release conversation as a transcript. Payment
  still protects only via a signed `charge.success` (rule 2). **Bug it surfaced +
  fixed:** `capturePayoutAccount` called `sessions.reset()`, wiping the seller's
  active `transactionId`; a seller who ran `/setup_payout` after `/sell` (the
  ordering the "no payout destination" warning nudges) could then never
  `/delivered` — chat only exposes the `publicLinkId`, never the internal id. Now
  returns to IDLE preserving the active transaction (2 new dialog unit tests).
  Runbook: [`docs/CHAT_TELEGRAM_LOCAL.md`](docs/CHAT_TELEGRAM_LOCAL.md). Design:
  [`docs/superpowers/specs/2026-08-07-chat-telegram-audit-and-sim.md`](docs/superpowers/specs/2026-08-07-chat-telegram-audit-and-sim.md).
  Still unproven: no real Telegram update, no real Supabase/Paystack (credentials,
  not code).

- **chat/ (bot gateway) — slice 1 done.** Chat-native surface so the whole
  protected-transaction flow runs inside a social-media chat, no website. Design:
  [`docs/superpowers/specs/2026-08-02-chat-native-bot-design.md`](docs/superpowers/specs/2026-08-02-chat-native-bot-design.md).
  Platform-agnostic core + per-platform adapters (`ChatAdapter` under the
  `CHAT_ADAPTERS` multi-token; core branches on `capabilities`, never platform).
  **Telegram adapter** built (registers only when `TELEGRAM_BOT_TOKEN` set;
  `X-Telegram-Bot-Api-Secret-Token` HMAC-equivalent auth). Gateway:
  `POST /chat/:platform/webhook` verifies signature → dedupes on
  `ChatInboundEvent(platform, providerMessageId)` → enqueues a BullMQ `chat` job →
  200 fast; all dialog work runs in the worker. Identity: `ChatIdentityService`
  mints a real Supabase auth user on first contact (admin `createUser`, synthetic
  `chat+<platform>-<id>@CHAT_IDENTITY_EMAIL_DOMAIN` email) so `User.id` stays an
  auth uuid; idempotent on `(platform, platformUserId)`. `ChatSession` holds
  conversational step + draft (NEVER transaction state). `ChatDialogService` drives
  the happy path (seller `/sell` create+publish, `/setup_payout`; buyer `/pay
  <linkCode>`; seller `/delivered` → issues OTP; buyer types OTP in chat → confirm
  → release) **only through the domain services** — the state machine stays the
  sole owner of `TransactionStatus` (rule 1) and a chat message is never a trusted
  payment source (rule 2). **In-chat payment = Paystack dedicated virtual accounts
  (DVA):** one throwaway customer per tx → one DVA per tx; `charge.success` carries
  Paystack's own reference, resolved by `customer_code` and bound to
  `Payment.providerChargeReference` (nullable-unique) as a one-shot idempotency
  lock, then the existing server-verify + exact-amount hard stop runs unchanged
  (rules 2 & 4 intact). OTP + payment/payout pushes go out over the chat queue
  (`ChatOutboundService` + templates); OTP code rides only the transient job.
  New models `ChatIdentity` / `ChatSession` / `ChatInboundEvent`, DVA columns on
  `Payment`, `ChatPlatform` enum, `NotificationChannel` += TELEGRAM/INSTAGRAM/
  MESSENGER; additive migration `20260802000000_chat_native_bot` (**applied to the
  local test DB**). New env `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
  `CHAT_IDENTITY_EMAIL_DOMAIN`, `CHAT_SESSION_TTL_SECONDS`. Tests: adapter,
  identity, dialog, inbound dedupe, templates, DVA binding + amount mismatch
  (unit) + `test/chat-money-safety.e2e-spec.ts` (6 e2e: no protect without a
  signed webhook, DVA amount mismatch never protects, re-delivery never double-
  protects, inbound dedupe, bad-signature reject). **Slice 2 (Meta adapter —
  WhatsApp/Instagram/Messenger — + chat disputes/photo evidence) and slice 3 (X)
  are the remaining adapters; both are gated on external approval, not code.**

- **eaas/ (Escrow-as-a-Service) — Slice 1 done, PROVEN against real Postgres.**
  A third-party developer's server drives our escrow engine with a secret API key,
  fully isolated per tenant, over a versioned `/v1` API — **no new money path**.
  Plan: [`docs/superpowers/plans/2026-08-07-eaas-slice1-tenancy-apikey.md`](docs/superpowers/plans/2026-08-07-eaas-slice1-tenancy-apikey.md).
  New models `Merchant` (status + `livemodeEnabled` gate) and `MerchantApiKey`
  (plaintext returned **once** at creation and never stored — only a keyed
  HMAC-SHA256 of it, the `keyHash` unique lookup column; `api-key.crypto.ts`
  mirrors the `otp.crypto.ts` pattern, keyed by the new `EAAS_API_KEY_SECRET`).
  Nullable `merchantId` tenancy columns on `User` / `SellerProfile` /
  `Transaction` / `Payout` — **null = first-party Meduman**, and the column is
  never client-writable: `/v1` writes it from the verified key, and
  `PayoutsService` inherits it from the transaction so tenancy travels with the
  money. `ApiKeyGuard` reads `Authorization: Bearer sk_…`, resolves the merchant
  (401 missing/unknown/revoked/suspended), 403s an `sk_live` key until an admin
  flips `livemodeEnabled`, and attaches `@CurrentMerchant() {id,livemode}`. The
  `/v1` controllers are `@Public()` **only** so the global `SupabaseJwtGuard`
  steps aside — `ApiKeyGuard` is the real gate. Endpoints: `POST|GET /v1/sellers`,
  `GET /v1/sellers/:id`, `POST /v1/sellers/:id/recipient` (reuses the existing
  bank-resolved recipient onboarding), `POST|GET /v1/transactions`,
  `GET /v1/transactions/:id`, `POST /v1/transactions/:id/publish` (an intent
  through `apply()`, never a status write — rule 1). Admin CRUD (JWT +
  `@Roles('ADMIN')`): `POST /admin/merchants`, `POST /admin/merchants/:id/keys`,
  `POST /admin/merchants/:id/keys/:keyId/revoke`, `PATCH /admin/merchants/:id`
  (livemode / suspend). **Isolation invariant:** every `/v1` read and write
  intersects the caller's `merchantId` in the service layer
  (`assertOwnedSeller` / `getByIdForMerchant` / `listForMerchant`), and a
  cross-tenant id returns **404, never 403** — the API never confirms someone
  else's row exists. **Custody stays with the platform:** a merchant orchestrates
  an escrow but never holds funds; collection is the existing Paystack charge and
  release the existing idempotent transfer, so rules 1–6 are untouched and `/v1`
  adds **no** money-marking endpoint. New env `EAAS_API_KEY_SECRET`; additive
  migration `20260807000000_eaas_tenancy` (2 tables + `MerchantStatus` enum + 4
  nullable columns — **applied clean to the local test DB**). Tests: api-key
  crypto, `MerchantsService` (one-time plaintext, revoked/suspended verify),
  `ApiKeyGuard`, `MerchantSellersService`, merchant-scoped transaction
  create/list/get, payout tenancy inheritance (unit) +
  `test/eaas-tenancy.e2e-spec.ts` (5 e2e: no-key 401 / valid `sk_test` succeeds,
  cross-tenant read 404, cross-tenant seller-create 404, `sk_live` 403 until
  livemode + revoked key 401, full merchant-scoped lifecycle → exactly one
  transfer with `merchantId` on the transaction **and** the payout). **Multi-tenant
  fund custody sharpens the Nigerian licensing question — a blocker before any
  real external merchant goes livemode (see readiness §6).**

- **eaas/ (Escrow-as-a-Service) — Slice 2 done, PROVEN against real Postgres.**
  Outbound webhooks let merchants receive events when transactions change state.
  **Transactional outbox:** `TransactionsService.apply` writes an `OutboundEvent`
  row atomically with the state change (same `$transaction` block), then a BullMQ
  `webhook-out` worker delivers it; a cron relay (`redispatchPending`) re-sends
  stranded PENDING rows. New models `WebhookEndpoint` (one per merchant; signing
  secret AES-256-GCM encrypted at rest, `secretEnc`, returned once at creation)
  and `OutboundEvent` (outbox + delivery log). Events emitted **only for
  transactions with `merchantId` set** (first-party events stay internal):
  `transaction.protected`, `transaction.cancelled`, `dispute.opened`,
  `dispute.resolved`, `funds.released`. Endpoints (API-key auth): `POST|GET|DELETE
  /v1/webhook-endpoints`, `POST /v1/webhook-endpoints/rotate-secret` (crypto
  re-keying), `GET /v1/events` (merchant-scoped delivery log + replay surface).
  **Signing:** HMAC-SHA256 over the JSON event body; headers `X-Meduman-Event-Id`
  (unique) + `X-Meduman-Signature: t=<timestamp>,v1=<hmac>`. **SSRF guard:** block
  private IPs, loopback, link-local, metadata; require https for live
  (`livemodeEnabled=true`), http for test. Registered at creation and re-validated
  on rotate. **Delivery:** idempotent (skip DELIVERED), retry via BullMQ with
  backoff (5 attempts, exponential), dead-letter to FAILED after exhaustion.
  Timeout `WEBHOOK_DELIVERY_TIMEOUT_MS`. New env `EAAS_WEBHOOK_SIGNING_KEY`
  (zod-required, ≥32 chars, keys the event signature HMAC), `WEBHOOK_DELIVERY_TIMEOUT_MS`,
  `WEBHOOK_MAX_ATTEMPTS`; additive migration `20260808000000_eaas_outbound_webhooks`
  (2 tables + `OutboundEventStatus` enum — **applied clean to the local test DB**).
  Tests: secret crypto (AES-GCM), signing, SSRF validation, builder map, emit seam,
  `/v1` endpoints, delivery idempotency (unit) + `test/eaas-webhooks.e2e-spec.ts`
  (5 e2e: one event per merchant protect, zero for first-party, one funds.released,
  cross-tenant /v1/events 404, delivery DELIVERED/FAILED). **Unproven bit:** SSRF
  guard is static (literal-IP + localhost); DNS-rebind hardening (resolve-and-pin
  at send) + blocking 0.0.0.0 / IPv4-mapped IPv6 are follow-ups before external
  merchants point live URLs at us.

**Status: full spine + chat bot gateway (Telegram + Meta adapters, X stub, DVA
payments, chat photo/document evidence) + Phase 1 invoicing + EaaS Slice 1
(merchant tenancy + API-key `/v1`) done and PROVEN
against a real Postgres +
Redis — 49 unit suites / 381 tests + 28 e2e (5 suites), lint + build clean.** All eight migrations apply clean to
an empty DB; the app boots, `/health` and `/health/ready`
(`{"db":true,"redis":true}`) return 200, and an unauthenticated protected route
still 401s. (`ioredis` pinned to `5.10.1` to match bullmq's exact pin.) New env
since scaffold: `OTP_HASH_SECRET`, `OTP_MAX_ATTEMPTS`, `WEBHOOK_MAX_AGE_SECONDS`,
`SENTRY_DSN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
`CHAT_IDENTITY_EMAIL_DOMAIN`, `CHAT_SESSION_TTL_SECONDS`, the `META_*` /
`WHATSAPP_*` / `MESSENGER_*` / `INSTAGRAM_*` set, `X_ADAPTER_ENABLED`, and
`EAAS_API_KEY_SECRET`.

**Gotcha worth remembering:** global guards must be registered as
`{ provide: APP_GUARD, useExisting: SupabaseJwtGuard }` with the class also in
`providers`. With a bare `useClass`, Nest builds the instance under the APP_GUARD
token and `overrideGuard()` silently does nothing — which made every e2e request
401 against the real guard.

**Still unproven (needs credentials, not code):** nothing has touched Supabase or
Paystack — no hosted migration, no real JWT verified, no transfer ever sent, no
real DVA assigned, no real Telegram update received. Render has never deployed
this. **Paystack "Transfers OTP" must be DISABLED** or automated release stalls;
**DVA must be enabled** on the Paystack account for the in-chat payment path; a
Telegram bot token + webhook (`setWebhook` with the secret) is needed to see the
bot receive anything. See [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md).

**Full production-readiness checklist:** [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md)
— blockers, money-safety verification, security, observability, CI/CD, release.

### Auth usage

- Routes are protected by default. Add `@Public()` to opt a route out.
- `@CurrentUser() user: SupabaseJwtClaims` injects the verified identity.
- `@Roles('ADMIN')` restricts by app role (from JWT `app_metadata.role`).
