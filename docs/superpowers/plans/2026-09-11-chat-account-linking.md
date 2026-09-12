# Chat ↔ web account linking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let someone with a real Meduman web account attach their Telegram/WhatsApp/Instagram/Messenger identity to it, so a chat-born throwaway account and their real account become one `User`.

**Architecture:** A web-authenticated user mints a short-lived single-use code (`POST /chat/link-code`); they type it into chat as `/connect <code>`. The chat side verifies the code, checks for hard collisions, and merges the throwaway into the real account in one Prisma `$transaction` — re-parenting identities, transactions, payouts, invoices and notifications. The absorbed row becomes a **tombstone**, never deleted. Hard collisions park as `PENDING_REVIEW` for an admin. Nothing in this feature writes `TransactionStatus` or moves money.

**Tech Stack:** NestJS + TypeScript strict, Prisma (Supabase Postgres), Node `crypto` (HMAC-SHA256), Jest, e2e against real Postgres.

**Spec:** `docs/superpowers/specs/2026-09-11-chat-web-account-linking-design.md`

## Global Constraints

- **Never write `TransactionStatus`.** This feature touches no state machine path (rule 1).
- **Never rewrite `TimelineEvent.actorId` or `AuditLog.actorId`.** They are append-only history and must keep pointing at the tombstone (rule 6).
- **Never hard-delete the absorbed `User`.** It becomes `DEACTIVATED` with `mergedIntoUserId` set — legal retention.
- The plaintext link code is never logged, never audited, never persisted. Only the keyed HMAC is stored.
- Verification failure is **generic to the client** — never disclose whether a code exists, expired, or was already consumed.
- Money is integer minor units (kobo). TypeScript strict. Path alias `@/*` → `src/*`.
- New required env: `CHAT_LINK_HASH_SECRET` (min 32 chars).
- Admin routes require `@Roles('ADMIN')`.
- Verify before "done": `npm run lint && npm run build && npm test`.

---

### Task 1: Schema — `ChatLinkRequest`, enums, and the `User` tombstone columns

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260911000000_chat_account_linking/migration.sql`

**Interfaces:**
- Produces: model `ChatLinkRequest`; enums `ChatLinkRequestStatus`, `ChatLinkConflictReason`; `User.mergedIntoUserId` / `mergedAt` / `mergedFrom` / `targetedLinkRequests`; `ChatIdentity.linkRequests`.

- [ ] **Step 1: Add the enums** to `prisma/schema.prisma`, immediately after `enum ChatPlatform` (around line 176).

```prisma
/// Lifecycle of one chat↔web account-link attempt.
enum ChatLinkRequestStatus {
  PENDING        // minted, not yet attempted in chat
  COMPLETED      // merge ran
  PENDING_REVIEW // hard collision — needs an admin
  REJECTED       // an admin declined it
  EXPIRED        // TTL passed unused
  CANCELLED      // superseded by a newer request from the same user
}

/// Persisted conflicts only. The in-flight-payout case is transient and never
/// reaches this enum — it refuses without writing anything (see ChatLinkService).
enum ChatLinkConflictReason {
  SELLER_PROFILE_CONFLICT   // both users own a SellerProfile
  SELF_TRANSACTION_CONFLICT // merge would make one user both buyer and seller
}
```

- [ ] **Step 2: Add the model** near `ChatIdentity` (around line 742).

```prisma
/// One chat↔web account-link attempt. The code is stored only as a keyed
/// HMAC-SHA256 — the plaintext is returned once to the authenticated web caller
/// and never persisted, logged or audited.
model ChatLinkRequest {
  id       String @id @default(uuid()) @db.Uuid
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
  sourceUserId   String?       @db.Uuid

  status         ChatLinkRequestStatus  @default(PENDING)
  conflictReason ChatLinkConflictReason?

  attemptCount Int       @default(0)
  expiresAt    DateTime
  consumedAt   DateTime?
  resolvedAt   DateTime?
  /// Admin id that resolved it. Not FK'd — actors span identity spaces.
  resolvedBy   String?   @db.Uuid

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([targetUserId, status])
  @@index([status])
  @@index([expiresAt])
  @@map("chat_link_requests")
}
```

- [ ] **Step 3: Add the tombstone columns and back-relations to `User`** (after `merchant` around line 239, and the relation list at line 243-251).

```prisma
  /// Set on an absorbed chat-born account. The row is a TOMBSTONE: never hard
  /// deleted, so the historical record survives (legal retention). SetNull rather
  /// than Cascade so deleting the surviving account cannot erase the tombstone;
  /// the durable merge record lives in the append-only AuditLog.
  mergedIntoUserId String?   @db.Uuid
  mergedInto       User?     @relation("AccountMerges", fields: [mergedIntoUserId], references: [id], onDelete: SetNull)
  mergedAt         DateTime?
```

and in the relation block:

```prisma
  mergedFrom           User[]            @relation("AccountMerges")
  targetedLinkRequests ChatLinkRequest[] @relation("TargetedLinkRequests")
```

- [ ] **Step 4: Add the back-relation to `ChatIdentity`** (in the relation block, near `session ChatSession?` at line 753).

```prisma
  linkRequests ChatLinkRequest[]
```

- [ ] **Step 5: Generate the migration**

Run:
```bash
npm run prisma:generate && mkdir -p prisma/migrations/20260911000000_chat_account_linking && npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20260911000000_chat_account_linking/migration.sql
```

(The `mkdir -p` is not optional — the shell redirect fails if the directory does not exist.)

Expected: the file is created and contains `CREATE TYPE "ChatLinkRequestStatus"`, `CREATE TYPE "ChatLinkConflictReason"`, `CREATE TABLE "chat_link_requests"`, and `ALTER TABLE "users" ADD COLUMN "mergedIntoUserId" UUID`. **Confirm it contains no `DROP` and no `ALTER COLUMN` on an existing column** — this migration must be purely additive. If it is not, stop and report.

- [ ] **Step 6: Apply to the local test database**

Run: `npm run db:up && npm run db:migrate:test`

Expected: the migration applies clean. Then `npm run prisma:generate`.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260911000000_chat_account_linking/
git commit -m "feat(chat-linking): schema for ChatLinkRequest and User tombstones"
```

---

### Task 2: Link-code crypto primitives

**Files:**
- Create: `src/common/crypto/timing-safe.ts`
- Create: `src/modules/chat/linking/chat-link.crypto.ts`
- Create: `src/modules/chat/linking/chat-link.crypto.spec.ts`
- Modify: `src/modules/otp/otp.crypto.ts` (re-export the moved helper)

**Interfaces:**
- Produces: `LINK_CODE_ALPHABET: string`, `generateLinkCode(length: number): string`, `hashLinkCode(code: string, secret: string): string`, `normalizeLinkCode(raw: string): string`, and `timingSafeEqualHex(a: string, b: string): boolean` (moved to `@/common/crypto/timing-safe`).

- [ ] **Step 1: Write the failing test** — `src/modules/chat/linking/chat-link.crypto.spec.ts`

```ts
import {
  LINK_CODE_ALPHABET,
  generateLinkCode,
  hashLinkCode,
  normalizeLinkCode,
} from './chat-link.crypto';
import { timingSafeEqualHex } from '@/common/crypto/timing-safe';

describe('chat-link crypto', () => {
  it('excludes the character pairs users confuse when retyping', () => {
    // The code crosses two input surfaces — read off a web page, typed into chat.
    expect(LINK_CODE_ALPHABET).not.toMatch(/[0O1I]/);
    expect(LINK_CODE_ALPHABET).toHaveLength(32);
  });

  it('generates a code of the requested length from the alphabet only', () => {
    const code = generateLinkCode(8);
    expect(code).toHaveLength(8);
    for (const ch of code) {
      expect(LINK_CODE_ALPHABET).toContain(ch);
    }
  });

  it('generates distinct codes', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateLinkCode(8)));
    // 32^8 is ~1.1e12; 200 draws colliding would mean the generator is broken.
    expect(codes.size).toBe(200);
  });

  it('hashes deterministically per (code, secret) and differs per secret', () => {
    expect(hashLinkCode('ABCD2345', 'secret-a')).toBe(hashLinkCode('ABCD2345', 'secret-a'));
    expect(hashLinkCode('ABCD2345', 'secret-a')).not.toBe(hashLinkCode('ABCD2345', 'secret-b'));
  });

  it('normalizes case and whitespace so retyping cannot decide validity', () => {
    expect(normalizeLinkCode('  abcd2345 ')).toBe('ABCD2345');
    expect(normalizeLinkCode('abcd 2345')).toBe('ABCD2345');
  });

  it('compares hex in constant time, returning false on a length mismatch', () => {
    const h = hashLinkCode('ABCD2345', 'secret-a');
    expect(timingSafeEqualHex(h, h)).toBe(true);
    expect(timingSafeEqualHex(h, hashLinkCode('ZZZZ9999', 'secret-a'))).toBe(false);
    expect(timingSafeEqualHex(h, 'ab')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/chat/linking/chat-link.crypto.spec.ts`
Expected: FAIL — `Cannot find module './chat-link.crypto'`.

- [ ] **Step 3: Move the shared helper** — create `src/common/crypto/timing-safe.ts`

`timingSafeEqualHex` is currently in `otp.crypto.ts` and is needed by both. Rather than duplicate it, move it here and re-export from its old home so existing OTP imports keep working.

```ts
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of two hex strings. Returns false (never throws) when
 * lengths differ, so a mismatched candidate can't leak timing about the stored
 * hash. Shared by the OTP and chat-link verify paths.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
```

- [ ] **Step 4: Update `src/modules/otp/otp.crypto.ts`** — delete its local `timingSafeEqualHex` definition and its now-unused `timingSafeEqual` import, and re-export instead:

