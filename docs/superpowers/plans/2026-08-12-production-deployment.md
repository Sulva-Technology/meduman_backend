# Production Deployment Plan — Meduman Backend

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to work
> this task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Many steps are human-only** — they need live credentials or a dashboard click.
> Those are marked **[HUMAN]**. An agent must stop at a **[HUMAN]** step and hand off,
> never fake or skip it.

**Goal:** Take the Meduman backend from "proven locally against docker Postgres/Redis"
to "live on Render, connected to a real Supabase project and a real Paystack account,
capable of completing one real protected transaction end-to-end" — via a staging
environment first, with an explicit rollback path.

**Architecture:** Render blueprint (`render.yaml`) → one web service (API), one worker,
one cron, one keyvalue (Redis). Postgres + Auth + Storage come from Supabase. Money
moves through Paystack. Migrations run once per deploy in the API service's
`preDeployCommand` against `DIRECT_URL`; runtime uses the pooled `DATABASE_URL`.

**Tech stack:** NestJS 10 / TypeScript strict, Prisma 5, BullMQ 5 + ioredis 5.10.1,
Supabase (Postgres + Auth + Storage), Paystack, Render, GitHub Actions CI.

---

## Global Constraints

Copied verbatim from `CLAUDE.md` and `docs/PRODUCTION_READINESS.md`. Every task below
implicitly inherits these.

- **Node `>=20`.** Render services must run Node 20+.
- **`DATABASE_URL` = pooled (pgbouncer) → runtime. `DIRECT_URL` = direct → migrations
  only. Don't swap them.**
- **Paystack "Transfers OTP" must be DISABLED** on every Paystack account this deploys
  against. With it enabled, `POST /transfer` returns `status: otp` and automated release
  stalls (decision D-0).
- **Dedicated Virtual Accounts (DVA) must be enabled** on the Paystack account for the
  in-chat payment path.
- **Money is integer minor units (kobo).** Never floats. Nothing in this plan changes that.
- **`prisma/seed.ts` must never run against production.** It self-refuses on
  `NODE_ENV=production` (`prisma/seed.ts:53`) — do not override that.
- **Six money-safety rules** (CLAUDE.md) override convenience. Nothing in this plan adds
  a money path; if a step seems to require one, stop.
- **EaaS `livemodeEnabled` stays `false` for every external merchant** until legal
  sign-off on multi-tenant custody (readiness §6). `sk_test` + the false default are the
  technical hold.
- **All secrets are `sync: false` in `render.yaml`** — set in the Render dashboard, never
  committed.
- **Deploy order is not negotiable:** Supabase + Paystack verification (Tasks 2–4) come
  before any Render deploy that takes real traffic. A deploy without a verified JWT path
  or a working transfer is a deploy that cannot complete a transaction.

---

## File Structure

Only three files change in this plan. Everything else is dashboard configuration.

| File | Responsibility | Change |
| --- | --- | --- |
| `render.yaml` | Render blueprint — services + shared env group | Modify: add the 4 missing env keys (Task 1) |
| `.env.example` | Canonical list of every env var, kept in sync with the zod schema | Modify: add the same 4 keys (Task 1) |
| `docs/DEPLOY_RUNBOOK.md` | Operational runbook — rollback, stuck payout, webhook backlog | Create (Task 11) |

`src/config/env.validation.ts` is the source of truth for what is required and is **not**
modified — the other two files are being brought into sync with it.

---

## Task 0: Get the tree committed and CI green

The working tree has ~63 modified files and the repo has **no git remote**. Render's
`autoDeploy` and the GitHub Actions CI in `.github/workflows/ci.yml` both need a remote.
Nothing else in this plan can start.

**Files:** none created. Repo/remote state only.

- [ ] **Step 1: See exactly what is uncommitted**

```bash
git status --porcelain
```

Expected: a list of modified files across `src/modules/chat`, `src/modules/invoices`,
`src/common/paystack`, and friends. Read it — do not blind-commit.

- [ ] **Step 2: Verify the tree before committing it**

```bash
npm run lint && npm run build && npm test
```

Expected: lint clean, build clean, all unit suites pass. If anything fails, **stop and
fix it** — do not deploy a red tree.

- [ ] **Step 3: Run the e2e money-safety suites against docker Postgres**

