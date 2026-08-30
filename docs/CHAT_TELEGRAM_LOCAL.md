# Running the Telegram bot locally

Two ways to exercise the chat surface without deploying: a **simulator** that
plays a full conversation against your local database (no Telegram account
needed), and a **real bot** pointed at your machine through a tunnel.

---

## 1. Simulator (no credentials, no tunnel)

Drives **real Telegram Update JSON** through the real stack — dialog, state
machine, Prisma, OTP, and the signed Paystack webhook path — against the
docker-compose Postgres. Only the true external seams are faked (Paystack HTTP,
Supabase admin, the auth guard, and Telegram's outbound `send`, which is captured
into a printed transcript). A chat message can never protect a payment; the
simulator pays via a signed `charge.success` webhook, exactly as production does.

```bash
npm run db:up            # postgres:16 on :55432, redis:7 on :56379
npm run db:migrate:test  # apply migrations to the test DB
npm run chat:sim         # play the full seller → buyer → pay → deliver → release flow
```

You'll see a colour transcript: seller `/sell` → publish → `/setup_payout` →
buyer `/pay <code>` → DVA account → signed payment → protected → seller
`/delivered` → buyer receives the OTP in chat → confirms → funds move to
`RELEASE_PROCESSING` (the worker would then send the Paystack transfer).

- Engine: [`test/utils/chat-simulator.ts`](../test/utils/chat-simulator.ts)
  (lint-checked, excluded from the prod build).
- Scenario: [`scripts/chat-sim.ts`](../scripts/chat-sim.ts) — edit it to script
  other conversations (disputes, wrong OTP, mismatched amount, …).

---

## 2. Real bot (needs a bot token + a public https tunnel)

Telegram only delivers webhooks to a public **https** URL, so you need a tunnel
(ngrok, cloudflared, …) in front of the local API.

```bash
# 1. Create a bot with @BotFather, then export its token + a secret you choose:
export TELEGRAM_BOT_TOKEN=123456:ABC...
export TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 16)

# 2. Run the API + worker locally (they read the same env):
npm run dev            # API (webhook receiver)
npm run worker:dev     # worker (runs the dialog off-request)

# 3. Expose the API and point Telegram at it:
ngrok http 3000                       # -> https://<id>.ngrok.app
export APP_URL=https://<id>.ngrok.app
npm run telegram:webhook set          # registers the webhook + secret
npm run telegram:webhook info         # confirm it stuck
# npm run telegram:webhook delete     # unregister when done
```

The `secret_token` registered **must** equal `TELEGRAM_WEBHOOK_SECRET` — the
adapter rejects any update whose `X-Telegram-Bot-Api-Secret-Token` header does
not match. Helper: [`scripts/telegram-webhook.mjs`](../scripts/telegram-webhook.mjs).

### What the real bot still needs to complete a money flow

The simulator fakes these; a real bot does not:

- **Supabase** — a real project; migrations applied to the hosted DB; the
  service-role key set (chat mints an auth user on first contact).
- **Paystack** — DVA (dedicated virtual accounts) **enabled** for the in-chat pay
  path, and **Transfers OTP disabled** or automated release stalls. Nothing has
  been sent to Paystack yet, not even in test mode.

See [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) for the full go-live list.