```ts
import { createHmac, randomInt } from 'node:crypto';

export { timingSafeEqualHex } from '@/common/crypto/timing-safe';
```

Leave `generateNumericCode` and `hashCode` untouched.

- [ ] **Step 5: Run the OTP tests to prove the move broke nothing**

Run: `npx jest src/modules/otp`
Expected: PASS — same count as before the move.

- [ ] **Step 6: Write the implementation** — `src/modules/chat/linking/chat-link.crypto.ts`

```ts
import { createHmac, randomInt } from 'node:crypto';

/**
 * Link-code crypto primitives. Pure and dependency-free (Node crypto only), so
 * the security-critical bits are unit-testable in isolation — the same posture
 * as otp.crypto.ts.
 *
 * The plaintext is shown once to an authenticated web caller and typed by the
 * user into chat. It is NEVER stored or logged; only a keyed HMAC-SHA256 is
 * persisted (schema: `ChatLinkRequest.codeHash`). A plain digest of an 8-char
 * code is brute-forceable from a DB leak, so the hash is keyed with a server
 * secret — exactly the OTP reasoning.
 */

/**
 * Excludes 0/O and 1/I. The code is read off one screen and typed into another,
 * and those are the pairs users get wrong.
 */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A cryptographically-random code from LINK_CODE_ALPHABET. Uniform, no modulo bias. */
export function generateLinkCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += LINK_CODE_ALPHABET[randomInt(0, LINK_CODE_ALPHABET.length)];
  }
  return code;
}

/** Keyed HMAC-SHA256 of the code, hex-encoded. Deterministic per (code, secret). */
export function hashLinkCode(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code).digest('hex');
}

/**
 * Normalize user-typed input before hashing. The alphabet is uppercase-only and
 * the code crosses two input surfaces, so case and stray whitespace must not
 * decide whether a valid code works.
 */
export function normalizeLinkCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx jest src/modules/chat/linking/chat-link.crypto.spec.ts src/modules/otp`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/common/crypto/timing-safe.ts src/modules/chat/linking/chat-link.crypto.ts src/modules/chat/linking/chat-link.crypto.spec.ts src/modules/otp/otp.crypto.ts
git commit -m "feat(chat-linking): link-code crypto primitives; share timing-safe compare"
```

---

### Task 3: Env schema for the linking configuration

**Files:**
- Modify: `src/config/env.validation.ts`
- Modify: `.env.example`
- Modify: `.env.test`

**Interfaces:**
- Produces: `Env.CHAT_LINK_HASH_SECRET`, `Env.CHAT_LINK_CODE_LENGTH`, `Env.CHAT_LINK_CODE_TTL_SECONDS`, `Env.CHAT_LINK_MAX_ATTEMPTS`.

- [ ] **Step 1: Add the variables** to `envSchema` in `src/config/env.validation.ts`, after the `CHAT_SESSION_TTL_SECONDS` entry (line 97).

```ts
  /// Server-side key for the chat-link code HMAC. Required — a plain digest of an
  /// 8-char code is brute-forceable from a DB leak.
  CHAT_LINK_HASH_SECRET: z.string().min(32),
  /// Length of a link code, drawn from a 32-char unambiguous alphabet.
  CHAT_LINK_CODE_LENGTH: z.coerce.number().int().min(6).max(12).default(8),
  /// How long a minted link code stays valid.
  CHAT_LINK_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  /// Max wrong /connect attempts against one code before it locks.
  CHAT_LINK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
```

- [ ] **Step 2: Add to `.env.example` and `.env.test`**

Read both files first, then add alongside the other `CHAT_*` entries. For `.env.test` use a fixed fake value so the suite is deterministic:

```
CHAT_LINK_HASH_SECRET=test-chat-link-hash-secret-0123456789abcdef
```

- [ ] **Step 3: Verify the app still boots with the schema**

Run: `npm run build`
Expected: PASS. If `.env.test` is missing the new required secret, any test that boots `AppModule` will now fail — that is the fail-fast working as intended.

- [ ] **Step 4: Commit**

```bash
git add src/config/env.validation.ts .env.example .env.test
git commit -m "feat(chat-linking): env for link-code hashing and TTL"
```

---

### Task 4: `AccountMergeService` — collision detection and in-flight guard

**Files:**
- Create: `src/modules/chat/linking/account-merge.service.ts`
- Create: `src/modules/chat/linking/account-merge.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces: `type MergeCollisionKind = 'SELLER_PROFILE_CONFLICT' | 'SELF_TRANSACTION_CONFLICT'`; `detectCollision(sourceUserId: string, targetUserId: string, db?: MergeDb): Promise<MergeCollisionKind | null>`; `hasInFlightPayout(userIds: string[], db?: MergeDb): Promise<boolean>`.

This task builds **only the guards**. The merge itself is Task 5, so the collision logic gets its own review gate.

- [ ] **Step 1: Write the failing test** — `src/modules/chat/linking/account-merge.service.spec.ts`

```ts
import { Test } from '@nestjs/testing';
import { PrismaService } from '@/prisma/prisma.service';
import { AccountMergeService } from './account-merge.service';

const SOURCE = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';

describe('AccountMergeService guards', () => {
  let service: AccountMergeService;
  let prisma: {
    sellerProfile: { findUnique: jest.Mock };
    transaction: { findFirst: jest.Mock };
    invoice: { findFirst: jest.Mock };
    payout: { findFirst: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      sellerProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      transaction: { findFirst: jest.fn().mockResolvedValue(null) },
      invoice: { findFirst: jest.fn().mockResolvedValue(null) },
      payout: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [AccountMergeService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(AccountMergeService);
  });

  it('returns null when neither side owns a seller profile', async () => {
    await expect(service.detectCollision(SOURCE, TARGET)).resolves.toBeNull();
  });

  it('flags SELLER_PROFILE_CONFLICT when both sides own one', async () => {
    prisma.sellerProfile.findUnique.mockResolvedValue({ id: 'sp-1' });
    await expect(service.detectCollision(SOURCE, TARGET)).resolves.toBe('SELLER_PROFILE_CONFLICT');
  });

  it('allows the merge when only the source owns one', async () => {
    prisma.sellerProfile.findUnique
      .mockResolvedValueOnce({ id: 'sp-source' })
      .mockResolvedValueOnce(null);
    await expect(service.detectCollision(SOURCE, TARGET)).resolves.toBeNull();
  });

  it('flags SELF_TRANSACTION_CONFLICT when one would be both buyer and seller', async () => {
    prisma.transaction.findFirst.mockResolvedValue({ id: 'tx-1' });
    await expect(service.detectCollision(SOURCE, TARGET)).resolves.toBe('SELF_TRANSACTION_CONFLICT');
  });

  it('flags SELF_TRANSACTION_CONFLICT when the conflict is on an invoice', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 'inv-1' });
    await expect(service.detectCollision(SOURCE, TARGET)).resolves.toBe('SELF_TRANSACTION_CONFLICT');
  });

  it('treats a PENDING or PROCESSING payout as in flight', async () => {
    prisma.payout.findFirst.mockResolvedValue({ id: 'po-1' });
    await expect(service.hasInFlightPayout([SOURCE, TARGET])).resolves.toBe(true);
    const where = prisma.payout.findFirst.mock.calls[0][0].where;
    expect(where.status.in).toEqual(['PENDING', 'PROCESSING']);
  });

  it('is not in flight when every payout is terminal', async () => {
    prisma.payout.findFirst.mockResolvedValue(null);
    await expect(service.hasInFlightPayout([SOURCE, TARGET])).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/chat/linking/account-merge.service.spec.ts`
Expected: FAIL — `Cannot find module './account-merge.service'`.

- [ ] **Step 3: Write the implementation** — `src/modules/chat/linking/account-merge.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { PayoutStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

/** A collision that refuses the merge and parks it for an admin. */
export type MergeCollisionKind = 'SELLER_PROFILE_CONFLICT' | 'SELF_TRANSACTION_CONFLICT';

/**
 * Any Prisma client — the root client or a `$transaction` client. Collision
 * checks must run INSIDE the merge's transaction, or a row could be created
 * between the check and the write and slip past it.
 */
export type MergeDb = Pick<
  Prisma.TransactionClient,
  'sellerProfile' | 'transaction' | 'invoice' | 'payout'
>;

/** Payout statuses that mean a transfer may be in flight right now. */
const NON_TERMINAL_PAYOUT: PayoutStatus[] = [PayoutStatus.PENDING, PayoutStatus.PROCESSING];

/**
 * Merges an absorbed chat-born account into a real account.
 *
 * The guards live here rather than in the caller so they can run both before the
 * merge (to choose the outcome) and inside it (to close the TOCTOU window).
 */
@Injectable()
export class AccountMergeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hard collisions. Both mean the merge would produce an account the domain
   * considers invalid, so neither is auto-resolvable — the caller parks the
   * request as PENDING_REVIEW for an admin.
   */
  async detectCollision(
    sourceUserId: string,
    targetUserId: string,
    db: MergeDb = this.prisma,
  ): Promise<MergeCollisionKind | null> {
    // Two seller profiles means two payout destinations. Picking one silently
    // discards the other, which is not a decision this code should make.
    const [sourceSeller, targetSeller] = await Promise.all([
      db.sellerProfile.findUnique({ where: { userId: sourceUserId } }),
      db.sellerProfile.findUnique({ where: { userId: targetUserId } }),
    ]);
    if (sourceSeller && targetSeller) {
      return 'SELLER_PROFILE_CONFLICT';
    }

    // One user on both sides of the same escrow is structurally invalid — there
    // is no counterparty, so release has no meaning.
    const pair = [
      { sellerId: sourceUserId, buyerId: targetUserId },
      { sellerId: targetUserId, buyerId: sourceUserId },
    ];
    const selfTransaction = await db.transaction.findFirst({ where: { OR: pair } });
    if (selfTransaction) {
      return 'SELF_TRANSACTION_CONFLICT';
    }

    const selfInvoice = await db.invoice.findFirst({ where: { OR: pair } });
    if (selfInvoice) {
      return 'SELF_TRANSACTION_CONFLICT';
    }

    return null;
  }

  /**
   * Transient, not a conflict: a transfer may be mid-send, and the destination is
   * read from the seller's profile at send time. Re-parenting `Payout.sellerId`
   * underneath it could change where the money lands (rule 4). The caller refuses
   * without consuming the code so the user can simply retry.
   */
  async hasInFlightPayout(userIds: string[], db: MergeDb = this.prisma): Promise<boolean> {
    const inFlight = await db.payout.findFirst({
      where: { sellerId: { in: userIds }, status: { in: NON_TERMINAL_PAYOUT } },
    });
    return inFlight !== null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/chat/linking/account-merge.service.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/chat/linking/account-merge.service.ts src/modules/chat/linking/account-merge.service.spec.ts
git commit -m "feat(chat-linking): merge collision and in-flight-payout guards"
```