```bash
npm run db:up && npm run db:migrate:test && npm run test:e2e
```

Expected: all e2e suites pass (money-safety, chat-money-safety, invoicing-money-safety,
eaas-tenancy, eaas-webhooks). These skip silently if `DATABASE_URL` is unset — confirm
the output shows specs *ran*, not that suites were skipped.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: commit working tree ahead of first deploy"
```

- [ ] **Step 5: [HUMAN] Create the GitHub repo and push**

Create a **private** repo (this is `UNLICENSED`, and it contains money logic). Then:

```bash
git remote add origin git@github.com:<org>/meduman-backend.git
git push -u origin main
```

- [ ] **Step 6: Confirm CI actually runs**

Open the repo's Actions tab. `.github/workflows/ci.yml` should run on the push: `npm ci`
→ prisma generate → lint → build → unit tests → money-safety e2e against a throwaway
Postgres service. Expected: green. This workflow **has never executed** — treat the first
run as a real verification step, not a formality.

---

## Task 1: Close the env-var gap in `render.yaml` and `.env.example`

`src/config/env.validation.ts` requires four variables that are **absent from both**
`render.yaml` and `.env.example`. Two are zod-**required with no default** —
`EAAS_API_KEY_SECRET` (min 16) and `EAAS_WEBHOOK_SIGNING_KEY` (min 32). Deploying the
current blueprint means **all three services crash on boot** with
`Invalid environment variables:`. This is the single highest-value change in the plan.

**Files:**
- Modify: `render.yaml` (the `meduman-shared` env-var group)
- Modify: `.env.example`
- Reference (do not edit): `src/config/env.validation.ts:59-65`

- [ ] **Step 1: Confirm the gap yourself**

```bash
grep -c "EAAS_API_KEY_SECRET" render.yaml .env.example
```

Expected: `render.yaml:0` and `.env.example:0`. That zero is the bug.

- [ ] **Step 2: Add the four keys to the `meduman-shared` group in `render.yaml`**

Insert after the `WEBHOOK_MAX_AGE_SECONDS` entry (currently `render.yaml:72-73`):

```yaml
      # --- EaaS (Escrow-as-a-Service) ---
      # Keys the HMAC-SHA256 hash-at-rest of every merchant API key. REQUIRED
      # (zod min 16) — the app will not boot without it. Rotating this
      # invalidates EVERY issued merchant key: treat rotation as a re-issue
      # exercise for all merchants, never a routine secret rotation.
      - key: EAAS_API_KEY_SECRET
        sync: false
      # Keys the outbound-webhook event signature HMAC and the AES-256-GCM
      # encryption of each endpoint's signing secret at rest. REQUIRED (zod
      # min 32). Rotating this makes every stored endpoint secret undecryptable.
      - key: EAAS_WEBHOOK_SIGNING_KEY
        sync: false
      - key: WEBHOOK_DELIVERY_TIMEOUT_MS
        value: 5000
      - key: WEBHOOK_MAX_ATTEMPTS
        value: 5
