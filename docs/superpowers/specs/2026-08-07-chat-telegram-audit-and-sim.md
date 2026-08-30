# Chat/Telegram audit + local end-to-end simulator

Date: 2026-08-07. Goal: make the social (Telegram) parts demonstrably work
locally, and audit the chat spine for real-world bugs that unit-test fakes hide.

## Context (ground truth, verified)

- `npm run build` — clean. `npm test` — 42 suites / 325 tests green.
- `npm run lint` shows ~8k errors, ALL `Delete ␍` (CRLF). The git index is
  LF-clean; the working copy got CRLF from `core.autocrlf=true`. This is a local
  line-ending artifact, **not** a code defect, and is out of scope here.
- The chat spine is fully wired: `worker.ts` runs the `chat` queue; the Telegram
  adapter self-registers when `TELEGRAM_BOT_TOKEN`+`TELEGRAM_WEBHOOK_SECRET` are
  set; DVA payment init and OTP-to-chat delivery both exist end to end.

## Part 1 — Audit the Telegram path

Read the whole inbound → dialog → outbound path for bugs the fakes hide, and let
the simulator (Part 2) exercise the real integration to surface any. Findings
that are genuine defects get a fix + a test; design trade-offs get documented,
not silently changed. Focus areas: numeric-input/OTP routing, DVA
`charge.success` resolution + amount hard-stop, OTP reaching the *buyer's* chat,
session TTL/step leakage, adapter parse edge cases, and any real
Paystack/Supabase failure that would throw past `friendlyError`.

## Part 2 — Local end-to-end simulator

A runnable simulator that drives **real Telegram Update JSON** through the real
stack against the docker Postgres, faking only the true external seams, and
prints the conversation as a transcript so you can watch it work.

### What is real vs faked

- **Real:** HTTP-equivalent ingest (signature verify, dedupe, adapter `parse`),
  the dialog, the state machine, all Prisma writes, OTP issue/verify, the queue
  *hop* (recorded and replayed through the real processors), and the signed
  Paystack webhook path (`WebhooksService.handlePaystackEvent`, real HMAC).
- **Faked (external seams only):** Paystack HTTP (`FakePaystack`), Supabase admin
  `createUser` (deterministic uuid), the auth guard, and the Telegram outbound
  `send` (captured into a transcript instead of hitting `api.telegram.org`).

### Design

- `test/utils/chat-simulator.ts` — the engine. Boots `AppModule` like the e2e
  harness but with (a) **recording queues** for the payout/notification/chat
  tokens that capture `add(name, data)` jobs, and (b) a **capturing Telegram
  adapter** (real `verifySignature`/`parse`; `send` → sink). Exposes:
  - `fromUser(chatId, text)` → builds a Telegram Update, calls
    `inbound.ingest(...)` with the correct secret header, then **drains** the
    recorded jobs through the real processors (`processInbound`,
    `deliverOtpCode`, `outbound.deliver`) until quiescent, collecting every
    captured `send` as transcript lines.
  - `paystackChargeSuccess(customerCode, amount)` → posts a signed
    `charge.success` to `handlePaystackEvent`, then drains (this is the only way
    a payment protects — money rule 2; a chat message never can).
  - The buyer "reads" the OTP by regexing the code out of the captured OTP push,
    exactly as a real buyer would read it from chat.
- `scripts/chat-sim.ts` — loads `.env.test`, boots the engine, plays the full
  scenario (seller `/sell` → publish → buyer `/pay` → `charge.success` →
  protected → seller `/delivered` → buyer OTP → confirm → release enqueued), and
  prints a color transcript. Run: `npm run chat:sim` (needs docker Postgres up).
- `docs/CHAT_TELEGRAM_LOCAL.md` — runbook for both the simulator and graduating
  to a **real** bot via the existing `scripts/telegram-webhook.mjs` +
  ngrok/tunnel.

### Scope guard

Telegram path only. No Meta/X changes, no line-ending reformat, no new features.
The engine lives under `test/` so it is lint-checked but excluded from the prod
build (`tsconfig.build.json` excludes `test`).