---

### Task 5: `AccountMergeService.merge` — the re-parenting transaction

**Files:**
- Modify: `src/modules/chat/linking/account-merge.service.ts`
- Modify: `src/modules/chat/linking/account-merge.service.spec.ts`
- Create: `src/modules/chat/linking/linking.errors.ts`

**Interfaces:**
- Consumes: `detectCollision`, `hasInFlightPayout` (Task 4); `AuditService`.
- Produces: `interface MergeReport`; `merge(sourceUserId, targetUserId, opts: { keepProfile?: 'TARGET' | 'SOURCE' }): Promise<MergeReport>`; errors `LinkMergeCollisionError`, `LinkMergeInFlightError`.

- [ ] **Step 1: Write the failing test** — append to `account-merge.service.spec.ts`

```ts
describe('AccountMergeService.merge', () => {
  // Uses a fake transaction client so the re-parenting contract is asserted
  // without a database. The e2e suite covers real persistence (Task 11).
  let service: AccountMergeService;
  let db: ReturnType<typeof makeTxClient>;

  function makeTxClient() {
    const updateMany = () => jest.fn().mockResolvedValue({ count: 2 });
    return {
      sellerProfile: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      transaction: { findFirst: jest.fn().mockResolvedValue(null), updateMany: updateMany() },
      invoice: { findFirst: jest.fn().mockResolvedValue(null), updateMany: updateMany() },
      payout: { findFirst: jest.fn().mockResolvedValue(null), updateMany: updateMany() },
      chatIdentity: { updateMany: updateMany() },
      notification: { updateMany: updateMany() },
      dispute: { updateMany: updateMany() },
      evidence: { updateMany: updateMany() },
      profile: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      user: {
        findUniqueOrThrow: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            roleFlags: where.id === 'src' ? ['SELLER'] : ['BUYER'],
            phone: where.id === 'src' ? '+2348000000000' : null,
          }),
        ),
        update: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
  }

  beforeEach(async () => {
    db = makeTxClient();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountMergeService,
        {
          provide: PrismaService,
          useValue: { $transaction: (fn: (c: unknown) => unknown) => fn(db) },
        },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = moduleRef.get(AccountMergeService);
  });

  it('re-parents identities, money rows, and functional participant refs', async () => {
    await service.merge('src', 'tgt');

    expect(db.chatIdentity.updateMany).toHaveBeenCalledWith({
      where: { userId: 'src' },
      data: { userId: 'tgt' },
    });
    expect(db.transaction.updateMany).toHaveBeenCalledWith({
      where: { sellerId: 'src' },
      data: { sellerId: 'tgt' },
    });
    expect(db.transaction.updateMany).toHaveBeenCalledWith({
      where: { buyerId: 'src' },
      data: { buyerId: 'tgt' },
    });
    expect(db.payout.updateMany).toHaveBeenCalledWith({
      where: { sellerId: 'src' },
      data: { sellerId: 'tgt' },
    });
    expect(db.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'src' },
      data: { userId: 'tgt' },
    });
    // Functional, not cosmetic: these back participant/ownership checks, so a
    // dispute raised in chat must stay visible to the merged account.
    expect(db.dispute.updateMany).toHaveBeenCalledWith({
      where: { openedBy: 'src' },
      data: { openedBy: 'tgt' },
    });
    expect(db.evidence.updateMany).toHaveBeenCalledWith({
      where: { uploadedBy: 'src' },
      data: { uploadedBy: 'tgt' },
    });
  });

  it('NEVER rewrites audit or timeline actors — rule 6 history is immutable', async () => {
    await service.merge('src', 'tgt');
    expect(db).not.toHaveProperty('timelineEvent');
    // The only audit write is the NEW merge row, never an update of history.
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(db.auditLog.create.mock.calls[0][0].data.action).toBe('chat.account_linked');
  });

  it('tombstones the absorbed account instead of deleting it', async () => {
    await service.merge('src', 'tgt');
    const tombstone = db.user.update.mock.calls.find(
      (c: [{ where: { id: string } }]) => c[0].where.id === 'src',
    );
    expect(tombstone[0].data).toEqual({
      status: 'DEACTIVATED',
      mergedIntoUserId: 'tgt',
      mergedAt: expect.any(Date),
    });
  });

  it('unions role flags and fills a missing phone without overwriting one', async () => {
    await service.merge('src', 'tgt');
    const survivor = db.user.update.mock.calls.find(
      (c: [{ where: { id: string } }]) => c[0].where.id === 'tgt',
    );
    expect(survivor[0].data.roleFlags.set.sort()).toEqual(['BUYER', 'SELLER']);
    expect(survivor[0].data.phone).toBe('+2348000000000');
  });

  it('moves the source profile when the target has none', async () => {
    db.profile.findUnique
      .mockResolvedValueOnce({ userId: 'src', city: 'Lagos' })
      .mockResolvedValueOnce(null);
    await service.merge('src', 'tgt');
    expect(db.profile.update).toHaveBeenCalledWith({
      where: { userId: 'src' },
      data: { userId: 'tgt' },
    });
  });

  it('merges profiles field-wise and deletes the source when both exist', async () => {
    db.profile.findUnique
      .mockResolvedValueOnce({ userId: 'src', city: 'Lagos', bio: 'from chat' })
      .mockResolvedValueOnce({ userId: 'tgt', city: 'Abuja', bio: null });
    await service.merge('src', 'tgt');
    // The survivor's own values always win; only its nulls are filled.
    expect(db.profile.update).toHaveBeenCalledWith({
      where: { userId: 'tgt' },
      data: expect.objectContaining({ city: 'Abuja', bio: 'from chat' }),
    });
    expect(db.profile.delete).toHaveBeenCalledWith({ where: { userId: 'src' } });
  });

  it('refuses and writes nothing on a hard collision', async () => {
    db.sellerProfile.findUnique.mockResolvedValue({ id: 'sp' });
    await expect(service.merge('src', 'tgt')).rejects.toThrow(LinkMergeCollisionError);
    expect(db.chatIdentity.updateMany).not.toHaveBeenCalled();
  });

  it('refuses without writing when a payout is in flight', async () => {
    db.payout.findFirst.mockResolvedValue({ id: 'po-1' });
    await expect(service.merge('src', 'tgt')).rejects.toThrow(LinkMergeInFlightError);
    expect(db.chatIdentity.updateMany).not.toHaveBeenCalled();
  });
});
```

Add these imports at the top of the spec:

```ts
import { AuditService } from '@/modules/audit/audit.service';
import { LinkMergeCollisionError, LinkMergeInFlightError } from './linking.errors';
```

