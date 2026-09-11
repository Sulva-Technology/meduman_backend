# Chat ↔ web account linking — design

**Date:** 2026-09-11
**Status:** Approved, pending implementation plan

## Goal

Let someone who already has a Meduman web account (a real Supabase auth user with
real transactions) attach their chat account to it, so a Telegram/WhatsApp/
Instagram/Messenger identity and a website identity resolve to **one** `User`.

Today they resolve to two. `ChatIdentityService.resolveOrCreate` mints a fresh
Supabase auth user on first contact with a synthetic address
(`chat+<platform>-<platformUserId>@<domain>`) and has no path to an existing
account. A seller who signs up on the website and later DMs the bot ends up with
two `User` rows: their chat-created transactions are invisible in their web
dashboard, their seller profile is split, and held funds sit under an account
they cannot log into.

The linking flow closes that. It is an **identity** feature — it re-parents rows
between two existing users. It never writes `TransactionStatus` and never moves
money.

## Non-goals

- **Unlink.** Deferred. A code is single-use, short-lived, and typed by an
  authenticated user, so mis-links are rare; the admin resolve path covers them.
- **Merging two chat identities** into each other. Only chat → web.
- **Merging two web accounts.** Only a chat-born throwaway can be absorbed.
- **Any change to the chat adapters or the dialog's happy path** beyond one new
  command.
- Frontend code — this repo is backend-only.

## Current state

| Fact | Location |
| --- | --- |
| `ChatIdentity.userId` is N:1 to `User`; unique only on `(platform, platformUserId)` | `prisma/schema.prisma:742` |
| Identity resolves in the worker on every inbound message | `chat-inbound.service.ts:106` |
| Commands dispatch from a string switch | `chat-dialog.service.ts:96` |
| Admin surface pattern: `@Roles('ADMIN')` + `@Controller('admin')` | `admin.controller.ts:11` |
| Keyed-hash crypto pattern to mirror | `otp/otp.crypto.ts` |

The schema already allows many chat identities to point at one user — only the
linking flow is missing.

## Data model

```prisma
enum ChatLinkRequestStatus {
  PENDING          // minted, not yet attempted in chat
  COMPLETED        // merge ran
  PENDING_REVIEW   // collision — needs an admin
  REJECTED         // an admin declined it
  EXPIRED          // TTL passed unused
  CANCELLED        // superseded by a newer request from the same user
}

/// Persisted conflicts only. The in-flight-payout case is transient and never
/// reaches this enum — it refuses without writing anything (see below).
enum ChatLinkConflictReason {
  SELLER_PROFILE_CONFLICT   // both users own a SellerProfile
  SELF_TRANSACTION_CONFLICT // merge would make one user both buyer and seller
}

model ChatLinkRequest {
  id     String @id @default(uuid()) @db.Uuid
  /// Keyed HMAC-SHA256 of the code. The plaintext is returned once and never stored.
  codeHash String @unique

  /// The web account that minted the code — the merge TARGET.
  targetUserId String @db.Uuid
  targetUser   User   @relation("TargetedLinkRequests", fields: [targetUserId], references: [id], onDelete: Cascade)

  /// Filled at consumption, when the chat account is known.
  platform       ChatPlatform?
  platformUserId String?
  chatIdentityId String?       @db.Uuid
  chatIdentity   ChatIdentity? @relation(fields: [chatIdentityId], references: [id], onDelete: SetNull)
  /// The absorbed chat-born account.
  sourceUserId String? @db.Uuid

  status         ChatLinkRequestStatus  @default(PENDING)
  conflictReason ChatLinkConflictReason?

  attemptCount Int       @default(0)
  expiresAt    DateTime
  consumedAt   DateTime?
  resolvedAt   DateTime?
  resolvedBy   String?   @db.Uuid  // admin id — not FK'd, see actor note

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([targetUserId, status])
  @@index([status])
  @@index([expiresAt])
  @@map("chat_link_requests")
}
```

`User` gains:

```prisma
  /// Set on an absorbed chat-born account. The row is a TOMBSTONE: it is never
  /// hard-deleted, so the historical record survives (legal retention). SetNull
  /// rather than Cascade so deleting the surviving account cannot erase the
  /// tombstone; the durable merge record lives in the append-only AuditLog.
  mergedIntoUserId String? @db.Uuid
  mergedInto       User?   @relation("AccountMerges", fields: [mergedIntoUserId], references: [id], onDelete: SetNull)
  mergedAt         DateTime?
  mergedFrom       User[]  @relation("AccountMerges")
```

Back-relation fields this requires (not columns): `User.targetedLinkRequests`,
`User.mergedFrom`, and `ChatIdentity.linkRequests`.

Two migration notes:

- No numeric columns, so no money-precision risk; every column is an id, an enum
  or a timestamp.
- Additive only: one new table, two new enums, three nullable `User` columns
  (`mergedIntoUserId`, `mergedAt`, and the relation scalar), no changes to any
  existing column or constraint.