```

- [ ] **Step 3: Add the same four to `.env.example`**

Place them after the existing `WEBHOOK_MAX_AGE_SECONDS` line (`.env.example:91`), with local-dev-safe
placeholder values (this file is committed, so these must be obviously fake):

```bash
# EaaS — both are REQUIRED; the app fails fast at boot without them.
# EAAS_API_KEY_SECRET: min 16 chars. Rotating it invalidates every merchant API key.
EAAS_API_KEY_SECRET=dev-only-eaas-api-key-secret-change-me
# EAAS_WEBHOOK_SIGNING_KEY: min 32 chars. Rotating it orphans stored endpoint secrets.
EAAS_WEBHOOK_SIGNING_KEY=dev-only-eaas-webhook-signing-key-change-me-32+
WEBHOOK_DELIVERY_TIMEOUT_MS=5000
WEBHOOK_MAX_ATTEMPTS=5
```

- [ ] **Step 4: Prove the blueprint now covers every required variable**

Cross-check the zod schema against the blueprint. Every key in the schema that has
**no `.default()` and no `.optional()`** must appear in `render.yaml` (either in
`meduman-shared` or in a per-service `envVars` block — `NODE_ENV`, `PORT`, and
`REDIS_URL` are per-service by design).

```bash
grep -nE "^  [A-Z_]+: z\." src/config/env.validation.ts | grep -v "default(\|optional()"
```

Expected required set: `APP_URL`, `FRONTEND_ORIGIN`, `DATABASE_URL`, `DIRECT_URL`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `PAYSTACK_SECRET_KEY`,
`PAYSTACK_PUBLIC_KEY`, `REDIS_URL`, `OTP_HASH_SECRET`, `EAAS_API_KEY_SECRET`,
`EAAS_WEBHOOK_SIGNING_KEY`. Confirm each one is present in `render.yaml`.

- [ ] **Step 5: Boot locally with a `.env` built only from `.env.example` keys**

Copy `.env.example` → `.env`, fill in the docker-compose values from `.env.test`, and:

```bash
npm run build && node dist/main.js
```

Expected: `API listening on :3000` — no `Invalid environment variables:` throw. This is
the actual test of Task 1: if a key is still missing, the app refuses to boot here rather
than on Render.

- [ ] **Step 6: Commit**

```bash
git add render.yaml .env.example
git commit -m "fix(deploy): add required EAAS_* and webhook-delivery env vars to blueprint"
git push
```

---

## Task 2: Stand up the Supabase projects and apply migrations

Two Supabase projects: **staging** and **production**. Never share one. All nine
migrations in `prisma/migrations/` apply clean to an empty DB locally; they have never
touched a hosted Postgres or pgbouncer.

**[HUMAN]** — everything in this task needs live credentials.

- [ ] **Step 1: [HUMAN] Create the two Supabase projects**

Region: closest to Render's `frankfurt` (the blueprint pins `region: frankfurt` for all
services). Record for each project: pooled connection string (port 6543, `?pgbouncer=true`),
direct connection string (port 5432), project URL, anon key, service-role key, JWKS URL.

- [ ] **Step 2: [HUMAN] Create the private storage bucket**

Bucket name must match `SUPABASE_STORAGE_BUCKET` (blueprint default: `evidence`).
**Set it PRIVATE.** Evidence files are never publicly readable — access is only via the
short-lived signed URLs this backend generates. Verify: an unauthenticated GET of an
object path returns 400/403, not the file.

- [ ] **Step 3: Apply the migrations to staging**

Against the **direct** URL (port 5432), never the pooled one — `prisma migrate deploy`
needs a direct connection:

```bash
DIRECT_URL="postgresql://...:5432/postgres" DATABASE_URL="postgresql://...:6543/postgres?pgbouncer=true" npm run prisma:migrate:deploy
```

Expected: all nine migrations reported applied — `20260713000000_init` through
`20260808000000_eaas_outbound_webhooks`. Any failure here is a real schema bug against
hosted Postgres; fix the migration, do not hand-patch the database.

- [ ] **Step 4: Prove the pooled runtime URL connects**

The pooled URL is a different code path (pgbouncer transaction mode). Point a local run
at staging's pooled URL and hit readiness:

```bash
curl -s localhost:3000/health/ready
```

Expected: `{"status":"ready","db":true,"redis":true}`. A `db:false` here means the pooled
string is wrong or pgbouncer is rejecting prepared statements — solve it now, not after
deploy.

- [ ] **Step 5: [HUMAN] Confirm backups / PITR on the production project**

Readiness §4. Note the retention window and write the restore steps into
`docs/DEPLOY_RUNBOOK.md` in Task 11. A schema this financial without a tested restore
path is not production-ready.

- [ ] **Step 6: Repeat Steps 1–4 for production** — same commands, production credentials.
      Do **not** run `npm run prisma:seed` against either hosted project.

---

## Task 3: Verify one real Supabase JWT end-to-end

Every automated test **fakes the auth guard**. JWKS fetch, issuer, and audience have
never been exercised against a token Supabase actually issued. This is a blocker.

**[HUMAN]** — needs a real Supabase user.

- [ ] **Step 1: [HUMAN] Create a test user in the staging Supabase project and sign in**

Use the Supabase dashboard or the JS client to get an `access_token`.

- [ ] **Step 2: Run the API locally against staging Supabase**

Set `SUPABASE_JWT_STRATEGY=jwks`, `SUPABASE_JWKS_URL=<staging JWKS url>`,
`SUPABASE_JWT_ISSUER=<staging issuer>`, `SUPABASE_JWT_AUDIENCE=authenticated`, plus the
staging DB URLs. Start it: `node dist/main.js`.

- [ ] **Step 3: Call a protected route with the real token**

```bash
curl -s -H "Authorization: Bearer <access_token>" localhost:3000/users/me
```

Expected: 200 with the user mirror (`UsersService.syncFromClaims` upserts the local `User`
row on first call). Confirm in the DB that a `User` row now exists with that auth uuid.

- [ ] **Step 4: Confirm the negative cases**

```bash
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/users/me
```

Expected: `401`. Then repeat with a tampered token (flip one character in the signature)
— also `401`, and check the logs show a verification failure, not a crash.

- [ ] **Step 5: Audit every `@Public()` route before going further**

```bash
grep -rn "@Public()" src --include=*.controller.ts
```

Expected set — each must be *deliberately* public: `POST /waitlist`,
`GET /public/transactions/:publicLinkId`, `GET /public/sellers/:badgeSlug`,
`GET /public/invoices/:publicViewId`, `POST /webhooks/paystack`,
`POST|GET /chat/:platform/webhook`, `GET /health*`, and the `/v1/*` EaaS controllers.
**The `/v1` controllers are `@Public()` on purpose** — that only steps the Supabase JWT
guard aside; `ApiKeyGuard` is their real gate. Anything on that list you cannot justify in
one sentence is a finding — fix it before deploy.

---

## Task 4: Prove the Paystack path in test mode

Nothing has ever been sent to Paystack — not one call, not even in test mode. The whole
release path is tested against a fake.

**[HUMAN]** — needs Paystack test keys and a funded test balance.

- [ ] **Step 1: [HUMAN] Confirm "Transfers OTP" is DISABLED on the account**

Paystack dashboard → Settings → Preferences (or API keys & webhooks, depending on
dashboard version). With OTP enabled, `POST /transfer` returns `status: otp`, the worker
never gets a `transfer.success`, and **every automated release stalls with the buyer's
money held**. Re-check this after any Paystack account change (decision D-0).

- [ ] **Step 2: [HUMAN] Confirm Dedicated Virtual Accounts (DVA) are enabled**

Required for the in-chat payment path (one throwaway customer + one DVA per transaction).
Without it, chat-native payment fails at account assignment. Non-chat checkout still works.

- [ ] **Step 3: [HUMAN] Register the webhook URL (staging, test keys)**

Set the Paystack webhook URL to `https://<staging-api-host>/webhooks/paystack`. This is
the only path that may mark money moved (rule 2) — HMAC-SHA512 over the raw body,
`WebhookEvent` dedupe on `providerEventId` (rule 4).

- [ ] **Step 4: Send one real test-mode charge and confirm it protects**

Drive the flow against staging: seller publishes → buyer pays the Paystack test card →
Paystack fires `charge.success` → the transaction reaches `PAYMENT_PROTECTED`.

Verify in the staging DB:
- `Payment.status = SUCCESS`, amount in **kobo**, matching the transaction exactly.
- A `WebhookEvent` row for the `providerEventId`.
- An `AuditLog` status-change row (rule 6).

- [ ] **Step 5: Send one real test-mode transfer and confirm release completes**

Onboard the seller's transfer recipient first (`POST /users/me/seller/recipient` — resolves
the NUBAN with Paystack and stores only `providerRecipientCode` + bank code + last 4).
Then complete delivery + buyer confirmation so the worker sends the transfer.

Verify:
- Exactly **one** Paystack transfer, `reference = release:<txId>`.
- `transfer.success` webhook drives `PAYOUT_SUCCEEDED`.
- Replaying the same webhook changes nothing (rule 4).
- A seller with **no** `providerRecipientCode` never has funds moved.

- [ ] **Step 6: Confirm the failure path completes nothing**

Trigger (or simulate through the real signed webhook) a `transfer.failed`. Expected: the
failure is recorded, the transaction **stays frozen in `RELEASE_PROCESSING`**, and no
status advances. Recovery is the admin-only
`POST /admin/transactions/:id/payout/retry`.

---

## Task 5: Deploy the staging environment on Render

**Files:** none. `render.yaml` (as amended in Task 1) is the input.

- [ ] **Step 1: [HUMAN] Apply the blueprint as a staging environment**

Render → New → Blueprint → point at the GitHub repo. It creates `meduman-api`,
`meduman-worker`, `meduman-cron`, `meduman-redis`. Rename to `-staging` suffixes (or use a
separate Render environment) so production names stay free.

- [ ] **Step 2: [HUMAN] Fill the `meduman-shared` env group with staging values**

Every `sync: false` key. Staging uses: staging Supabase URLs/keys, Paystack **test** keys,
`FRONTEND_ORIGIN` = the staging frontend origin (exact origins, **no wildcards**),
`APP_URL` = the staging API URL.

Generate the two EaaS secrets — they are HMAC/AES keys, not passwords:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Run it twice: once for `EAAS_API_KEY_SECRET` (≥16 chars), once for
`EAAS_WEBHOOK_SIGNING_KEY` (≥32 chars). Same generator for `OTP_HASH_SECRET` (≥16).
**Store all three in a password manager before pasting them into Render** — losing
`EAAS_WEBHOOK_SIGNING_KEY` makes every stored endpoint secret undecryptable.

- [ ] **Step 3: Watch the first deploy's `preDeployCommand`**

The API service runs `npm run prisma:migrate:deploy` before traffic shifts. Since Task 2
already applied the migrations, expect *"No pending migrations to apply."* If it instead
tries to apply migrations, `DIRECT_URL` is pointed at a different database than you
migrated — stop and reconcile.

- [ ] **Step 4: Confirm all three services boot**

The worker and cron share the same fail-fast zod schema as the API. A variable present on
the API but missing on the worker crashes the worker on start — that is exactly the drift
the shared group prevents. Check all three logs for a clean start, and specifically that
none of them threw `Invalid environment variables:`.

- [ ] **Step 5: Smoke-test the deployed staging API**

```bash
curl -s https://<staging-api-host>/health
```
Expected: 200.

```bash
curl -s https://<staging-api-host>/health/ready
```
Expected: `{"status":"ready","db":true,"redis":true}` — this proves Supabase Postgres
*and* Render Redis are both reachable from the deployed service.

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<staging-api-host>/users/me
```
Expected: `401`.

- [ ] **Step 6: Confirm the webhook rejects a forged signature**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<staging-api-host>/webhooks/paystack -H "x-paystack-signature: deadbeef" -H "content-type: application/json" -d '{"event":"charge.success"}'
```

Expected: `401`, and **nothing written** to `WebhookEvent`. If this returns 200, raw-body
preservation is broken behind Render's proxy — that is a rule-2 breach and a hard stop.

- [ ] **Step 7: Run the full lifecycle on staging with Paystack test keys**

Repeat Task 4 Steps 4–6 against the deployed staging stack rather than a local process.
This is the first time the worker, cron, and API run as separate processes against shared
Redis — the deployment topology itself is what is under test here.

---

## Task 6: Wire the chat surfaces on staging

Adapters register only when their credentials are present, so a deploy with no chat vars
still boots. Telegram is the zero-approval path; Meta needs Business verification.

- [ ] **Step 1: [HUMAN] Create the Telegram bot and set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`**

The webhook secret is enforced by a cross-field check: setting the token without the
secret **fails boot** (`env.validation.ts:149`). That is deliberate — a Telegram webhook
with no shared secret accepts forged updates.

- [ ] **Step 2: Point Telegram at staging**

```bash
npm run telegram:webhook
```

(`scripts/telegram-webhook.mjs` — calls `setWebhook` with the secret token.) Confirm via
Telegram's `getWebhookInfo` that the URL is
`https://<staging-api-host>/chat/telegram/webhook` and `pending_update_count` is 0.

- [ ] **Step 3: Drive one real conversation**

Message the bot: `/sell` → `/setup_payout` → buyer `/pay <linkCode>` → `/delivered` → OTP.
Compare against the transcript `npm run chat:sim` produces locally. Expected: identical
flow. This is the first real Telegram update the system has ever received.

- [ ] **Step 4: Confirm chat evidence upload hits the real bucket**

Send a photo after `/dispute`. Expected: an `Evidence` row with `scanStatus PENDING` and
the bytes in the **private** Supabase bucket — never linked from the platform CDN. The CDN
download + re-upload path has only ever run against faked HTTP; this is its first real
exercise.

- [ ] **Step 5: [HUMAN] Leave Meta and X unconfigured for now**

Meta (`META_*` / `WHATSAPP_*` / `MESSENGER_*` / `INSTAGRAM_*`) is gated on Business
verification, not code. `X_ADAPTER_ENABLED` stays `false` — the X adapter is a stub that
fails signature closed and throws on send.

---

## Task 7: Bind a real OTP transport

Today buyer OTP codes reach only a log line (`LogNotificationSender`, non-prod only). A
buyer cannot confirm delivery by OTP in production without this. In-app
`POST /transactions/:id/confirm` remains the alternative path.

- [ ] **Step 1: Decide the transport**

The WhatsApp Cloud API transport already exists and binds **only** when
`WHATSAPP_OTP_TEMPLATE_NAME` is set alongside `WHATSAPP_ACCESS_TOKEN` +
`WHATSAPP_PHONE_NUMBER_ID` (see `NotificationsModule`). Anything less silently falls back
to the log stub. The alternative is an SMS provider (Termii/Twilio) behind the same
`NOTIFICATION_SENDER` token.

- [ ] **Step 2: [HUMAN] Get the WhatsApp authentication template approved**

Business-initiated messages outside the 24h service window require a **pre-approved**
template. Set `WHATSAPP_OTP_TEMPLATE_NAME`, `WHATSAPP_OTP_TEMPLATE_LANG` (default `en`),
`WHATSAPP_OTP_TEMPLATE_HAS_BUTTON` (default `true` — authentication templates carry a
copy-code button and the code must be repeated in its parameter), and
`WHATSAPP_DEFAULT_COUNTRY_CODE` (default `234`).

- [ ] **Step 3: Verify a code actually arrives**

Request an OTP on staging for a transaction in `CONFIRMATION_PENDING`. Expected: the code
arrives on the device, and the **plaintext code appears nowhere** — not in the HTTP
response body, not in the persisted `Notification` row (metadata only), not in the logs
(pino redacts `code`/`codeHash`). Confirm by searching the staging log stream for the
exact code you received on the device:

```bash
render logs --service meduman-api-staging --limit 500 | grep "<the 6-digit code>"
```

Expected: no match. A match means the plaintext code is sitting in a log aggregator —
treat that as a security incident, not a formatting issue.

- [ ] **Step 4: Confirm the fallback is loud, not silent**

If the transport is not bound in production, the log stub logs the code in non-prod only —
meaning in production the buyer gets **nothing**. Before promoting to prod, confirm the
transport is bound by checking a boot log line naming the real sender, not the stub.

---

## Task 8: Production cutover

Only start this when Tasks 0–7 are done and staging has completed at least one full
lifecycle including a real test-mode transfer.

- [ ] **Step 1: [HUMAN] Apply the blueprint again as the production environment**

Same repo, same `render.yaml`, separate services + separate Redis. `autoDeploy: true` on
`main` — if you want manual gating for production, turn it off here and deploy by tag.

- [ ] **Step 2: [HUMAN] Fill the production `meduman-shared` group**

Production Supabase, Paystack **live** keys, production `APP_URL`, and `FRONTEND_ORIGIN`
set to the exact production origins — comma-separated, **no wildcards**
(`main.ts:28-34` splits on comma and passes the array to `enableCors`).
Generate **fresh** `OTP_HASH_SECRET`, `EAAS_API_KEY_SECRET`, `EAAS_WEBHOOK_SIGNING_KEY` —
never reuse staging's.

- [ ] **Step 3: [HUMAN] Re-confirm the two Paystack account settings on the LIVE account**

Transfers OTP **disabled**; DVA **enabled**. Staging's settings say nothing about the live
account. Skipping this strands real money.

- [ ] **Step 4: [HUMAN] Point the live Paystack webhook at production**

`https://<prod-api-host>/webhooks/paystack`.

- [ ] **Step 5: Smoke-test production before announcing it**

Repeat Task 5 Steps 5–6 against production: `/health` 200, `/health/ready`
`{"db":true,"redis":true}`, unauthenticated route 401, forged webhook signature 401 with
nothing recorded.

- [ ] **Step 6: Confirm production data hygiene**

- `prisma/seed.ts` was never run (it self-refuses on `NODE_ENV=production`, and
  `NODE_ENV=production` is set per-service in the blueprint — verify both).
- No `Merchant` has `livemodeEnabled = true`. Every EaaS merchant stays on `sk_test`
  until legal sign-off (readiness §6). Verify:

```sql
SELECT id, name, status, "livemodeEnabled" FROM "Merchant";
```

Expected: zero rows, or every row with `livemodeEnabled = false`.

- [ ] **Step 7: Run one real live transaction at the smallest possible amount**

A genuine end-to-end: real card, real kobo, real transfer to a real bank account. Use an
amount you are willing to lose. Verify the money actually arrives, then verify the audit
trail: `AuditLog` rows for every transition, exactly one `Payout`, one Paystack transfer.

**Do not open signups until this has succeeded.**

---

## Task 9: Post-deploy monitoring

Readiness §3 lists this as open. Without it, a stuck payout is invisible until a seller
complains.

- [ ] **Step 1: Confirm Sentry is actually receiving events**

`SENTRY_DSN` is set → `initSentry` is live on API, worker, and cron. It is wired but never
runtime-verified. Trigger one deliberate non-money error (e.g. request a nonexistent
transaction id as an admin) and confirm the event lands in Sentry with the right
`environment` tag.

- [ ] **Step 2: Confirm log redaction in a live stream**

Redaction is unit-tested but never observed live. Search the production log stream for
`authorization`, `x-paystack-signature`, and `codeHash`. Expected: `[Redacted]`, never a
value. This is a security check, not a nicety — a leaked service-role key in a log is a
full database compromise.

- [ ] **Step 3: [HUMAN] Set alerts on the paths that hold money**

Minimum viable set:
- **Payout failures** — any `transfer.failed` / `transfer.reversed`. Each one means a
  transaction is frozen in `RELEASE_PROCESSING` waiting for a human.
- **Transactions stuck in `RELEASE_PROCESSING`** beyond a threshold (say 1 hour).
- **BullMQ dead jobs** — `removeOnFail` retains them; nothing currently drains or alerts.
- **Webhook error rate** on `/webhooks/paystack`.
- **`/health/ready` returning 503.**

- [ ] **Step 4: [HUMAN] Schedule the Paystack reconciliation sweep**

Readiness §3: a daily comparison of our ledger against Paystack settlements, flagging
drift. Not built yet — file it as the next work item if it will not land before launch,
and until it exists, reconcile manually each day of the soft launch.

---

## Task 10: Rehearse the rollback before you need it

- [ ] **Step 1: Rehearse a service rollback on staging**

Render → the API service → Deploys → Rollback to the previous deploy. Confirm
`/health/ready` returns 200 on the old version. Time it; write the number in the runbook.

- [ ] **Step 2: Write down the migration rollback position — and its limits**

`prisma migrate deploy` is forward-only. There are **no down migrations** in
`prisma/migrations/`. This means:

- A code rollback is safe **only** while the previous code version tolerates the new
  schema. Every migration so far has been **additive** (new tables, new nullable columns,
  new enum values), so this currently holds.
- The moment a migration is destructive (dropped column, narrowed enum — like
  `20260801100000_drop_split_fee_model` was), rolling code back **breaks**. For those, the
  recovery path is restore-from-PITR, not rollback.

Write both facts into the runbook so nobody discovers them mid-incident.

- [ ] **Step 3: Define the rollback triggers up front**

Roll back immediately, without debate, on any of:
- `/health/ready` 503 sustained past 2 minutes.
- Any webhook signature check failing open (a 200 on a forged signature).
- Any double payout, or two `Payout` rows for one transaction.
- Any transaction status changing from a source other than a signed webhook or a
  server-side verify.

The last three are money-safety-rule breaches. They are not "monitor and see" events.

---

## Task 11: Write the deploy runbook

**Files:**
- Create: `docs/DEPLOY_RUNBOOK.md`

- [ ] **Step 1: Write the runbook**

It must contain, concretely (no "see the dashboard"):

1. **Deploy procedure** — push to `main` → CI → Render autoDeploy → `preDeployCommand`
   runs `prisma migrate deploy` → smoke-test commands from Task 5 Step 5.
2. **Rollback** — the exact Render steps from Task 10, the measured rollback time, the
   forward-only-migration caveat, and the trigger list.
3. **Stuck payout** — symptom (transaction frozen in `RELEASE_PROCESSING`), diagnosis
   (check `Payout.status`, check whether Paystack has the transfer under
   `release:<txId>`), fix (`POST /admin/transactions/:id/payout/retry`, which verifies the
   prior reference at Paystack first and completes from it if it actually succeeded, else
   re-sends under `release:<txId>:r<n>`). **Never re-send by hand** — Paystack rejects a
   reused reference, and bypassing the retry endpoint bypasses rule 4.
4. **Webhook backlog** — Paystack retries over hours; `WEBHOOK_MAX_AGE_SECONDS` (86400)
   means an event older than 24h is accepted 200 but **not processed**. A long outage can
   therefore silently drop events — the recovery is replaying them from the Paystack
   dashboard, not waiting.
5. **Transfers OTP got re-enabled** — symptom (releases stall, `status: otp`), fix
   (disable it, then retry the affected payouts through the admin endpoint).
6. **DB restore** — the PITR steps recorded in Task 2 Step 5.
7. **Secret rotation** — with the two rotations that are *not* routine spelled out:
   rotating `EAAS_API_KEY_SECRET` invalidates every issued merchant API key; rotating
   `EAAS_WEBHOOK_SIGNING_KEY` orphans every stored endpoint secret.

- [ ] **Step 2: Commit**

```bash
git add docs/DEPLOY_RUNBOOK.md
git commit -m "docs: add deploy runbook (rollback, stuck payout, webhook backlog)"
git push
```

---

## Go / no-go gate

Do not open production signups until every line is true:

- [ ] CI green on `main` (Task 0).
- [ ] App boots with the blueprint's env set — no `Invalid environment variables:` (Task 1).
- [ ] All nine migrations applied to hosted Supabase; pooled runtime URL connects (Task 2).
- [ ] One real Supabase JWT verified against a protected route; `@Public()` list audited (Task 3).
- [ ] Paystack: Transfers OTP **disabled**, DVA **enabled**, one test-mode charge protected,
      one test-mode transfer released, `transfer.failed` completed nothing (Task 4).
- [ ] Staging deployed; all three services boot; forged webhook signature returns 401 with
      nothing recorded (Task 5).
- [ ] OTP transport bound and a code actually delivered — not a log line (Task 7).
- [ ] One real live transaction completed at minimum amount, with a clean audit trail (Task 8).
- [ ] Alerts live on payout failure and stuck `RELEASE_PROCESSING` (Task 9).
- [ ] Rollback rehearsed and timed; triggers written down (Task 10).
- [ ] `docs/DEPLOY_RUNBOOK.md` exists (Task 11).

**Two gates this plan cannot close:**

1. **Legal sign-off on the fund-holding model** (readiness §6). Meduman holds buyer funds
   pre-release. This is the only open item that can invalidate the design rather than
   delay it. It is a business gate, not an engineering one — no amount of deployment work
   substitutes for it.
2. **EaaS multi-tenant custody.** No external merchant gets `livemodeEnabled = true`
   until legal signs off on holding third-party-originated funds and on the merchant
   contract assigning dispute/chargeback liability. `sk_test` and the `false` default are
   the technical hold that enforces this — do not flip either to unblock a demo.

---

## Deferred — explicitly not in this plan

- **Load testing** the payment-init and webhook paths at peak (readiness §5).
- **Index review** for hot queries: status scans, the `releaseAfter` cron scan,
  idempotency-key lookups (readiness §4).
- **Outbound-webhook DNS-rebind hardening** — resolve-and-pin at send time. The current
  SSRF guard is static (literal-IP + localhost, plus the `0.0.0.0`/IPv4-mapped-IPv6 fix in
  `b5d202f`). Needed before external merchants point live URLs at us — which Task 8 Step 6
  already blocks.
- **Data-retention / PII policy** for evidence uploads and audit logs (readiness §6).
- **Dropping the dormant subaccount column and endpoint** (decision D-2 cleanup).
- **Meta and X chat adapters** — gated on external approval, not code.