(`Test`, `PrismaService` and `AccountMergeService` are already imported by Task 4's spec — this block is appended to the same file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/chat/linking/account-merge.service.spec.ts`
Expected: FAIL — `merge is not a function` and `Cannot find module './linking.errors'`.

- [ ] **Step 3: Write `src/modules/chat/linking/linking.errors.ts`**

```ts
import type { MergeCollisionKind } from './account-merge.service';

/** A hard collision — the merge is refused and parked for an admin. */
export class LinkMergeCollisionError extends Error {
  constructor(readonly kind: MergeCollisionKind) {
    super(`Account merge refused: ${kind}`);
    this.name = 'LinkMergeCollisionError';
  }
}

/**
 * Transient — a payout may be mid-send. The merge wrote nothing and the caller
 * leaves the code unconsumed so the user can retry.
 */
export class LinkMergeInFlightError extends Error {
  constructor() {
    super('Account merge refused: a payout is in flight');
    this.name = 'LinkMergeInFlightError';
  }
}
```

- [ ] **Step 4: Add `merge` to `AccountMergeService`**

Add these imports at the top of `account-merge.service.ts`:

```ts
import { ActorType, UserStatus } from '@prisma/client';
import { AuditService } from '@/modules/audit/audit.service';
import { LinkMergeCollisionError, LinkMergeInFlightError } from './linking.errors';
```

Add `private readonly audit: AuditService` to the constructor (after `prisma`). Then add:

```ts
export interface MergeReport {
  chatIdentities: number;
  transactionsSold: number;
  transactionsBought: number;
  payouts: number;
  invoicesSold: number;
  invoicesBought: number;
  notifications: number;
  disputes: number;
  evidence: number;
  profileMerged: boolean;
  sellerProfileMoved: boolean;
}
```

and:

```ts
  /**
   * Absorb `sourceUserId` into `targetUserId` in ONE transaction. Either every
   * row moves and the tombstone is set, or nothing does.
   *
   * The guards re-run inside the transaction: checking outside would leave a
   * window in which a row could be created and slip past the check.
   */
  async merge(
    sourceUserId: string,
    targetUserId: string,
    opts: { keepProfile?: 'TARGET' | 'SOURCE' } = {},
  ): Promise<MergeReport> {
    return this.prisma.$transaction(async (db) => {
      const collision = await this.detectCollision(sourceUserId, targetUserId, db);
      if (collision) {
        throw new LinkMergeCollisionError(collision);
      }
      if (await this.hasInFlightPayout([sourceUserId, targetUserId], db)) {
        throw new LinkMergeInFlightError();
      }

      const source = await db.user.findUniqueOrThrow({ where: { id: sourceUserId } });
      const target = await db.user.findUniqueOrThrow({ where: { id: targetUserId } });

      // 1. Identities. A user may have linked more than one platform to the
      //    throwaway, so this is updateMany, not a single row.
      const identities = await db.chatIdentity.updateMany({
        where: { userId: sourceUserId },
        data: { userId: targetUserId },
      });

      // 2. Money ownership travels with the account.
      const transactionsSold = await db.transaction.updateMany({
        where: { sellerId: sourceUserId },
        data: { sellerId: targetUserId },
      });
      const transactionsBought = await db.transaction.updateMany({
        where: { buyerId: sourceUserId },
        data: { buyerId: targetUserId },
      });
      const payouts = await db.payout.updateMany({
        where: { sellerId: sourceUserId },
        data: { sellerId: targetUserId },
      });
      const invoicesSold = await db.invoice.updateMany({
        where: { sellerId: sourceUserId },
        data: { sellerId: targetUserId },
      });
      const invoicesBought = await db.invoice.updateMany({
        where: { buyerId: sourceUserId },
        data: { buyerId: targetUserId },
      });
      const notifications = await db.notification.updateMany({
        where: { userId: sourceUserId },
        data: { userId: targetUserId },
      });

      // 3. Functional participant references. Polymorphic ids rather than FKs, but
      //    they back participant/ownership checks, so they must follow the
      //    account. AuditLog / TimelineEvent actors below are deliberately NOT
      //    touched — those are immutable history (rule 6).
      const disputes = await db.dispute.updateMany({
        where: { openedBy: sourceUserId },
        data: { openedBy: targetUserId },
      });
      const evidence = await db.evidence.updateMany({
        where: { uploadedBy: sourceUserId },
        data: { uploadedBy: targetUserId },
      });

      // 4. Profile is 1:1 with a unique userId — the two rows cannot coexist.
      const profileMerged = await this.mergeProfile(db, sourceUserId, targetUserId, opts);

      // 5. SellerProfile is 1:1 too. Only reachable when the target has none —
      //    two would have been a SELLER_PROFILE_CONFLICT above.
      const sourceSeller = await db.sellerProfile.findUnique({ where: { userId: sourceUserId } });
      let sellerProfileMoved = false;
      if (sourceSeller) {
        await db.sellerProfile.update({
          where: { userId: sourceUserId },
          data: { userId: targetUserId },
        });
        sellerProfileMoved = true;
      }

      // 6. Surviving user fields. The target's own values always win; the source
      //    only fills gaps.
      await db.user.update({
        where: { id: targetUserId },
        data: {
          roleFlags: { set: [...new Set([...target.roleFlags, ...source.roleFlags])] },
          ...(target.phone ?? source.phone ? { phone: target.phone ?? source.phone } : {}),
        },
      });

      // 7. Tombstone — never a hard delete (legal retention; Payout.sellerId and
      //    Invoice.sellerId are Restrict FKs, and audit actors still reference it).
      await db.user.update({
        where: { id: sourceUserId },
        data: {
          status: UserStatus.DEACTIVATED,
          mergedIntoUserId: targetUserId,
          mergedAt: new Date(),
        },
      });

      const report: MergeReport = {
        chatIdentities: identities.count,
        transactionsSold: transactionsSold.count,
        transactionsBought: transactionsBought.count,
        payouts: payouts.count,
        invoicesSold: invoicesSold.count,
        invoicesBought: invoicesBought.count,
        notifications: notifications.count,
        disputes: disputes.count,
        evidence: evidence.count,
        profileMerged,
        sellerProfileMoved,
      };

      // 8. Rule 6. The row counts make the merge auditable after the fact.
      await this.audit.log(
        {
          action: 'chat.account_linked',
          targetType: 'User',
          targetId: targetUserId,
          actorId: targetUserId,
          actorType: ActorType.USER,
          metadata: { sourceUserId, ...report },
        },
        db,
      );

      return report;
    });
  }

  /**
   * Move or fold the 1:1 profile. `keepProfile: 'SOURCE'` is the admin's explicit
   * choice in a review; the default keeps the target's values and fills only its
   * nulls.
   */
  private async mergeProfile(
    db: Prisma.TransactionClient,
    sourceUserId: string,
    targetUserId: string,
    opts: { keepProfile?: 'TARGET' | 'SOURCE' },
  ): Promise<boolean> {
    const source = await db.profile.findUnique({ where: { userId: sourceUserId } });
    if (!source) {
      return false;
    }
    const target = await db.profile.findUnique({ where: { userId: targetUserId } });

    if (!target) {
      await db.profile.update({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      return true;
    }

    const winner = opts.keepProfile === 'SOURCE' ? source : target;
    const loser = opts.keepProfile === 'SOURCE' ? target : source;

    await db.profile.update({
      where: { userId: targetUserId },
      data: {
        country: winner.country ?? loser.country,
        city: winner.city ?? loser.city,
        avatarUrl: winner.avatarUrl ?? loser.avatarUrl,
        bio: winner.bio ?? loser.bio,
        channelLinks: winner.channelLinks ?? loser.channelLinks ?? undefined,
      },
    });
    await db.profile.delete({ where: { userId: sourceUserId } });
    return true;
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/modules/chat/linking/account-merge.service.spec.ts`
Expected: PASS, 15 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/chat/linking/
git commit -m "feat(chat-linking): transactional account merge with tombstone"
```

---

### Task 6: `ChatLinkService` — mint a code

**Files:**
- Create: `src/modules/chat/linking/chat-link.service.ts`
- Create: `src/modules/chat/linking/chat-link.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `ConfigService<Env, true>`, `AuditService`, `AccountMergeService`; the crypto from Task 2; env from Task 3.
- Produces: `interface MintedLinkCode { code: string; expiresAt: Date }`; `interface LinkStatus { linked: boolean; pendingCode: boolean; underReview: boolean }`; `mint(targetUserId: string): Promise<MintedLinkCode>`; `statusFor(targetUserId: string): Promise<LinkStatus>`.

- [ ] **Step 1: Write the failing test** — `src/modules/chat/linking/chat-link.service.spec.ts`

```ts
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/modules/audit/audit.service';
import { AccountMergeService } from './account-merge.service';
import { ChatLinkService } from './chat-link.service';
import { hashLinkCode } from './chat-link.crypto';

const SECRET = 'test-chat-link-hash-secret-0123456789abcdef';
const USER = '22222222-2222-2222-2222-222222222222';

const config = {
  get: (key: string) => {
    const map: Record<string, unknown> = {
      CHAT_LINK_HASH_SECRET: SECRET,
      CHAT_LINK_CODE_LENGTH: 8,
      CHAT_LINK_CODE_TTL_SECONDS: 600,
      CHAT_LINK_MAX_ATTEMPTS: 5,
    };
    return map[key];
  },
};

describe('ChatLinkService.mint', () => {
  let service: ChatLinkService;
  let prisma: {
    chatLinkRequest: { updateMany: jest.Mock; create: jest.Mock };
  };
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    prisma = {
      chatLinkRequest: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'req-1', ...data }),
        ),
      },
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatLinkService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: AuditService, useValue: audit },
        { provide: AccountMergeService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(ChatLinkService);
  });

  it('stores only the keyed hash, never the plaintext', async () => {
    const { code } = await service.mint(USER);
    const stored = prisma.chatLinkRequest.create.mock.calls[0][0].data;
    expect(stored.codeHash).toBe(hashLinkCode(code, SECRET));
    expect(JSON.stringify(stored)).not.toContain(code);
  });

  it('supersedes any earlier pending code so only one is live', async () => {
    await service.mint(USER);
    expect(prisma.chatLinkRequest.updateMany).toHaveBeenCalledWith({
      where: { targetUserId: USER, status: 'PENDING' },
      data: { status: 'CANCELLED', resolvedAt: expect.any(Date) },
    });
  });

  it('expires the code after the configured TTL', async () => {
    const { expiresAt } = await service.mint(USER);
    const deltaMs = expiresAt.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(590_000);
    expect(deltaMs).toBeLessThanOrEqual(600_000);
  });

  it('audits the mint without the plaintext', async () => {
    await service.mint(USER);
    const entry = audit.log.mock.calls[0][0];
    expect(entry.action).toBe('chat.link_code_minted');
    expect(JSON.stringify(entry)).not.toMatch(/[A-Z2-9]{8}/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/chat/linking/chat-link.service.spec.ts`
Expected: FAIL — `Cannot find module './chat-link.service'`.

- [ ] **Step 3: Write the implementation** — `src/modules/chat/linking/chat-link.service.ts`

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ActorType,
  ChatLinkRequestStatus,
  type ChatIdentity,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/modules/audit/audit.service';
import type { Env } from '@/config/env.validation';
import { AccountMergeService } from './account-merge.service';
import { generateLinkCode, hashLinkCode, normalizeLinkCode } from './chat-link.crypto';

export interface MintedLinkCode {
  /** Plaintext — returned to the authenticated web caller exactly once. */
  code: string;
  expiresAt: Date;
}

export interface LinkStatus {
  linked: boolean;
  pendingCode: boolean;
  underReview: boolean;
}

/**
 * The chat↔web account-link boundary.
 *
 * A web-authenticated user mints a short-lived single-use code; they type it into
 * chat as `/connect <code>`. Verification is generic to the client (no oracle):
 * whether a code exists, expired, or was consumed is never disclosed — only
 * logged and audited, exactly as the OTP verify path does.
 */
@Injectable()
export class ChatLinkService {
  private readonly logger = new Logger(ChatLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly merge: AccountMergeService,
  ) {}

  /**
   * Mint a link code for a web account. Any earlier live code is superseded —
   * one live code per user keeps the surface small and the retry obvious.
   */
  async mint(targetUserId: string): Promise<MintedLinkCode> {
    await this.prisma.chatLinkRequest.updateMany({
      where: { targetUserId, status: ChatLinkRequestStatus.PENDING },
      data: { status: ChatLinkRequestStatus.CANCELLED, resolvedAt: new Date() },
    });

    const code = generateLinkCode(this.config.get('CHAT_LINK_CODE_LENGTH', { infer: true }));
    const ttlSeconds = this.config.get('CHAT_LINK_CODE_TTL_SECONDS', { infer: true });
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const request = await this.prisma.chatLinkRequest.create({
      data: {
        codeHash: hashLinkCode(code, this.config.get('CHAT_LINK_HASH_SECRET', { infer: true })),
        targetUserId,
        expiresAt,
      },
    });

    // Never the plaintext (rule 6 keeps the action, not the secret).
    await this.audit.log({
      action: 'chat.link_code_minted',
      targetType: 'ChatLinkRequest',
      targetId: request.id,
      actorId: targetUserId,
      actorType: ActorType.USER,
    });

    return { code, expiresAt };
  }

  /** Non-secret state for the frontend's "connect" card. */
  async statusFor(targetUserId: string): Promise<LinkStatus> {
    const [linked, pending, review] = await Promise.all([
      this.prisma.chatIdentity.count({ where: { userId: targetUserId } }),
      this.prisma.chatLinkRequest.count({
        where: { targetUserId, status: ChatLinkRequestStatus.PENDING },
      }),
      this.prisma.chatLinkRequest.count({
        where: { targetUserId, status: ChatLinkRequestStatus.PENDING_REVIEW },
      }),
    ]);
    return { linked: linked > 0, pendingCode: pending > 0, underReview: review > 0 };
  }
}
```

Add the unused-import cleanup: `ChatIdentity` and `normalizeLinkCode` are used by Task 7 — if lint flags them now, temporarily omit them from the import list in this task and re-add in Task 7.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/chat/linking/chat-link.service.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/chat/linking/chat-link.service.ts src/modules/chat/linking/chat-link.service.spec.ts
git commit -m "feat(chat-linking): mint a single-use link code"
```

---

### Task 7: `ChatLinkService.consume` — verify and merge

**Files:**
- Modify: `src/modules/chat/linking/chat-link.service.ts`
- Modify: `src/modules/chat/linking/chat-link.service.spec.ts`

**Interfaces:**
- Consumes: `AccountMergeService.merge`, `.detectCollision`, `.hasInFlightPayout`.
- Produces: `type ConsumeOutcome`; `consume(identity: ChatIdentity, rawCode: string): Promise<ConsumeOutcome>`.

- [ ] **Step 1: Write the failing test** — append to `chat-link.service.spec.ts`

```ts
const IDENTITY = { id: 'id-1', userId: 'src-user', platform: 'TELEGRAM', platformUserId: '555' };

describe('ChatLinkService.consume', () => {
  let service: ChatLinkService;
  let prisma: { chatLinkRequest: Record<string, jest.Mock> };
  let merge: {
    detectCollision: jest.Mock;
    hasInFlightPayout: jest.Mock;
    merge: jest.Mock;
  };
  let audit: { log: jest.Mock };

  function pendingRequest(over: Record<string, unknown> = {}) {
    return {
      id: 'req-1',
      status: 'PENDING',
      attemptCount: 0,
      expiresAt: new Date(Date.now() + 60_000),
      targetUserId: 'tgt-user',
      codeHash: hashLinkCode('ABCD2345', SECRET),
      ...over,
    };
  }

  beforeEach(async () => {
    prisma = {
      chatLinkRequest: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(pendingRequest()),
      },
    };
    merge = {
      detectCollision: jest.fn().mockResolvedValue(null),
      hasInFlightPayout: jest.fn().mockResolvedValue(false),
      merge: jest.fn().mockResolvedValue({ chatIdentities: 1 }),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatLinkService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: AuditService, useValue: audit },
        { provide: AccountMergeService, useValue: merge },
      ],
    }).compile();
    service = moduleRef.get(ChatLinkService);
  });

  it('links on a valid code and marks the request consumed', async () => {
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'LINKED',
      platform: 'TELEGRAM',
    });
    expect(merge.merge).toHaveBeenCalledWith('src-user', 'tgt-user', {});
    expect(prisma.chatLinkRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    });
  });

  it('normalizes case and whitespace before hashing', async () => {
    await service.consume(IDENTITY as never, '  abcd2345 ');
    expect(merge.merge).toHaveBeenCalled();
  });

  it('returns INVALID for an unknown code and merges nothing', async () => {
    prisma.chatLinkRequest.findUnique.mockResolvedValue(null);
    await expect(service.consume(IDENTITY as never, 'ZZZZ9999')).resolves.toEqual({
      status: 'INVALID',
    });
    expect(merge.merge).not.toHaveBeenCalled();
  });

  it('returns INVALID for an expired code without merging', async () => {
    prisma.chatLinkRequest.findUnique.mockResolvedValue(
      pendingRequest({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'INVALID',
    });
    expect(merge.merge).not.toHaveBeenCalled();
  });

  it('returns INVALID once the attempt cap is reached', async () => {
    prisma.chatLinkRequest.findUnique.mockResolvedValue(pendingRequest({ attemptCount: 5 }));
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'INVALID',
    });
  });

  it('counts a failed attempt on a real row so brute force is visible', async () => {
    prisma.chatLinkRequest.findUnique.mockResolvedValue(
      pendingRequest({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await service.consume(IDENTITY as never, 'ABCD2345');
    expect(prisma.chatLinkRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { attemptCount: { increment: 1 } },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'chat.link_code_rejected' }),
    );
  });

  it('never discloses why a code failed', async () => {
    prisma.chatLinkRequest.findUnique.mockResolvedValue(null);
    const unknown = await service.consume(IDENTITY as never, 'ZZZZ9999');
    prisma.chatLinkRequest.findUnique.mockResolvedValue(
      pendingRequest({ expiresAt: new Date(Date.now() - 1000) }),
    );
    const expired = await service.consume(IDENTITY as never, 'ABCD2345');
    // Same outcome for both — an attacker cannot tell a real code from a wrong one.
    expect(unknown).toEqual(expired);
  });

  it('is a no-op when the identity is already on the target account', async () => {
    prisma.chatLinkRequest.findUnique.mockResolvedValue(
      pendingRequest({ targetUserId: 'src-user' }),
    );
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'ALREADY_LINKED',
    });
    expect(merge.merge).not.toHaveBeenCalled();
  });

  it('parks a hard collision for review and does not merge', async () => {
    merge.detectCollision.mockResolvedValue('SELLER_PROFILE_CONFLICT');
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'PENDING_REVIEW',
      reason: 'SELLER_PROFILE_CONFLICT',
    });
    expect(merge.merge).not.toHaveBeenCalled();
    expect(prisma.chatLinkRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: expect.objectContaining({
        status: 'PENDING_REVIEW',
        conflictReason: 'SELLER_PROFILE_CONFLICT',
      }),
    });
  });

  it('refuses transiently on an in-flight payout and leaves the code unconsumed', async () => {
    merge.hasInFlightPayout.mockResolvedValue(true);
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'RETRY',
    });
    // Crucially NOT consumed — the user retries the same code in a minute.
    expect(prisma.chatLinkRequest.update).not.toHaveBeenCalled();
  });

  it('leaves the code live when the merge itself reports an in-flight race', async () => {
    merge.merge.mockRejectedValue(new LinkMergeInFlightError());
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'RETRY',
    });
  });

  it('leaves the code live when the merge reports a collision race', async () => {
    merge.merge.mockRejectedValue(new LinkMergeCollisionError('SELF_TRANSACTION_CONFLICT'));
    await expect(service.consume(IDENTITY as never, 'ABCD2345')).resolves.toEqual({
      status: 'PENDING_REVIEW',
      reason: 'SELF_TRANSACTION_CONFLICT',
    });
  });
});
```

Add to the spec's imports:

```ts
import { LinkMergeCollisionError, LinkMergeInFlightError } from './linking.errors';
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/chat/linking/chat-link.service.spec.ts`
Expected: FAIL — `consume is not a function`.

- [ ] **Step 3: Add `consume` to `ChatLinkService`**

Add imports: `ChatLinkConflictReason`, `ChatLinkRequestStatus`, `type ChatIdentity` from `@prisma/client`; `LinkMergeCollisionError`, `LinkMergeInFlightError` from `./linking.errors`; `normalizeLinkCode` from `./chat-link.crypto`.

```ts
export type ConsumeOutcome =
  | { status: 'LINKED'; platform: ChatPlatform }
  | { status: 'ALREADY_LINKED' }
  | { status: 'PENDING_REVIEW'; reason: ChatLinkConflictReason }
  | { status: 'RETRY' }
  | { status: 'INVALID' };
```

```ts
  /**
   * Verify a code typed into chat and, on success, merge the chat-born account
   * into the web account that minted it.
   *
   * Failure is deliberately uniform: every rejection returns INVALID, so a caller
   * cannot learn whether a code exists, expired, or was already used. The precise
   * reason goes to the log and the audit trail instead.
   */
  async consume(identity: ChatIdentity, rawCode: string): Promise<ConsumeOutcome> {
    const maxAttempts = this.config.get('CHAT_LINK_MAX_ATTEMPTS', { infer: true });
    const codeHash = hashLinkCode(
      normalizeLinkCode(rawCode),
      this.config.get('CHAT_LINK_HASH_SECRET', { infer: true }),
    );

    const request = await this.prisma.chatLinkRequest.findUnique({ where: { codeHash } });

    const reject = async (reason: string): Promise<ConsumeOutcome> => {
      this.logger.warn(`Link code rejected (${reason}) for ${identity.platform}:${identity.platformUserId}`);
      if (request) {
        // Count the attempt on a real row so a brute-force run is visible.
        await this.prisma.chatLinkRequest.update({
          where: { id: request.id },
          data: { attemptCount: { increment: 1 } },
        });
        await this.audit.log({
          action: 'chat.link_code_rejected',
          targetType: 'ChatLinkRequest',
          targetId: request.id,
          actorId: identity.id,
          actorType: ActorType.USER,
          reason,
          metadata: { platform: identity.platform },
        });
      }
      return { status: 'INVALID' };
    };

    if (!request) {
      return reject('unknown code');
    }
    if (request.status !== ChatLinkRequestStatus.PENDING) {
      return reject(`status ${request.status}`);
    }
    if (request.expiresAt <= new Date()) {
      return reject('expired');
    }
    if (request.attemptCount >= maxAttempts) {
      return reject('attempt cap reached');
    }

    const targetUserId = request.targetUserId;

    // Already on this account — nothing to do, but consume so the code can't be
    // replayed against a different identity later.
    if (identity.userId === targetUserId) {
      await this.consumeAs(request.id, {
        status: ChatLinkRequestStatus.COMPLETED,
        platform: identity.platform,
        platformUserId: identity.platformUserId,
        chatIdentityId: identity.id,
        sourceUserId: identity.userId,
      });
      return { status: 'ALREADY_LINKED' };
    }

    // Transient check BEFORE the merge: a payout may be mid-send, and the transfer
    // destination is read from the seller's profile at send time (rule 4). Write
    // nothing and leave the code live so the user can retry.
    if (await this.merge.hasInFlightPayout([identity.userId, targetUserId])) {
      this.logger.warn(`Link deferred — payout in flight for ${identity.userId}/${targetUserId}`);
      return { status: 'RETRY' };
    }

    const collision = await this.merge.detectCollision(identity.userId, targetUserId);
    if (collision) {
      await this.consumeAs(request.id, {
        status: ChatLinkRequestStatus.PENDING_REVIEW,
        conflictReason: collision as ChatLinkConflictReason,
        platform: identity.platform,
        platformUserId: identity.platformUserId,
        chatIdentityId: identity.id,
        sourceUserId: identity.userId,
      });
      return { status: 'PENDING_REVIEW', reason: collision as ChatLinkConflictReason };
    }

    try {
      const report = await this.merge.merge(identity.userId, targetUserId);
      await this.consumeAs(request.id, {
        status: ChatLinkRequestStatus.COMPLETED,
        platform: identity.platform,
        platformUserId: identity.platformUserId,
        chatIdentityId: identity.id,
        sourceUserId: identity.userId,
      });
      this.logger.log(
        `Linked ${identity.platform}:${identity.platformUserId} → ${targetUserId} (${report.chatIdentities} identities)`,
      );
      return { status: 'LINKED', platform: identity.platform };
    } catch (err) {
      // The guards re-run inside the merge transaction, so a row created between
      // the checks above and the write surfaces here. Neither is a permanent
      // failure — leave the code live and let the user retry.
      if (err instanceof LinkMergeInFlightError) {
        return { status: 'RETRY' };
      }
      if (err instanceof LinkMergeCollisionError) {
        await this.consumeAs(request.id, {
          status: ChatLinkRequestStatus.PENDING_REVIEW,
          conflictReason: err.kind as ChatLinkConflictReason,
          platform: identity.platform,
          platformUserId: identity.platformUserId,
          chatIdentityId: identity.id,
          sourceUserId: identity.userId,
        });
        return { status: 'PENDING_REVIEW', reason: err.kind as ChatLinkConflictReason };
      }
      throw err;
    }
  }

  /** Mark a request consumed and record the chat side that consumed it. */
  private async consumeAs(
    id: string,
    data: {
      status: ChatLinkRequestStatus;
      platform: ChatPlatform;
      platformUserId: string;
      chatIdentityId: string;
      sourceUserId: string;
      conflictReason?: ChatLinkConflictReason;
    },
  ): Promise<void> {
    await this.prisma.chatLinkRequest.update({
      where: { id },
      data: {
        status: data.status,
        platform: data.platform,
        platformUserId: data.platformUserId,
        chatIdentityId: data.chatIdentityId,
        sourceUserId: data.sourceUserId,
        consumedAt: new Date(),
        resolvedAt: new Date(),
        ...(data.conflictReason ? { conflictReason: data.conflictReason } : {}),
      },
    });
  }
```

Add `ChatPlatform` to the `@prisma/client` import.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/modules/chat/linking/chat-link.service.spec.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/chat/linking/chat-link.service.ts src/modules/chat/linking/chat-link.service.spec.ts
git commit -m "feat(chat-linking): verify a link code and merge the account"
```

---

### Task 8: `/connect` command in the dialog

**Files:**
- Modify: `src/modules/chat/dialog/chat-dialog.service.ts`
- Modify: `src/modules/chat/dialog/chat-dialog.service.spec.ts`
- Modify: `src/modules/chat/chat.module.ts`

**Interfaces:**
- Consumes: `ChatLinkService.consume` (Task 7).
- Produces: the `/connect <code>` command and its `HELP` entry.

- [ ] **Step 1: Write the failing test** — add to `chat-dialog.service.spec.ts`

Find the existing `Test.createTestingModule` provider list and add a `ChatLinkService` mock alongside the others:

```ts
{ provide: ChatLinkService, useValue: linksMock },
```

with, in the spec's shared setup:

```ts
const linksMock = { consume: jest.fn() };
```

Then add the tests:

```ts
describe('ChatDialogService /connect', () => {
  it('links on a valid code', async () => {
    linksMock.consume.mockResolvedValue({ status: 'LINKED', platform: 'TELEGRAM' });
    const reply = await service.handle(identity, user, session, {
      platform: 'TELEGRAM',
      providerMessageId: 'm1',
      from: '555',
      text: '/connect ABCD2345',
    } as never);
    expect(linksMock.consume).toHaveBeenCalledWith(identity, 'ABCD2345');
    expect(reply.text).toContain('Linked');
  });

  it('asks for the code when none is given', async () => {
    const reply = await service.handle(identity, user, session, {
      platform: 'TELEGRAM',
      providerMessageId: 'm2',
      from: '555',
      text: '/connect',
    } as never);
    expect(linksMock.consume).not.toHaveBeenCalled();
    expect(reply.text).toContain('/connect');
  });

  it('never discloses why a code failed', async () => {
    linksMock.consume.mockResolvedValue({ status: 'INVALID' });
    const reply = await service.handle(identity, user, session, {
      platform: 'TELEGRAM',
      providerMessageId: 'm3',
      from: '555',
      text: '/connect ZZZZ9999',
    } as never);
    expect(reply.text).not.toMatch(/expired|already used|no such/i);
    expect(reply.text).toContain("isn't valid");
  });

  it('explains a transient refusal and invites a retry', async () => {
    linksMock.consume.mockResolvedValue({ status: 'RETRY' });
    const reply = await service.handle(identity, user, session, {
      platform: 'TELEGRAM',
      providerMessageId: 'm4',
      from: '555',
      text: '/connect ABCD2345',
    } as never);
    expect(reply.text).toMatch(/try .*again/i);
  });

  it('says a collision is under review rather than failing', async () => {
    linksMock.consume.mockResolvedValue({ status: 'PENDING_REVIEW', reason: 'SELLER_PROFILE_CONFLICT' });
    const reply = await service.handle(identity, user, session, {
      platform: 'TELEGRAM',
      providerMessageId: 'm5',
      from: '555',
      text: '/connect ABCD2345',
    } as never);
    expect(reply.text).toMatch(/review/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/chat/dialog`
Expected: FAIL — `Unknown command` / `consume` never called.

- [ ] **Step 3: Add the command** — in `chat-dialog.service.ts`

Add to `HELP`, after the buyer's `/pay` line:

```ts
  '  /connect <code> — link this chat to your Meduman account',
```

Add to the `handleCommand` switch (line 126, before `/dispute`):

```ts
      case '/connect':
        return this.connectAccount(identity, arg);
```

Add the handler method:

```ts
  /**
   * Link this chat account to the web account that minted the code. The reply is
   * deliberately uninformative on failure — the same sentence whether the code
   * was wrong, expired or already used — so the chat is not an oracle for
   * guessing codes.
   */
  private async connectAccount(
    identity: ChatIdentity,
    arg: string,
  ): Promise<OutboundChatMessage> {
    if (!arg) {
      return {
        text: 'Send the code from your Meduman account page, e.g. /connect ABCD2345',
      };
    }

    const outcome = await this.links.consume(identity, arg);

    switch (outcome.status) {
      case 'LINKED':
        return {
          text: "Linked ✅ This chat is now connected to your Meduman account — you'll see its transactions in your dashboard.",
        };
      case 'ALREADY_LINKED':
        return { text: 'Already linked ✅' };
      case 'PENDING_REVIEW':
        return {
          text: "This chat account has activity we need to review before linking — we'll message you here shortly.",
        };
      case 'RETRY':
        return { text: 'A payout is processing right now — try that code again in a minute.' };
      case 'INVALID':
        return { text: "That code isn't valid. Get a fresh one from your Meduman account page." };
    }
  }
```

Add `private readonly links: ChatLinkService` to the constructor (after `evidence`), and the import:

```ts
import { ChatLinkService } from '../linking/chat-link.service';
```

- [ ] **Step 4: Register the providers** — in `chat.module.ts`

Add imports and provider entries:

```ts
import { AccountMergeService } from './linking/account-merge.service';
import { ChatLinkService } from './linking/chat-link.service';
```

```ts
    AccountMergeService,
    ChatLinkService,
```

and add `ChatLinkService` to the module's `exports`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/chat`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/chat/dialog src/modules/chat/chat.module.ts
git commit -m "feat(chat-linking): /connect command in the bot dialog"
```

---

### Task 9: Web endpoints — mint a code, read link status

**Files:**
- Create: `src/modules/chat/linking/chat-link.controller.ts`
- Create: `src/modules/chat/linking/chat-link.controller.spec.ts`
- Modify: `src/modules/chat/chat.module.ts`

**Interfaces:**
- Consumes: `ChatLinkService.mint`, `.statusFor` (Task 6).
- Produces: `POST /chat/link-code` → `{ code: string; expiresAt: string }`; `GET /chat/link-status` → `LinkStatus`.

- [ ] **Step 1: Write the failing test** — `chat-link.controller.spec.ts`

```ts
import { ChatLinkController } from './chat-link.controller';
import type { ChatLinkService } from './chat-link.service';

describe('ChatLinkController', () => {
  const links = {
    mint: jest.fn().mockResolvedValue({ code: 'ABCD2345', expiresAt: new Date('2026-09-11T12:00:00Z') }),
    statusFor: jest.fn().mockResolvedValue({ linked: false, pendingCode: true, underReview: false }),
  };
  const controller = new ChatLinkController(links as unknown as ChatLinkService);
  const claims = { sub: 'user-1' } as never;

  it('returns the plaintext code exactly once, with an ISO expiry', async () => {
    await expect(controller.mint(claims)).resolves.toEqual({
      code: 'ABCD2345',
      expiresAt: '2026-09-11T12:00:00.000Z',
    });
    expect(links.mint).toHaveBeenCalledWith('user-1');
  });

  it('never returns code material from the status route', async () => {
    const status = await controller.status(claims);
    expect(status).toEqual({ linked: false, pendingCode: true, underReview: false });
    expect(JSON.stringify(status)).not.toMatch(/[A-Z2-9]{8}/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/chat/linking/chat-link.controller.spec.ts`
Expected: FAIL — `Cannot find module './chat-link.controller'`.

- [ ] **Step 3: Write the implementation** — `chat-link.controller.ts`

```ts
import { Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { ChatLinkService, type LinkStatus } from './chat-link.service';

/**
 * The web side of account linking. Both routes are authenticated by the global
 * SupabaseJwtGuard — the caller can only ever act on their own account.
 *
 * `mint` is the ONLY place a plaintext link code is ever returned. It is not
 * logged, not audited, and not recoverable afterwards.
 */
@Controller('chat')
export class ChatLinkController {
  constructor(private readonly links: ChatLinkService) {}

  /** Mint a link code to type into the bot as `/connect <code>`. */
  // Tight limit: codes are single-use, so minting is inherently rare.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('link-code')
  async mint(
    @CurrentUser() claims: SupabaseJwtClaims,
  ): Promise<{ code: string; expiresAt: string }> {
    const { code, expiresAt } = await this.links.mint(claims.sub);
    return { code, expiresAt: expiresAt.toISOString() };
  }

  /** Non-secret link state for the frontend's "connect" card. */
  @Get('link-status')
  async status(@CurrentUser() claims: SupabaseJwtClaims): Promise<LinkStatus> {
    return this.links.statusFor(claims.sub);
  }
}
```

- [ ] **Step 4: Register the controller** — add `ChatLinkController` to `controllers` in `chat.module.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/chat/linking`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/chat/linking/chat-link.controller.ts src/modules/chat/linking/chat-link.controller.spec.ts src/modules/chat/chat.module.ts
git commit -m "feat(chat-linking): POST /chat/link-code and GET /chat/link-status"
```

---

### Task 10: Admin surface — review queue and resolve

**Files:**
- Create: `src/modules/chat/linking/dto/resolve-link-request.dto.ts`
- Create: `src/modules/chat/linking/chat-link-admin.controller.ts`
- Create: `src/modules/chat/linking/chat-link-admin.controller.spec.ts`
- Modify: `src/modules/chat/linking/chat-link.service.ts`
- Modify: `src/modules/chat/chat.module.ts`

**Interfaces:**
- Consumes: `AccountMergeService.merge`, `.detectCollision`.
- Produces: `listForReview(filter)`; `resolve(id, dto, adminId)`; `GET /admin/chat/link-requests`; `POST /admin/chat/link-requests/:id/resolve`.

The admin controller lives in the feature module, matching the existing
`src/modules/merchants/admin-merchants.controller.ts` precedent.

- [ ] **Step 1: Write the failing test** — `resolve-link-request.dto.spec.ts` behaviour is covered in the controller spec; write `chat-link-admin.controller.spec.ts`

```ts
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ChatLinkAdminController } from './chat-link-admin.controller';
import type { ChatLinkService } from './chat-link.service';

describe('ChatLinkAdminController', () => {
  const links = {
    listForReview: jest.fn(),
    resolve: jest.fn(),
  };
  const controller = new ChatLinkAdminController(links as unknown as ChatLinkService);
  const admin = { sub: 'admin-1' } as never;

  it('lists review requests', async () => {
    links.listForReview.mockResolvedValue({ items: [], nextCursor: null });
    await expect(controller.list({})).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('completes a request with an explicit winning profile', async () => {
    links.resolve.mockResolvedValue({ status: 'COMPLETED' });
    await expect(
      controller.resolve('req-1', { outcome: 'COMPLETE', keepProfile: 'TARGET' }, admin),
    ).resolves.toEqual({ status: 'COMPLETED' });
    expect(links.resolve).toHaveBeenCalledWith('req-1', 'COMPLETE', {
      keepProfile: 'TARGET',
      adminId: 'admin-1',
    });
  });

  it('surfaces a self-transaction conflict as 409 — no profile choice can fix it', async () => {
    links.resolve.mockRejectedValue(
      new ConflictException('SELF_TRANSACTION_CONFLICT cannot be resolved by choosing a profile'),
    );
    await expect(
      controller.resolve('req-1', { outcome: 'COMPLETE' }, admin),
    ).rejects.toThrow(ConflictException);
  });

  it('404s an unknown request', async () => {
    links.resolve.mockRejectedValue(new NotFoundException('Link request not found'));
    await expect(controller.resolve('nope', { outcome: 'REJECT' }, admin)).rejects.toThrow(
      NotFoundException,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/modules/chat/linking/chat-link-admin.controller.spec.ts`
Expected: FAIL — `Cannot find module './chat-link-admin.controller'`.

- [ ] **Step 3: Write the DTO** — `dto/resolve-link-request.dto.ts`

```ts
import { IsIn, IsOptional } from 'class-validator';

export class ResolveLinkRequestDto {
  /** COMPLETE runs the merge; REJECT closes it having written nothing. */
  @IsIn(['COMPLETE', 'REJECT'])
  outcome!: 'COMPLETE' | 'REJECT';

  /** Which SellerProfile survives a SELLER_PROFILE_CONFLICT. Required for COMPLETE on that reason. */
  @IsOptional()
  @IsIn(['TARGET', 'SOURCE'])
  keepProfile?: 'TARGET' | 'SOURCE';
}
```

Check an existing DTO in the repo (e.g. `src/modules/users/dto/update-seller-profile.dto.ts`) for the exact decorator style and match it.

- [ ] **Step 4: Write the controller** — `chat-link-admin.controller.ts`

```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Roles } from '@/modules/auth';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { ChatLinkService } from './chat-link.service';
import { ResolveLinkRequestDto } from './dto/resolve-link-request.dto';

/**
 * Admin review queue for link requests that hit a hard collision. Every route
 * requires the ADMIN app role (rule 6 — an admin action is always audited).
 */
@Roles('ADMIN')
@Controller('admin/chat/link-requests')
export class ChatLinkAdminController {
  constructor(private readonly links: ChatLinkService) {}

  @Get()
  list(@Query() query: { status?: string; cursor?: string; limit?: string }) {
    return this.links.listForReview(query);
  }

  /** Resolve a parked request: complete the merge, or reject it. */
  @Post(':id/resolve')
  resolve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ResolveLinkRequestDto,
    @CurrentUser() claims: SupabaseJwtClaims,
  ) {
    return this.links.resolve(id, dto.outcome, {
      ...(dto.keepProfile ? { keepProfile: dto.keepProfile } : {}),
      adminId: claims.sub,
    });
  }
}
```

- [ ] **Step 5: Add `listForReview` and `resolve` to `ChatLinkService`**

```ts
  /** Parked link requests, newest first — the admin review queue. */
  async listForReview(filter: {
    status?: string;
    cursor?: string;
    limit?: string;
  }): Promise<{ items: LinkRequestView[]; nextCursor: string | null }> {
    const take = Math.min(Number(filter.limit) || 50, 100);
    const rows = await this.prisma.chatLinkRequest.findMany({
      where: {
        status: (filter.status as ChatLinkRequestStatus) ?? ChatLinkRequestStatus.PENDING_REVIEW,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    });
    // `codeHash` never leaves the service: an admin has no use for it, and a
    // keyed hash in an API response is secret-adjacent material that does not
    // need to travel.
    const items: LinkRequestView[] = rows
      .slice(0, take)
      .map(({ codeHash: _codeHash, ...rest }) => rest);
    const nextCursor = rows.length > take ? (items.at(-1)?.id ?? null) : null;
    return { items, nextCursor };
  }
```

Declare the view type at module scope, next to `MintedLinkCode`:

```ts
/** A link request as the admin API returns it — never the code hash. */
export type LinkRequestView = Omit<ChatLinkRequest, 'codeHash'>;
```

The `take + 1` / `slice` / `last-id` pagination matches `admin.service.ts`'s existing pattern rather than inventing a second one.

  /**
   * Resolve a parked request. COMPLETE re-runs the merge with the admin's chosen
   * winning profile; REJECT closes it having written nothing else.
   *
   * SELF_TRANSACTION_CONFLICT is NOT resolvable — no choice of profile makes one
   * user a valid counterparty to themselves, so it returns 409 and must be
   * rejected instead.
   */
  async resolve(
    id: string,
    outcome: 'COMPLETE' | 'REJECT',
    opts: { keepProfile?: 'TARGET' | 'SOURCE'; adminId: string },
  ): Promise<{ status: ChatLinkRequestStatus }> {
    const request = await this.prisma.chatLinkRequest.findUnique({ where: { id } });
    if (!request) {
      throw new NotFoundException(`Link request ${id} not found`);
    }
    if (request.status !== ChatLinkRequestStatus.PENDING_REVIEW) {
      throw new ConflictException(`Link request is ${request.status}, not PENDING_REVIEW`);
    }
    if (!request.sourceUserId || !request.chatIdentityId) {
      throw new ConflictException('Link request has no chat side to merge');
    }

    if (outcome === 'REJECT') {
      await this.prisma.chatLinkRequest.update({
        where: { id },
        data: { status: ChatLinkRequestStatus.REJECTED, resolvedAt: new Date(), resolvedBy: opts.adminId },
      });
      await this.audit.log({
        action: 'chat.link_request_rejected',
        targetType: 'ChatLinkRequest',
        targetId: id,
        actorId: opts.adminId,
        actorType: ActorType.ADMIN,
      });
      return { status: ChatLinkRequestStatus.REJECTED };
    }

    if (request.conflictReason === ChatLinkConflictReason.SELF_TRANSACTION_CONFLICT) {
      throw new ConflictException(
        'SELF_TRANSACTION_CONFLICT cannot be resolved by choosing a profile — reject it instead',
      );
    }
    if (!opts.keepProfile) {
      throw new ConflictException('keepProfile is required to resolve a SELLER_PROFILE_CONFLICT');
    }

    // Promote back to PENDING so the normal merge path owns the guards.
    await this.prisma.chatLinkRequest.update({
      where: { id },
      data: { status: ChatLinkRequestStatus.PENDING, conflictReason: null },
    });

    const identity = await this.prisma.chatIdentity.findUniqueOrThrow({
      where: { id: request.chatIdentityId },
    });
    const result = await this.merge.merge(request.sourceUserId, request.targetUserId, {
      keepProfile: opts.keepProfile,
    });

    await this.prisma.chatLinkRequest.update({
      where: { id },
      data: {
        status: ChatLinkRequestStatus.COMPLETED,
        consumedAt: new Date(),
        resolvedAt: new Date(),
        resolvedBy: opts.adminId,
      },
    });
    await this.audit.log({
      action: 'chat.link_request_completed',
      targetType: 'ChatLinkRequest',
      targetId: id,
      actorId: opts.adminId,
      actorType: ActorType.ADMIN,
      metadata: { keepProfile: opts.keepProfile, ...result, platform: identity.platform },
    });
    return { status: ChatLinkRequestStatus.COMPLETED };
  }
```

Add `ConflictException`, `NotFoundException` to the `@nestjs/common` import, `ChatLinkRequest` and `ChatLinkConflictReason` to the `@prisma/client` import.

**A caveat to handle in review:** `merge.merge` re-runs `detectCollision`, which will still see two `SellerProfile` rows and throw `LinkMergeCollisionError`. In the admin path the merge must accept an explicit override, so add a third parameter to `merge`'s options:

```ts
    opts: { keepProfile?: 'TARGET' | 'SOURCE'; overrideCollision?: 'SELLER_PROFILE_CONFLICT' } = {},
```

and in `merge`, skip that one collision kind when overridden:

```ts
      const collision = await this.detectCollision(sourceUserId, targetUserId, db);
      if (collision && collision !== opts.overrideCollision) {
        throw new LinkMergeCollisionError(collision);
      }
```

`SELF_TRANSACTION_CONFLICT` must never be overridable — do not widen the type. Update the Task 5 spec with a case asserting the override admits `SELLER_PROFILE_CONFLICT` but not `SELF_TRANSACTION_CONFLICT`.

- [ ] **Step 6: Register the controller** in `chat.module.ts` alongside `ChatLinkController`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx jest src/modules/chat/linking`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/chat/linking
git commit -m "feat(chat-linking): admin review queue and resolve"
```

---

### Task 11: E2E money-safety specification

**Files:**
- Create: `test/chat-account-linking.e2e-spec.ts`

**Interfaces:**
- Consumes: the harness in `test/utils/` and the fake seams described in CLAUDE.md (real Postgres, faked Paystack/auth/queue).

Read `test/money-safety.e2e-spec.ts` and `test/utils/` first and follow their harness exactly — app bootstrap, guard override, and the Paystack/auth fakes.

- [ ] **Step 1: Write the spec**

Implement these eight cases (the first two are the ones that matter):

1. **A protected transaction survives the merge and its status does not change.** Create a chat-born seller with a `PAYMENT_PROTECTED` transaction, a web user, link them → assert `Transaction.sellerId` is now the web user, `status` is still `PAYMENT_PROTECTED`, the source `User` is `DEACTIVATED` with `mergedIntoUserId` set, and **zero** `TimelineEvent` rows were added by the merge.
2. **An open dispute still freezes release after the merge.** Link an account holding a `DISPUTED` transaction → assert the dispute is still `OPEN`, and that attempting the release path for the merged transaction is still refused (rule 5).
3. **`SELLER_PROFILE_CONFLICT` writes nothing.** Both sides own a `SellerProfile` → assert the request is `PENDING_REVIEW` and that every row still belongs to its original owner (no partial merge), and both profiles are intact.
4. **`SELF_TRANSACTION_CONFLICT` is not admin-resolvable.** A transaction with the source as seller and the target as buyer → assert `PENDING_REVIEW`, and that `POST /admin/chat/link-requests/:id/resolve { outcome: 'COMPLETE' }` returns 409 while `REJECT` succeeds.
5. **An in-flight payout defers the link.** Seed a `PENDING` payout owned by the source → assert the outcome is retry, the code is still `PENDING`, and nothing was re-parented; then mark the payout `SUCCESS` and assert the same code now links.
6. **A code cannot be replayed.** Consume once → the second attempt returns the generic failure and no second merge occurs.
7. **An expired code fails generically.**
8. **Admin `COMPLETE` with `keepProfile: 'TARGET'`** → exactly one `SellerProfile` remains, the loser's `providerRecipientCode` is null, and one audit row is written.

- [ ] **Step 2: Run the suite**

Run: `npm run db:up && npm run db:migrate:test && npm run test:e2e`
Expected: PASS, including the pre-existing 28 e2e specs. If a pre-existing spec fails, the merge or the schema changed shared behaviour — stop and investigate before touching the new spec.

- [ ] **Step 3: Commit**

```bash
git add test/chat-account-linking.e2e-spec.ts
git commit -m "test(chat-linking): e2e money-safety coverage"
```

---

### Task 12: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/FRONTEND_API_MAP.md`
- Modify: `docs/PRODUCTION_READINESS.md`
- Modify: `.env.example`

- [ ] **Step 1: Update `CLAUDE.md`** — add a `chat/ account linking` entry to the Status list describing the flow, the tombstone decision, the collision outcomes, and the new env (`CHAT_LINK_HASH_SECRET`). Add `CHAT_LINK_HASH_SECRET` to the "New env since scaffold" list at the end.

- [ ] **Step 2: Update `docs/FRONTEND_API_MAP.md`** — document `POST /chat/link-code`, `GET /chat/link-status`, and the admin routes with the same 🔒/🌐 and part-numbering conventions the file already uses. Note that the plaintext code is returned exactly once.

- [ ] **Step 3: Update `docs/PRODUCTION_READINESS.md`** — add the linking endpoints to the security section and note that a merged account's tombstone is retained for legal purposes.

- [ ] **Step 4: Verify everything**

Run: `npm run lint && npm run build && npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/ .env.example
git commit -m "docs(chat-linking): account linking, env, and API map"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: data model → 1; crypto + env → 2, 3; merge algorithm and the "deliberately NOT re-parented" rule → 5 (with an explicit test); collision handling → 4, 7, 10; in-flight payout → 4, 7, 11 (case 5); admin surface → 10; money-safety analysis → 11 (cases 1, 2, 5); testing list → the unit specs plus 11.

**One deliberate deviation from the spec.** Task 10 adds an `overrideCollision` option to `merge`. The spec's admin `COMPLETE` path cannot work without it — `merge` re-runs `detectCollision` and would refuse the very conflict the admin is resolving. The option is narrowed to `'SELLER_PROFILE_CONFLICT'` only; `SELF_TRANSACTION_CONFLICT` stays unoverridable and non-resolvable, exactly as the spec requires. **Update the spec file to record this** as part of Task 12.

**Placeholder scan.** No TBD/TODO. Task 11's eight cases are described rather than written out as code because the harness is the reader's to match — that is the one place this plan asks for judgement, and it points at `test/money-safety.e2e-spec.ts` as the model.

**Type consistency.** `MergeCollisionKind` (Task 4) is the single source of the collision vocabulary, reused by `LinkMergeCollisionError.kind` (Task 5), `ConsumeOutcome.reason` (Task 7), and `ChatLinkConflictReason` in the DB (Task 1). `MergeDb` (Task 4) is what keeps `detectCollision` / `hasInFlightPayout` callable from inside the merge transaction. `ChatLinkService.mint` / `.consume` / `.statusFor` / `.listForReview` / `.resolve` are the names the controllers and dialog call.