### Why a tombstone, not a delete

`Payout.sellerId` and `Invoice.sellerId` are `Restrict` FKs (no cascade), audit
and timeline actors are polymorphic ids that must never be rewritten (rule 6),
and legal retention wants the record. So the absorbed row stays, marked
`DEACTIVATED` with `mergedIntoUserId` pointing at the survivor. Nothing
downstream needs to tolerate a missing row.

## Code generation and storage

New `chat-link.crypto.ts`, mirroring `otp.crypto.ts` exactly:

- **Alphabet:** 32 unambiguous chars — `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
  (no `0/O`, no `1/I`). Users retype these from one screen to another.
- **Length:** 8 → 32⁸ ≈ 1.1 × 10¹². Unguessable; the attempt cap is belt-and-braces.
- **Generation:** `randomInt` per character (uniform, no modulo bias).
- **At rest:** keyed HMAC-SHA256 hex, keyed by a new required `CHAT_LINK_HASH_SECRET`.
  A plain digest of an 8-char code is brute-forceable from a DB leak, so the hash
  is keyed — same reasoning as the OTP.
- **Comparison:** the existing `timingSafeEqualHex`.

New env: `CHAT_LINK_HASH_SECRET` (required, ≥32 chars), `CHAT_LINK_CODE_TTL_SECONDS`
(default `600`), `CHAT_LINK_MAX_ATTEMPTS` (default `5`).

The plaintext code exists in exactly two places: the HTTP response to the
authenticated web caller, and the user's own chat message. It is never logged,
never audited, and never persisted. Audit rows carry the `ChatLinkRequest.id`.

## Flow — web mints

`POST /chat/link-code` (authenticated, global `SupabaseJwtGuard`):

1. Cancel any `PENDING` request for this user (supersede — one live code each).
2. Mint code, store hash, `expiresAt = now + TTL`.
3. Return `{ code, expiresAt }` — **the only time the plaintext is ever returned**.
4. Audit `chat.link_code_minted` (rule 6).

Throttled tightly, same posture as the OTP routes.

Optional companion for the frontend's "connect" card: `GET /chat/link-status`
→ `{ linked: boolean, pendingCode: boolean, underReview: boolean }`. No code
material, no identity ids.

## Flow — chat consumes

New command `/connect <code>`, added to the `handleCommand` switch and to `HELP`.

```
/connect ABC123
  ↓
ChatLinkService.consume(identity, code)
  ↓
  look up by codeHash
    ├─ no match / expired / not PENDING / attempts exhausted
    │    → attemptCount++ on the matching row if one exists
    │    → GENERIC failure: "That code isn't valid. Get a fresh one
    │       from your Meduman account page."
    └─ match
         ↓
       already linked to this user? → no-op, "Already linked ✅"
         ↓
       collision checks (below)
         ├─ transient (in-flight payout) → code NOT consumed,
         │    "A payout is processing — try again in a minute."
         ├─ hard collision → status = PENDING_REVIEW, consumed,
         │    "We're reviewing this link — we'll message you here."
         └─ clean → run merge, status = COMPLETED, "Linked ✅ You'll now
              see this chat account's activity in your Meduman account."
