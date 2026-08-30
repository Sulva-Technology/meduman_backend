# Chat bot setup

How to run the chat-native bot and drive a full protected transaction inside a
social chat. **Telegram is the only zero-approval path** — start there. WhatsApp /
Instagram / Messenger need Meta Business verification; X is a stub.

Nothing here has been proven against the real Telegram or Paystack APIs yet — the
code is tested only against faked HTTP and a local Postgres. This doc is the path
to the first real run.

---

## Architecture recap

- The API web service **only** verifies the webhook signature, dedupes the
  message, enqueues it, and returns 200.
- The **worker** runs the whole dialog (create tx, pay, OTP, release, disputes).
  **If the worker is not running, the bot receives messages and does nothing.**
- Payment is a Paystack **dedicated virtual account (DVA)**: the bot prints a bank
  account number the buyer pays by transfer; `charge.success` protects the funds.
- Chat state (`ChatSession`) is conversational only — the state machine remains
  the sole owner of `TransactionStatus`.

You therefore always run **two processes**: `npm run start` (API) and
`npm run worker`.

---

## 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`.
2. Copy the token, e.g. `123456:ABC-DEF...`.

## 2. Configure environment

Copy `.env.example` to `.env` and fill at least:

```bash
# Database (Supabase) — pooled for runtime, direct for migrations
DATABASE_URL=...
DIRECT_URL=...

# Supabase — the service-role key mints a chat user on first contact
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_ANON_KEY=...
SUPABASE_JWT_STRATEGY=jwks
SUPABASE_JWKS_URL=<SUPABASE_URL>/auth/v1/.well-known/jwks.json

# Paystack (use test keys first)
PAYSTACK_SECRET_KEY=sk_test_...
PAYSTACK_PUBLIC_KEY=pk_test_...

# Redis (BullMQ). Local default:
REDIS_URL=redis://localhost:6379

# Must be publicly reachable over HTTPS — Telegram delivers only to https.
APP_URL=https://<your-public-host>
FRONTEND_ORIGIN=https://<your-frontend-or-anything>

# OTP hashing (any 16+ char secret)
OTP_HASH_SECRET=<random-32-chars>

# Telegram — the adapter registers only when the token is present.
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
# Any long random string you invent. The webhook you register must echo it.
TELEGRAM_WEBHOOK_SECRET=<random-32-chars>
```

Leave the `META_*` / `WHATSAPP_*` / `INSTAGRAM_*` / `MESSENGER_*` vars blank to
keep those platforms disabled.

## 3. Apply migrations

```bash
npm run prisma:migrate:deploy
```

## 4. Build and start both processes

```bash
npm run build
```

In two terminals (or two Render services):

```bash
npm run start
```

```bash
npm run worker
```

For local iteration you can use `npm run dev` and `npm run worker:dev` instead.

## 5. Expose the API publicly

- **Render**: the web service is already public; set `APP_URL` to its URL.
- **Local**: tunnel it and use the tunnel URL as `APP_URL`.

```bash
npx ngrok http 3000
```

## 6. Register the Telegram webhook

With `APP_URL` and `TELEGRAM_*` exported in your shell:

```bash
npm run telegram:webhook set
```

This points Telegram at `<APP_URL>/chat/telegram/webhook` and registers
`secret_token = TELEGRAM_WEBHOOK_SECRET`. The adapter rejects any update without
the matching header, so the two values must be identical.

Check or remove it:

```bash
npm run telegram:webhook info
npm run telegram:webhook delete
```

## 7. Drive the flow in Telegram

Use two Telegram accounts (seller and buyer), or the same account playing both
where the code allows.

**Seller**

```
/start
/sell               → title → price → (description or "skip")
                      → bot returns a code and a "/pay <code>" line
/setup_payout       → reply: <bankCode> <accountNumber>   e.g.  058 0123456789
```

**Buyer**

```
/pay <code>         → bot prints a virtual account number + exact amount
(transfer the exact amount from your bank app)
```

Once Paystack fires `charge.success`, both sides get a "funds protected" push.

**Seller** then:

```
/delivered          → buyer receives a one-time code in chat
```

**Buyer** types the code back → funds release to the seller.

**Dispute + evidence** (either party, on their current transaction):

```
/dispute <reason>   → automated release freezes
(send a photo or PDF)   → attached to the dispute as evidence
"done"                  → finish
```

---

## Paystack prerequisites for the money path

The dialog works on Telegram immediately, but payment and payout need Paystack
configured:

1. **Webhook**: in the Paystack dashboard set the webhook URL to
   `<APP_URL>/webhooks/paystack`. The HMAC signature is the auth — no separate
   secret.
2. **Dedicated Virtual Accounts must be enabled** on the account (ask Paystack).
   Without DVA the in-chat bank-transfer payment cannot be created.
3. **Transfers OTP must be DISABLED**, or automated release stalls waiting for an
   out-of-band code. See [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md).

## Other platforms

- **WhatsApp / Instagram / Messenger** (one Meta app): set `META_APP_SECRET`,
  `META_VERIFY_TOKEN`, and the per-surface access token + id. The webhook lives at
  `<APP_URL>/chat/whatsapp/webhook` (or `/instagram`, `/messenger`); the `GET`
  verification handshake is handled by the adapter. Requires Meta Business
  verification and, for WhatsApp, approved message templates.
- **X**: a deliberate stub. Setting `X_ADAPTER_ENABLED=true` registers it, but it
  fails signature closed and cannot send — it needs a paid API tier first.