```

**No oracle.** Every failure mode returns the same sentence, exactly as the OTP
verify path does. Whether a code exists, expired, or was used is not disclosed —
only logged and audited (`attemptCount`, generic client text).

Failure is fail-closed: anything unexpected leaves the request `PENDING` and the
code unconsumed.

## Merge algorithm

Preconditions are checked **before any write**, inside the same `$transaction`:

| Check | Reason |
| --- | --- |
| Both users own a `SellerProfile` | Two payout destinations. Picking one silently discards the other. |
| Any `Transaction` with `{sellerId, buyerId}` = the two merging ids | Would leave `buyerId == sellerId` — a structurally invalid escrow. |
| Any `Invoice` with `{sellerId, buyerId}` = the two merging ids | Same class of problem. |
| Any non-terminal `Payout` (`PENDING` / `PROCESSING`) owned by either | **Transient, handled separately — see below.** |

Then, in one `$transaction`:

1. **Re-point identities.** Every `ChatIdentity` whose `userId` is the throwaway →
   the survivor. (The consumed identity is the only one today, but a user may
   have linked Telegram *and* WhatsApp to the same throwaway.)
2. **Re-point money ownership:**
   - `Transaction.sellerId`, `Transaction.buyerId`
   - `Payout.sellerId`
   - `Invoice.sellerId`, `Invoice.buyerId`
   - `Notification.userId`
3. **Re-point functional participant references:**
   - `Dispute.openedBy`
   - `Evidence.uploadedBy`

   These are polymorphic ids rather than FKs, but they are *functional* — they
   back participant/ownership checks, so a user who raised a dispute in chat must
   still see it after linking.
4. **`Profile` (1:1, `@unique` on `userId`).** If the survivor has none, move it.
   If both have one, merge field-wise into the survivor's — fill only its null
   fields (`country`, `city`, `avatarUrl`, `bio`, `channelLinks`) — then delete
   the throwaway's. They cannot coexist.
5. **`SellerProfile` (1:1).** Only reachable in the non-collision branch, where
   the survivor has none — so move it wholesale.
6. **`User` fields.** `roleFlags` = set-union. `phone` = fill only if the
   survivor's is null. A chat-born user created with `email_confirm: false` has a
   synthetic address; the survivor's real email is never touched.
7. **Tombstone.** Throwaway → `status = DEACTIVATED`, `mergedIntoUserId` =
   survivor, `mergedAt = now()`.
8. **Audit** `chat.account_linked` with the source id, target id, platform, and a
   count of rows re-parented per table (rule 6).

### Deliberately NOT re-parented

`TimelineEvent.actorId` and `AuditLog.actorId`. Rule 6 makes these append-only
immutable history; rewriting an actor would falsify the record of who acted at
the time. They continue to reference the tombstone, which is exactly why the
tombstone is not deleted.

### The in-flight payout case

A `Payout` is sent to the recipient code looked up from the seller's
`SellerProfile` at send time. Re-parenting `Payout.sellerId` while a transfer is
mid-flight could change the destination between authorization and send.

This is transient, so it is **not** an admin-queue case: the code is left
unconsumed, no row is written, and the user is told to retry. If the code TTL
lapses first they mint a new one — cheap, and no admin involvement for what is
usually a few seconds of contention.

## Admin surface

```
GET  /admin/chat/link-requests?status=PENDING_REVIEW&cursor=&limit=
POST /admin/chat/link-requests/:id/resolve
       body: { outcome: 'COMPLETE' | 'REJECT', keepProfile?: 'TARGET' | 'SOURCE' }
```

`@Roles('ADMIN')`, throttled, every call audited.

`COMPLETE` re-runs the merge algorithm with `keepProfile` deciding the seller
profile in a `SELLER_PROFILE_CONFLICT` (delete or archive the loser — the loser's
`providerRecipientCode` is nulled, never silently reused). `SELF_TRANSACTION_CONFLICT`
is **not** resolvable by an admin — no `keepProfile` makes a valid escrow, so the
endpoint returns 409 and the request must be `REJECT`ed. `REJECT` sets
`REJECTED`, notifies the user in chat, and writes nothing else.

## Money-safety analysis

Rule-by-rule, since this feature re-parents held funds:

| Rule | Effect |
| --- | --- |
| 1 — server owns state | **Untouched.** No `TransactionStatus` write anywhere in this feature. |
| 2 — payment truth | **Untouched.** No payment-marking path. |
| 3 — valid release event | **Untouched.** No release path. |
| 4 — idempotent payout | Preserved. `release:<txId>` is keyed per transaction, not per seller, so re-parenting cannot duplicate a payout. The in-flight guard prevents a mid-send destination change. |
| 5 — dispute freezes release | Preserved. Disputes are not resolved or closed; open disputes keep blocking release regardless of which account owns them. |
| 6 — audit everything | Extended. Mint, consume-failure, link, conflict, and admin resolve each write an `AuditLog` row. Historical audit actors are never rewritten. |

The one genuinely new risk is a **destination change** under rule 4, and that is
what the in-flight payout guard exists for.

## Testing

**Unit** — `chat-link.crypto` (alphabet excludes ambiguous chars, distribution,
hash determinism, constant-time compare); code verification (expired, consumed,
attempt-capped, wrong code, superseded); the merge algorithm per table; each
collision check; the transient in-flight refusal writing nothing; `/connect`
parsing and the generic failure text.

**E2E** (`test/chat-account-linking.e2e-spec.ts`, real Postgres) — the money-
adjacent ones:

1. Link a chat-born account holding a **protected** transaction onto a web
   account → assert the transaction, its payout and its notifications now belong
   to the survivor, the tombstone is set, and **no** `TransactionStatus` changed.
2. Link an account holding a **disputed** transaction → assert the dispute is
   still `OPEN` and release is still frozen for the survivor (rule 5).
3. `SELLER_PROFILE_CONFLICT` → assert `PENDING_REVIEW`, assert **zero** rows were
   re-parented (no partial merge), assert both seller profiles are intact.
4. `SELF_TRANSACTION_CONFLICT` → same, plus the admin resolve returns 409.
5. In-flight payout → assert the code is still `PENDING`, nothing moved, and a
   retry after the payout settles succeeds.
6. Replay the same code twice → the second is a generic failure, no second merge.
7. Expired code → generic failure.
8. Admin `COMPLETE` with `keepProfile: 'TARGET'` → exactly one `SellerProfile`
   survives, the loser's recipient code is nulled, one audit row.

The first two are the ones that matter: a merge must be invisible to the state
machine and to the dispute freeze.
