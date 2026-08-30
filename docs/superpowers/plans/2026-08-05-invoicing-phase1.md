# Invoicing — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add itemized, formal invoices that — when paid — fund a protected (escrow) Transaction through the existing state machine, introducing no new money path.

**Architecture:** A new `src/modules/invoices/` domain module. An `Invoice` is a front-end onto exactly one `Transaction` (1—1, nullable until sent). On send, the invoice mints a Transaction (`amount` = server-computed invoice total) and its pay link via the existing `TransactionsService`. `Invoice.status = PAID` is derived only when the linked Transaction reaches `PAYMENT_PROTECTED` — never from a client call. All money math is server-owned integer kobo.

**Tech Stack:** NestJS 10 (strict TS), Prisma (Supabase Postgres), BullMQ/Redis, Jest. Path alias `@/*` → `src/*`.

**Design spec:** [docs/superpowers/specs/2026-08-05-invoicing-phase1-design.md](../specs/2026-08-05-invoicing-phase1-design.md)

**Money-safety reminder (CLAUDE.md):** server is sole owner of state + money math (rule 1); PAID changes only from the signed-webhook / server-verify protect path (rule 2); every send/void/remind writes an AuditLog row (rule 6); money is integer kobo, never floats.

---

## File Structure

**Create:**
- `prisma/migrations/20260803000000_invoicing_phase1/migration.sql` — additive DDL (3 tables + enum).
- `src/modules/invoices/invoice.compute.ts` — pure money math (line totals, subtotal, tax, total).
- `src/modules/invoices/invoice.compute.spec.ts`
- `src/modules/invoices/dto/create-invoice.dto.ts`, `dto/update-invoice.dto.ts`, `dto/invoice-line.dto.ts`
- `src/modules/invoices/invoices.service.ts` + `invoices.service.spec.ts`
- `src/modules/invoices/invoices.controller.ts`
- `src/modules/invoices/public-invoices.controller.ts`
- `src/modules/invoices/invoice-overdue.service.ts` + `invoice-overdue.service.spec.ts`
- `src/modules/invoices/invoices.module.ts`
- `test/invoicing-money-safety.e2e-spec.ts`

**Modify:**
- `prisma/schema.prisma` — add `Invoice`, `InvoiceLineItem`, `InvoiceCounter`, `InvoiceStatus`, and back-relations on `User` + `Transaction`.
- `src/modules/queue/queue.constants.ts` — `INVOICE_DELIVERY_JOB` + `InvoiceDeliveryJobData`.
- `src/modules/notifications/notifications.service.ts` — `enqueueInvoice` + `deliverInvoice`.
- `src/modules/notifications/notification.processor.ts` — route the new job.
- `src/modules/payments/payments.service.ts` — call the PAID-derivation hook after protecting.
- `src/modules/payments/payments.module.ts` — import `InvoicesModule`.
- `src/app.module.ts` — register `InvoicesModule`.
- `src/cron.ts` — run the overdue scan.

---

## Task 1: Prisma schema + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260803000000_invoicing_phase1/migration.sql`

- [ ] **Step 1: Add the enum + models to `prisma/schema.prisma`**

Add near the other enums:

```prisma
enum InvoiceStatus {
  DRAFT    // seller building it; no Transaction yet
  SENT     // Transaction + pay link minted, delivered to buyer contact
  VIEWED   // buyer opened the public view
  PAID     // linked Transaction reached PAYMENT_PROTECTED (derived)
  OVERDUE  // dueDate passed, not yet PAID (cron-set)
  VOID     // seller cancelled (pre-PAID only)
}
```

Add these models (place after `TransactionItem`):

```prisma
/// A formal, itemized invoice. Front-end onto exactly one protected Transaction.
/// Server owns every money field and the PAID state (money rules 1 & 2).
model Invoice {
  id           String        @id @default(uuid()) @db.Uuid
  sellerId     String        @db.Uuid
  seller       User          @relation("SellerInvoices", fields: [sellerId], references: [id])

  /// Seller-sequential human number, e.g. "INV-0001". Unique per seller.
  number       String

  /// Buyer contact captured at draft time. buyerId is filled once the buyer pays.
  buyerId      String?       @db.Uuid
  buyer        User?         @relation("BuyerInvoices", fields: [buyerId], references: [id])
  buyerName    String?
  buyerEmail   String?
  buyerPhone   String?

  status       InvoiceStatus @default(DRAFT)
  issueDate    DateTime      @default(now())
  dueDate      DateTime?

  currency     String        @default("NGN")
  /// All money = minor units (kobo), server-computed, never client-supplied.
  subtotal     Int           @default(0)
  taxRatePctBp Int?          // basis points; 750 = 7.5% VAT. null = no tax.
  taxAmount    Int           @default(0)
  total        Int           @default(0)

  notes        String?
  terms        String?

  /// Null until sent. One Transaction per invoice.
  transactionId String?      @unique @db.Uuid
  transaction   Transaction? @relation(fields: [transactionId], references: [id])

  /// Unguessable public identifier for the buyer-facing read-only view.
  publicViewId String        @unique

  sentAt       DateTime?
  viewedAt     DateTime?
  paidAt       DateTime?
  voidedAt     DateTime?
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt

  lineItems    InvoiceLineItem[]

  @@unique([sellerId, number])
  @@index([sellerId, status])
  @@index([status, dueDate])
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
  position    Int      @default(0)
  createdAt   DateTime @default(now())

  @@index([invoiceId])
  @@map("invoice_line_items")
}

/// Per-seller atomic invoice-number sequence. `nextSeq` = the next number to allocate.
model InvoiceCounter {
  sellerId String @id @db.Uuid
  nextSeq  Int    @default(1)

  @@map("invoice_counters")
}
```

Add the back-relations. In `model User`, alongside the other relations:

```prisma
  invoicesAsSeller Invoice[] @relation("SellerInvoices")
  invoicesAsBuyer  Invoice[] @relation("BuyerInvoices")
```

In `model Transaction`, alongside `items`:

```prisma
  invoice  Invoice?
```

- [ ] **Step 2: Hand-author the migration SQL**

Create `prisma/migrations/20260803000000_invoicing_phase1/migration.sql`:

```sql
-- Invoicing Phase 1: itemized formal invoices that fund a protected Transaction.
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'PAID', 'OVERDUE', 'VOID');

CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "buyerId" UUID,
    "buyerName" TEXT,
    "buyerEmail" TEXT,
    "buyerPhone" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "subtotal" INTEGER NOT NULL DEFAULT 0,
    "taxRatePctBp" INTEGER,
    "taxAmount" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "terms" TEXT,
    "transactionId" UUID,
    "publicViewId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invoice_line_items" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invoice_counters" (
    "sellerId" UUID NOT NULL,
    "nextSeq" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "invoice_counters_pkey" PRIMARY KEY ("sellerId")
);

CREATE UNIQUE INDEX "invoices_transactionId_key" ON "invoices"("transactionId");
CREATE UNIQUE INDEX "invoices_publicViewId_key" ON "invoices"("publicViewId");
CREATE UNIQUE INDEX "invoices_sellerId_number_key" ON "invoices"("sellerId", "number");
CREATE INDEX "invoices_sellerId_status_idx" ON "invoices"("sellerId", "status");
CREATE INDEX "invoices_status_dueDate_idx" ON "invoices"("status", "dueDate");
CREATE INDEX "invoice_line_items_invoiceId_idx" ON "invoice_line_items"("invoiceId");

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Generate the client and apply to the local test DB**

Run:
```bash
npm run prisma:generate && npm run db:up && npm run db:migrate:test
```
Expected: Prisma Client regenerates with `Invoice`/`InvoiceLineItem`/`InvoiceCounter` types; the migration applies clean to the local Postgres (port 55432).

- [ ] **Step 4: Verify the schema compiles**

Run: `npm run build`
Expected: build succeeds; `@prisma/client` exports the new model types.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260803000000_invoicing_phase1
git commit -m "feat(invoices): schema + migration for Phase 1 invoicing"
```

---

## Task 2: Pure money math

**Files:**
- Create: `src/modules/invoices/invoice.compute.ts`
- Test: `src/modules/invoices/invoice.compute.spec.ts`

- [ ] **Step 1: Write the failing test**

`src/modules/invoices/invoice.compute.spec.ts`:

```ts
import { computeLineTotal, computeTotals } from './invoice.compute';

describe('invoice.compute', () => {
  it('computes a line total as unitPrice * quantity (kobo)', () => {
    expect(computeLineTotal({ unitPrice: 250_00, quantity: 3 })).toBe(750_00);
  });

  it('sums subtotal across lines with no tax when rate is null', () => {
    const totals = computeTotals(
      [
        { unitPrice: 250_00, quantity: 2 }, // 500_00
        { unitPrice: 100_00, quantity: 1 }, // 100_00
      ],
      null,
    );
    expect(totals).toEqual({ subtotal: 600_00, taxAmount: 0, total: 600_00 });
  });

  it('applies a basis-point tax rate with integer rounding (7.5% VAT)', () => {
    // subtotal 1_000_00 kobo, 750 bp = 7.5% -> tax 75_00, total 1_075_00
    const totals = computeTotals([{ unitPrice: 1_000_00, quantity: 1 }], 750);
    expect(totals).toEqual({ subtotal: 1_000_00, taxAmount: 75_00, total: 1_075_00 });
  });

  it('rounds tax half-up to whole kobo', () => {
    // subtotal 333_33, 750bp -> 24999.75 -> rounds to 25000 kobo
    const totals = computeTotals([{ unitPrice: 333_33, quantity: 1 }], 750);
    expect(totals.taxAmount).toBe(25000);
    expect(totals.total).toBe(333_33 + 25000);
  });

  it('returns zero totals for an empty invoice', () => {
    expect(computeTotals([], null)).toEqual({ subtotal: 0, taxAmount: 0, total: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- invoice.compute`
Expected: FAIL — `Cannot find module './invoice.compute'`.

- [ ] **Step 3: Write the implementation**

`src/modules/invoices/invoice.compute.ts`:

```ts
/** Pure, dependency-free invoice money math. All values are integer kobo. */

export interface LineInput {
  quantity: number;
  unitPrice: number; // kobo
}

export interface InvoiceTotals {
  subtotal: number; // kobo
  taxAmount: number; // kobo
  total: number; // kobo
}

/** A line's total is unit price times quantity. Integer kobo in, integer kobo out. */
export function computeLineTotal(line: LineInput): number {
  return line.unitPrice * line.quantity;
}

/**
 * Sum the lines into a subtotal, apply the optional basis-point tax rate
 * (750 bp = 7.5%), and return subtotal/tax/total. Tax rounds half-up to whole
 * kobo via Math.round on the single division — never a float in the stored value.
 */
export function computeTotals(lines: LineInput[], taxRatePctBp: number | null): InvoiceTotals {
  const subtotal = lines.reduce((sum, line) => sum + computeLineTotal(line), 0);
  const taxAmount = taxRatePctBp == null ? 0 : Math.round((subtotal * taxRatePctBp) / 10_000);
  return { subtotal, taxAmount, total: subtotal + taxAmount };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- invoice.compute`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/invoices/invoice.compute.ts src/modules/invoices/invoice.compute.spec.ts
git commit -m "feat(invoices): pure kobo money-math helper"
```

---

## Task 3: DTOs

**Files:**
- Create: `src/modules/invoices/dto/invoice-line.dto.ts`
- Create: `src/modules/invoices/dto/create-invoice.dto.ts`
- Create: `src/modules/invoices/dto/update-invoice.dto.ts`

- [ ] **Step 1: Write the line DTO**

`src/modules/invoices/dto/invoice-line.dto.ts`:

```ts
import { IsInt, IsOptional, IsPositive, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * A client-supplied invoice line. The client sends inputs only — never lineTotal;
 * the server computes every money field (money rule 1).
 */
export class InvoiceLineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsInt()
  @IsPositive()
  quantity!: number;

  /** Unit price in kobo. Integer, positive — never a float. */
  @IsInt()
  @Min(0)
  unitPrice!: number;
}
```

- [ ] **Step 2: Write the create DTO**

`src/modules/invoices/dto/create-invoice.dto.ts`:

```ts
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { InvoiceLineDto } from './invoice-line.dto';

/**
 * Seller-supplied fields for a new draft invoice. The server owns number,
 * status, all money totals, publicViewId, and the linked transaction.
 */
export class CreateInvoiceDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  buyerName?: string;

  @IsOptional()
  @IsEmail()
  buyerEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  buyerPhone?: string;

  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  /** Basis points; 750 = 7.5%. Omit for no tax. 0–10000 (0–100%). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  taxRatePctBp?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  terms?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lineItems!: InvoiceLineDto[];
}
```

- [ ] **Step 3: Write the update DTO**

`src/modules/invoices/dto/update-invoice.dto.ts`:

```ts
import { PartialType } from '@nestjs/mapped-types';
import { CreateInvoiceDto } from './create-invoice.dto';

/** Edit a DRAFT invoice. Every field optional; lineItems (if given) replace the set. */
export class UpdateInvoiceDto extends PartialType(CreateInvoiceDto) {}
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run build`
Expected: success. (`@nestjs/mapped-types` and `class-transformer` are already dependencies — the transactions/list DTOs use them.)

- [ ] **Step 5: Commit**

```bash
git add src/modules/invoices/dto
git commit -m "feat(invoices): request DTOs (create/update/line)"
```

---

## Task 4: InvoicesService — create / edit / read / list / void + number allocation

**Files:**
- Create: `src/modules/invoices/invoices.service.ts`
- Test: `src/modules/invoices/invoices.service.spec.ts`

This task builds everything except `send` and the PAID hook (Task 5 & 6).

- [ ] **Step 1: Write the failing tests**

`src/modules/invoices/invoices.service.spec.ts`:

```ts
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '@/prisma/prisma.service';
import type { TransactionsService } from '@/modules/transactions/transactions.service';
import type { NotificationsService } from '@/modules/notifications/notifications.service';
import { InvoicesService } from './invoices.service';

function makeService(overrides: Record<string, jest.Mock> = {}) {
  const invoiceStore: Record<string, unknown> = {};
  const prisma = {
    invoice: {
      create: jest.fn(({ data }) => Promise.resolve({ id: 'inv-1', status: 'DRAFT', ...data })),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(({ data }) => Promise.resolve({ id: 'inv-1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoiceLineItem: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((fn) => fn(prisma)),
    ...overrides,
  } as unknown as PrismaService;
  const transactions = {
    createDraft: jest.fn().mockResolvedValue({ id: 'tx-1', publicLinkId: 'link-1' }),
    apply: jest.fn().mockResolvedValue({}),
  } as unknown as TransactionsService;
  const notifications = { enqueueInvoice: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService;
  const service = new InvoicesService(prisma, transactions, notifications);
  return { service, prisma, transactions, notifications };
}

describe('InvoicesService.createDraft', () => {
  it('computes totals server-side and stores line totals; ignores any client-sent totals', async () => {
    const { service, prisma } = makeService();
    await service.createDraft('seller-1', {
      lineItems: [{ title: 'A', quantity: 2, unitPrice: 250_00 }],
      taxRatePctBp: 750,
    } as never);
    const created = (prisma.invoice.create as jest.Mock).mock.calls[0][0].data;
    expect(created.subtotal).toBe(500_00);
    expect(created.taxAmount).toBe(37_50); // 7.5% of 500_00
    expect(created.total).toBe(537_50);
    expect(created.status).toBe('DRAFT');
    expect(created.publicViewId).toEqual(expect.any(String));
  });
});

describe('InvoicesService.edit', () => {
  it('rejects editing a non-DRAFT invoice', async () => {
    const { service, prisma } = makeService();
    (prisma.invoice.findUnique as jest.Mock).mockResolvedValue({
      id: 'inv-1', sellerId: 'seller-1', status: 'SENT',
    });
    await expect(service.edit('seller-1', 'inv-1', {} as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a non-owner', async () => {
    const { service, prisma } = makeService();
    (prisma.invoice.findUnique as jest.Mock).mockResolvedValue({
      id: 'inv-1', sellerId: 'seller-1', status: 'DRAFT',
    });
    await expect(service.edit('someone-else', 'inv-1', {} as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('InvoicesService.void', () => {
  it('rejects voiding a PAID invoice', async () => {
    const { service, prisma } = makeService();
    (prisma.invoice.findUnique as jest.Mock).mockResolvedValue({
      id: 'inv-1', sellerId: 'seller-1', status: 'PAID', transactionId: 'tx-1',
    });
    await expect(service.void('seller-1', 'inv-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cancels the linked transaction when voiding a sent invoice', async () => {
    const { service, prisma, transactions } = makeService();
    (prisma.invoice.findUnique as jest.Mock).mockResolvedValue({
      id: 'inv-1', sellerId: 'seller-1', status: 'SENT', transactionId: 'tx-1',
    });
    await service.void('seller-1', 'inv-1');
    expect((transactions.apply as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-1', event: { type: 'CANCEL' } }),
    );
    expect((prisma.invoice.update as jest.Mock).mock.calls[0][0].data.status).toBe('VOID');
  });
});

describe('InvoicesService.getById', () => {
  it('404s a missing invoice', async () => {
    const { service } = makeService();
    await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- invoices.service`
Expected: FAIL — `Cannot find module './invoices.service'`.

- [ ] **Step 3: Write the implementation**

`src/modules/invoices/invoices.service.ts`:

```ts
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ActorType, InvoiceStatus, type Invoice, type Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { TransactionsService } from '@/modules/transactions/transactions.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { computeLineTotal, computeTotals } from './invoice.compute';
import type { CreateInvoiceDto } from './dto/create-invoice.dto';
import type { UpdateInvoiceDto } from './dto/update-invoice.dto';

/** Query options for a seller's invoice list (cursor pagination). */
export interface ListInvoicesOptions {
  status?: InvoiceStatus;
  cursor?: string;
  limit?: number;
}

/** Statuses from which an invoice may still be voided (pre-payment only). */
const VOIDABLE_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.DRAFT,
  InvoiceStatus.SENT,
  InvoiceStatus.VIEWED,
  InvoiceStatus.OVERDUE,
];

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Create a DRAFT invoice. Server computes every money field (money rule 1). */
  async createDraft(sellerId: string, dto: CreateInvoiceDto): Promise<Invoice> {
    const totals = computeTotals(dto.lineItems, dto.taxRatePctBp ?? null);
    return this.prisma.invoice.create({
      data: {
        sellerId,
        number: '', // allocated at send; empty placeholder while DRAFT
        status: InvoiceStatus.DRAFT,
        publicViewId: randomUUID().replace(/-/g, ''),
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        total: totals.total,
        ...(dto.taxRatePctBp !== undefined ? { taxRatePctBp: dto.taxRatePctBp } : {}),
        ...(dto.buyerName ? { buyerName: dto.buyerName } : {}),
        ...(dto.buyerEmail ? { buyerEmail: dto.buyerEmail } : {}),
        ...(dto.buyerPhone ? { buyerPhone: dto.buyerPhone } : {}),
        ...(dto.dueDate ? { dueDate: new Date(dto.dueDate) } : {}),
        ...(dto.notes ? { notes: dto.notes } : {}),
        ...(dto.terms ? { terms: dto.terms } : {}),
        lineItems: {
          create: dto.lineItems.map((l, i) => ({
            title: l.title,
            ...(l.description ? { description: l.description } : {}),
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            lineTotal: computeLineTotal(l),
            position: i,
          })),
        },
      },
      include: { lineItems: { orderBy: { position: 'asc' } } },
    });
  }

  /** Edit a DRAFT invoice. Replaces line items and recomputes totals. */
  async edit(sellerId: string, id: string, dto: UpdateInvoiceDto): Promise<Invoice> {
    const invoice = await this.loadOwned(sellerId, id);
    if (invoice.status !== InvoiceStatus.DRAFT) {
      throw new BadRequestException('Only a DRAFT invoice can be edited');
    }

    const lines = dto.lineItems;
    const data: Prisma.InvoiceUpdateInput = {
      ...(dto.buyerName !== undefined ? { buyerName: dto.buyerName } : {}),
      ...(dto.buyerEmail !== undefined ? { buyerEmail: dto.buyerEmail } : {}),
      ...(dto.buyerPhone !== undefined ? { buyerPhone: dto.buyerPhone } : {}),
      ...(dto.dueDate !== undefined ? { dueDate: new Date(dto.dueDate) } : {}),
      ...(dto.taxRatePctBp !== undefined ? { taxRatePctBp: dto.taxRatePctBp } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      ...(dto.terms !== undefined ? { terms: dto.terms } : {}),
    };

    if (lines) {
      const rate = dto.taxRatePctBp ?? invoice.taxRatePctBp ?? null;
      const totals = computeTotals(lines, rate);
      data.subtotal = totals.subtotal;
      data.taxAmount = totals.taxAmount;
      data.total = totals.total;
      data.lineItems = {
        deleteMany: {},
        create: lines.map((l, i) => ({
          title: l.title,
          ...(l.description ? { description: l.description } : {}),
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: computeLineTotal(l),
          position: i,
        })),
      };
    }

    return this.prisma.invoice.update({
      where: { id },
      data,
      include: { lineItems: { orderBy: { position: 'asc' } } },
    });
  }

  /** Load an invoice or 404. */
  async getById(id: string): Promise<Invoice> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { lineItems: { orderBy: { position: 'asc' } } },
    });
    if (!invoice) {
      throw new NotFoundException(`Invoice ${id} not found`);
    }
    return invoice;
  }

  /** Seller-scoped list, cursor paginated (newest first). */
  async listForSeller(
    sellerId: string,
    opts: ListInvoicesOptions,
  ): Promise<{ items: Invoice[]; nextCursor: string | null }> {
    const take = opts.limit ?? 20;
    const rows = await this.prisma.invoice.findMany({
      where: { sellerId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, take);
    const last = items.at(-1);
    const nextCursor = rows.length > take && last ? last.id : null;
    return { items, nextCursor };
  }

  /** Void a pre-PAID invoice; cancels the linked transaction if one exists. */
  async void(sellerId: string, id: string): Promise<Invoice> {
    const invoice = await this.loadOwned(sellerId, id);
    if (!VOIDABLE_STATUSES.includes(invoice.status)) {
      throw new BadRequestException(`Cannot void an invoice in status ${invoice.status}`);
    }

    if (invoice.transactionId) {
      // The machine rejects CANCEL from any protected/released state, so a paid
      // invoice's tx can never be cancelled here — a second guard behind the status check.
      await this.transactions.apply({
        transactionId: invoice.transactionId,
        event: { type: 'CANCEL' },
        actor: { id: sellerId, type: ActorType.USER, role: 'SELLER' },
        reason: `invoice ${invoice.number || id} voided`,
      });
    }

    const updated = await this.prisma.invoice.update({
      where: { id },
      data: { status: InvoiceStatus.VOID, voidedAt: new Date() },
    });
    await this.writeAudit(sellerId, id, 'invoice.voided', invoice.status, InvoiceStatus.VOID);
    return updated;
  }

  /** Load and assert seller ownership. */
  private async loadOwned(sellerId: string, id: string): Promise<Invoice> {
    const invoice = await this.getById(id);
    if (invoice.sellerId !== sellerId) {
      throw new ForbiddenException('Not the owner of this invoice');
    }
    return invoice;
  }

  /** Append an audit row for an invoice lifecycle action (money rule 6). */
  private async writeAudit(
    actorId: string | null,
    invoiceId: string,
    action: string,
    from: InvoiceStatus | null,
    to: InvoiceStatus,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId,
        actorType: actorId ? ActorType.USER : ActorType.SYSTEM,
        action,
        targetType: 'Invoice',
        targetId: invoiceId,
        metadata: { from, to },
      },
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- invoices.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/invoices/invoices.service.ts src/modules/invoices/invoices.service.spec.ts
git commit -m "feat(invoices): service create/edit/read/list/void with server-owned totals"
```

---

## Task 5: InvoicesService.send — mint the transaction + allocate number

**Files:**
- Modify: `src/modules/invoices/invoices.service.ts`
- Test: `src/modules/invoices/invoices.service.spec.ts`

- [ ] **Step 1: Write the failing tests (append to the spec)**

```ts
describe('InvoicesService.send', () => {
  const sentInvoice = {
    id: 'inv-1', sellerId: 'seller-1', status: 'DRAFT', total: 537_50,
    transactionId: null, number: '', currency: 'NGN',
    lineItems: [{ title: 'A', quantity: 1, unitPrice: 537_50 }],
  };

  it('mints one transaction, publishes it, freezes the number, and enqueues delivery', async () => {
    const { service, prisma, transactions, notifications } = makeService();
    (prisma.invoice.findUnique as jest.Mock).mockResolvedValue(sentInvoice);
    (prisma.invoiceCounter as unknown) = {
      upsert: jest.fn().mockResolvedValue({ sellerId: 'seller-1', nextSeq: 2 }),
    };

    await service.send('seller-1', 'inv-1');

    expect((transactions.createDraft as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ sellerId: 'seller-1', amount: 537_50 }),
    );
    expect((transactions.apply as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-1', event: { type: 'SELLER_PUBLISH' } }),
    );
    const update = (prisma.invoice.updateMany as jest.Mock).mock.calls[0][0];
    expect(update.where).toEqual({ id: 'inv-1', status: 'DRAFT' });
    expect(update.data.status).toBe('SENT');
    expect(update.data.number).toBe('INV-0001');
    expect(update.data.transactionId).toBe('tx-1');
    expect((notifications.enqueueInvoice as jest.Mock)).toHaveBeenCalledWith({ invoiceId: 'inv-1' });
  });

  it('is idempotent — a second send returns the existing invoice without a new transaction', async () => {
    const { service, prisma, transactions } = makeService();
    (prisma.invoice.findUnique as jest.Mock).mockResolvedValue({
      ...sentInvoice, status: 'SENT', transactionId: 'tx-1', number: 'INV-0001',
    });
    await service.send('seller-1', 'inv-1');
    expect((transactions.createDraft as jest.Mock)).not.toHaveBeenCalled();
  });

  it('refuses to send a zero-total invoice', async () => {
    const { service, prisma } = makeService();
    (prisma.invoice.findUnique as jest.Mock).mockResolvedValue({
      ...sentInvoice, total: 0, lineItems: [],
    });
    await expect(service.send('seller-1', 'inv-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- invoices.service`
Expected: FAIL — `service.send is not a function`.

- [ ] **Step 3: Add `send` and the number allocator to `invoices.service.ts`**

Add these methods to the `InvoicesService` class:

```ts
  /**
   * Send a DRAFT invoice: mint exactly one protected Transaction (amount = the
   * frozen total), publish it to LINK_ACTIVE, allocate the seller-sequential
   * number, flip the invoice to SENT, and enqueue delivery. Idempotent: a second
   * call on an already-sent invoice is a no-op returning the existing row (no
   * second transaction, no re-delivery). Money never moves here — payment still
   * flows through the normal collection + verify + protect path (money rule 2).
   */
  async send(sellerId: string, id: string): Promise<Invoice> {
    const invoice = await this.loadOwned(sellerId, id);
    if (invoice.status !== InvoiceStatus.DRAFT) {
      return invoice; // already sent — idempotent no-op
    }
    if (invoice.total <= 0) {
      throw new BadRequestException('Cannot send an invoice with a zero total');
    }

    const tx = await this.transactions.createDraft({
      sellerId,
      title: invoice.number || `Invoice`,
      amount: invoice.total,
      currency: invoice.currency,
    });
    await this.transactions.apply({
      transactionId: tx.id,
      event: { type: 'SELLER_PUBLISH' },
      actor: { id: sellerId, type: ActorType.USER, role: 'SELLER' },
      reason: 'invoice sent',
    });

    const number = await this.allocateNumber(sellerId);

    // Optimistic guard: only the first send (still DRAFT) writes. A racing second
    // send finds count 0, leaving its just-created tx orphaned in LINK_ACTIVE
    // (harmless — no buyer, never paid; cleaned by the link-expiry cron).
    const flipped = await this.prisma.invoice.updateMany({
      where: { id, status: InvoiceStatus.DRAFT },
      data: {
        status: InvoiceStatus.SENT,
        number,
        transactionId: tx.id,
        sentAt: new Date(),
      },
    });
    if (flipped.count !== 1) {
      return this.getById(id); // lost the race — return the winner's row
    }

    await this.writeAudit(sellerId, id, 'invoice.sent', InvoiceStatus.DRAFT, InvoiceStatus.SENT);
    await this.notifications.enqueueInvoice({ invoiceId: id });
    return this.getById(id);
  }

  /**
   * Allocate the next per-seller invoice number atomically. The upsert increments
   * `nextSeq` and returns the post-increment value; the allocated sequence is
   * therefore `nextSeq - 1` in both the create (nextSeq=2 -> 1) and update
   * (nextSeq=N -> N-1) branches. Concurrent sends can never collide on a number.
   */
  private async allocateNumber(sellerId: string): Promise<string> {
    const counter = await this.prisma.invoiceCounter.upsert({
      where: { sellerId },
      create: { sellerId, nextSeq: 2 },
      update: { nextSeq: { increment: 1 } },
    });
    const seq = counter.nextSeq - 1;
    return `INV-${String(seq).padStart(4, '0')}`;
  }
```

Add `InvoiceCounter` is accessed via `this.prisma.invoiceCounter` (generated by Task 1). No new import needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- invoices.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/invoices/invoices.service.ts src/modules/invoices/invoices.service.spec.ts
git commit -m "feat(invoices): send mints one protected tx + atomic seller-sequential number"
```

---

## Task 6: PAID derivation from the protect path

**Files:**
- Modify: `src/modules/invoices/invoices.service.ts`
- Modify: `src/modules/payments/payments.service.ts`
- Modify: `src/modules/payments/payments.module.ts`
- Test: `src/modules/invoices/invoices.service.spec.ts`

- [ ] **Step 1: Write the failing test (append to the spec)**

```ts
describe('InvoicesService.markPaidByTransaction', () => {
  it('flips a SENT invoice to PAID for the linked transaction', async () => {
    const { service, prisma } = makeService();
    (prisma.invoice as unknown as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      id: 'inv-1', sellerId: 'seller-1', status: 'SENT', transactionId: 'tx-1',
    });
    await service.markPaidByTransaction('tx-1');
    const call = (prisma.invoice.updateMany as jest.Mock).mock.calls[0][0];
    expect(call.where.transactionId).toBe('tx-1');
    expect(call.where.status).toEqual({ in: ['SENT', 'VIEWED', 'OVERDUE'] });
    expect(call.data.status).toBe('PAID');
  });

  it('is a no-op when the transaction has no invoice', async () => {
    const { service, prisma } = makeService();
    (prisma.invoice.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    await expect(service.markPaidByTransaction('tx-none')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- invoices.service`
Expected: FAIL — `service.markPaidByTransaction is not a function`.

- [ ] **Step 3: Add `markPaidByTransaction` to `invoices.service.ts`**

```ts
  /**
   * Derive PAID from the protect path (money rules 1 & 2). Called only by the
   * payments protect flow when a transaction reaches PAYMENT_PROTECTED — never
   * from a client request. Guarded by `status in (SENT, VIEWED, OVERDUE)` so it
   * is idempotent and never regresses a VOID/PAID invoice. No-op when the
   * transaction has no invoice.
   */
  async markPaidByTransaction(transactionId: string): Promise<void> {
    const flipped = await this.prisma.invoice.updateMany({
      where: {
        transactionId,
        status: { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.OVERDUE] },
      },
      data: { status: InvoiceStatus.PAID, paidAt: new Date() },
    });
    if (flipped.count === 1) {
      const invoice = await this.prisma.invoice.findFirst({ where: { transactionId } });
      if (invoice) {
        await this.writeAudit(null, invoice.id, 'invoice.paid', null, InvoiceStatus.PAID);
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- invoices.service`
Expected: PASS.

- [ ] **Step 5: Wire the hook into the payments protect path**

In `src/modules/payments/payments.service.ts`, import and inject `InvoicesService`, then call the hook right after `notifyProtected`.

Add the import near the other module imports:
```ts
import { InvoicesService } from '@/modules/invoices/invoices.service';
```

Add to the constructor parameter list (after `queue`):
```ts
    private readonly invoices: InvoicesService,
```

In `verifyAndProtectPayment`, change the tail from:
```ts
    await this.notifyProtected(payment.transactionId);
    return updated;
```
to:
```ts
    await this.notifyProtected(payment.transactionId);
    // Derive invoice PAID from the same signed-webhook / server-verify protect
    // event that owns money rule 2. No-op when the tx has no invoice.
    await this.invoices.markPaidByTransaction(payment.transactionId);
    return updated;
```

- [ ] **Step 6: Import InvoicesModule into PaymentsModule**

In `src/modules/payments/payments.module.ts`, add `InvoicesModule` to the `imports` array (create the import line):
```ts
import { InvoicesModule } from '@/modules/invoices/invoices.module';
```
Add `InvoicesModule` to `imports`. (InvoicesModule is created in Task 9; until then the app won't boot — that's expected mid-plan. The unit tests in this task do not need the module.)

- [ ] **Step 7: Run the invoice + payments unit tests**

Run: `npm test -- invoices.service payments.service`
Expected: PASS. (The payments spec constructs the service directly — update its `makeDeps`/constructor call to pass an `invoices` mock: `{ markPaidByTransaction: jest.fn().mockResolvedValue(undefined) }`. Add that mock to the existing `payments.service.spec.ts` deps and the `new PaymentsService(...)` argument list.)

- [ ] **Step 8: Commit**

```bash
git add src/modules/invoices/invoices.service.ts src/modules/invoices/invoices.service.spec.ts src/modules/payments
git commit -m "feat(invoices): derive PAID from the protect path (money rule 2)"
```

---

## Task 7: Public view projection + VIEWED marking

**Files:**
- Modify: `src/modules/invoices/invoices.service.ts`
- Test: `src/modules/invoices/invoices.service.spec.ts`

- [ ] **Step 1: Write the failing test (append to the spec)**

```ts
describe('InvoicesService.getPublicView', () => {
  const publicRow = {
    id: 'inv-1', sellerId: 'seller-1', status: 'SENT', number: 'INV-0001',
    issueDate: new Date('2026-08-05'), dueDate: null, currency: 'NGN',
    subtotal: 500_00, taxAmount: 0, total: 500_00, transactionId: 'tx-1',
    publicViewId: 'pub-abc', viewedAt: null,
    lineItems: [{ title: 'A', quantity: 1, unitPrice: 500_00, lineTotal: 500_00 }],
    transaction: { publicLinkId: 'link-1' },
    seller: { fullName: 'Sara', sellerProfile: { businessName: 'Sara Co', trustLevel: 'NEW', verificationStatus: 'VERIFIED' } },
  };

  it('returns an allow-listed projection and never leaks internal ids', async () => {
    const { service, prisma } = makeService();
    (prisma.invoice.findUnique as jest.Mock).mockResolvedValue(publicRow);
    const view = await service.getPublicView('pub-abc');
    expect(view).toMatchObject({
      number: 'INV-0001', total: 500_00, payLinkId: 'link-1',
      seller: { displayName: 'Sara Co', verified: true },
    });
    expect(view).not.toHaveProperty('sellerId');
    expect(view).not.toHaveProperty('transactionId');
    expect(view).not.toHaveProperty('buyerId');
  });

  it('marks the invoice VIEWED on first open', async () => {
    const { service, prisma } = makeService();
    (prisma.invoice.findUnique as jest.Mock).mockResolvedValue(publicRow);
    await service.getPublicView('pub-abc');
    const call = (prisma.invoice.updateMany as jest.Mock).mock.calls[0][0];
    expect(call.where).toEqual({ id: 'inv-1', status: 'SENT' });
    expect(call.data.status).toBe('VIEWED');
  });

  it('404s a DRAFT or unknown invoice', async () => {
    const { service, prisma } = makeService();
    (prisma.invoice.findUnique as jest.Mock).mockResolvedValue({ ...publicRow, status: 'DRAFT' });
    await expect(service.getPublicView('pub-abc')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- invoices.service`
Expected: FAIL — `service.getPublicView is not a function`.

- [ ] **Step 3: Add the projection type + method to `invoices.service.ts`**

Add the interface above the class:

```ts
/** Lean, allow-listed projection for the UNAUTHENTICATED public invoice view. */
export interface PublicInvoiceView {
  number: string;
  status: InvoiceStatus;
  issueDate: Date;
  dueDate: Date | null;
  currency: string;
  lineItems: { title: string; quantity: number; unitPrice: number; lineTotal: number }[];
  subtotal: number;
  taxAmount: number;
  total: number;
  /** Present once sent so the buyer can pay. Null otherwise. */
  payLinkId: string | null;
  seller: { displayName: string | null; verified: boolean };
}

/** Public-visible statuses. DRAFT/VOID are hidden (404). */
const PUBLIC_VISIBLE_INVOICE_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.SENT,
  InvoiceStatus.VIEWED,
  InvoiceStatus.OVERDUE,
  InvoiceStatus.PAID,
];
```

Add the method:

```ts
  /**
   * Public read for the buyer-facing invoice page, keyed on the unguessable
   * publicViewId. Returns only an allow-listed projection — never internal ids,
   * seller PII beyond the display name, or payout fields. Marks the invoice
   * VIEWED on first open (SENT -> VIEWED), which never regresses a later state.
   */
  async getPublicView(publicViewId: string): Promise<PublicInvoiceView> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { publicViewId },
      include: {
        lineItems: { orderBy: { position: 'asc' } },
        transaction: true,
        seller: { include: { sellerProfile: true } },
      },
    });
    if (!invoice || !PUBLIC_VISIBLE_INVOICE_STATUSES.includes(invoice.status)) {
      throw new NotFoundException('Invoice not found');
    }

    // First-open marking only; guarded so it fires exactly once and never regresses.
    if (invoice.status === InvoiceStatus.SENT) {
      await this.prisma.invoice.updateMany({
        where: { id: invoice.id, status: InvoiceStatus.SENT },
        data: { status: InvoiceStatus.VIEWED, viewedAt: new Date() },
      });
    }

    return {
      number: invoice.number,
      status: invoice.status === InvoiceStatus.SENT ? InvoiceStatus.VIEWED : invoice.status,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      lineItems: invoice.lineItems.map((l) => ({
        title: l.title,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
      })),
      subtotal: invoice.subtotal,
      taxAmount: invoice.taxAmount,
      total: invoice.total,
      payLinkId: invoice.transaction?.publicLinkId ?? null,
      seller: {
        displayName: invoice.seller.sellerProfile?.businessName ?? invoice.seller.fullName ?? null,
        verified: invoice.seller.sellerProfile?.verificationStatus === 'VERIFIED',
      },
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- invoices.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/invoices/invoices.service.ts src/modules/invoices/invoices.service.spec.ts
git commit -m "feat(invoices): public view projection + VIEWED marking (non-leak)"
```

---

## Task 8: Delivery over the notification queue

**Files:**
- Modify: `src/modules/queue/queue.constants.ts`
- Modify: `src/modules/notifications/notifications.service.ts`
- Modify: `src/modules/notifications/notification.processor.ts`
- Test: `src/modules/notifications/notification.processor.spec.ts`

- [ ] **Step 1: Add the job name + payload to `queue.constants.ts`**

Add under the notification queue constants:
```ts
export const INVOICE_DELIVERY_JOB = 'invoice';
```
Add the payload interface (near `OtpNotificationJobData`):
```ts
/** Payload of an invoice-delivery job. Carries no secrets — the worker re-loads
 *  the invoice and its public view id from Postgres. */
export interface InvoiceDeliveryJobData {
  invoiceId: string;
}
```

- [ ] **Step 2: Add producer + consumer to `notifications.service.ts`**

Add the imports:
```ts
import {
  INVOICE_DELIVERY_JOB,
  type InvoiceDeliveryJobData,
} from '@/modules/queue/queue.constants';
```
Add these methods to `NotificationsService`:
```ts
  /** Enqueue delivery of a sent invoice. jobId dedupes repeat sends. */
  async enqueueInvoice(data: InvoiceDeliveryJobData): Promise<void> {
    await this.queue.add(INVOICE_DELIVERY_JOB, data, {
      jobId: `invoice:${data.invoiceId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  /**
   * Worker-side invoice delivery. Prefers the buyer's chat surface when the
   * invoice is linked to a known chat user; otherwise emails the buyerEmail via
   * the pluggable sender. Records a Notification row only when a buyer user id is
   * known (the row requires a userId).
   */
  async deliverInvoice(data: InvoiceDeliveryJobData): Promise<void> {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: data.invoiceId } });
    if (!invoice) {
      this.logger.warn(`Invoice delivery skipped — ${data.invoiceId} not found`);
      return;
    }
    const payload = {
      invoiceId: invoice.id,
      number: invoice.number,
      total: invoice.total,
      publicViewId: invoice.publicViewId,
    };

    if (invoice.buyerId) {
      const chatIdentity = await this.prisma.chatIdentity.findFirst({
        where: { userId: invoice.buyerId },
        orderBy: { createdAt: 'asc' },
      });
      if (chatIdentity) {
        await this.chatQueue.enqueueChatOutbound({
          userId: invoice.buyerId,
          templateKey: 'invoice.sent',
          data: payload,
        });
        return;
      }
    }

    const to = invoice.buyerEmail;
    if (!to) {
      this.logger.warn(`Invoice ${invoice.id} has no deliverable contact — skipped`);
      return;
    }
    await this.sender.send({
      channel: NotificationChannel.EMAIL,
      to,
      templateKey: 'invoice.sent',
      data: payload,
    });
    if (invoice.buyerId) {
      await this.prisma.notification.create({
        data: {
          userId: invoice.buyerId,
          channel: NotificationChannel.EMAIL,
          templateKey: 'invoice.sent',
          payload,
          status: NotificationStatus.SENT,
          sentAt: new Date(),
        },
      });
    }
  }
```

- [ ] **Step 3: Route the job in `notification.processor.ts`**

Update the processor to handle both jobs:
```ts
import type { Job } from 'bullmq';
import type { NotificationsService } from './notifications.service';
import {
  INVOICE_DELIVERY_JOB,
  OTP_NOTIFICATION_JOB,
  type InvoiceDeliveryJobData,
  type OtpNotificationJobData,
} from '@/modules/queue/queue.constants';

export function createNotificationProcessor(notifications: NotificationsService) {
  return async function process(
    job: Job<OtpNotificationJobData | InvoiceDeliveryJobData>,
  ): Promise<void> {
    if (job.name === OTP_NOTIFICATION_JOB) {
      await notifications.deliverOtpCode(job.data as OtpNotificationJobData);
    } else if (job.name === INVOICE_DELIVERY_JOB) {
      await notifications.deliverInvoice(job.data as InvoiceDeliveryJobData);
    }
  };
}
```

- [ ] **Step 4: Add a processor-routing test**

Append to `src/modules/notifications/notification.processor.spec.ts`:
```ts
import { INVOICE_DELIVERY_JOB } from '@/modules/queue/queue.constants';

it('routes an invoice-delivery job to deliverInvoice', async () => {
  const notifications = {
    deliverOtpCode: jest.fn(),
    deliverInvoice: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('./notifications.service').NotificationsService;
  const process = createNotificationProcessor(notifications);
  await process({ name: INVOICE_DELIVERY_JOB, data: { invoiceId: 'inv-1' } } as never);
  expect((notifications.deliverInvoice as jest.Mock)).toHaveBeenCalledWith({ invoiceId: 'inv-1' });
});
```
(Ensure `createNotificationProcessor` is imported at the top of that spec — it already is if the OTP routing test exists; otherwise add `import { createNotificationProcessor } from './notification.processor';`.)

- [ ] **Step 5: Run the tests**

Run: `npm test -- notification.processor`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/queue/queue.constants.ts src/modules/notifications
git commit -m "feat(invoices): invoice delivery over the notification queue"
```

---

## Task 9: Controllers + module wiring

**Files:**
- Create: `src/modules/invoices/invoices.controller.ts`
- Create: `src/modules/invoices/public-invoices.controller.ts`
- Create: `src/modules/invoices/invoices.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Write the authenticated seller controller**

`src/modules/invoices/invoices.controller.ts`:

```ts
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Invoice } from '@prisma/client';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { ListInvoicesDto } from './dto/list-invoices.dto';

@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post()
  create(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Body() dto: CreateInvoiceDto,
  ): Promise<Invoice> {
    return this.invoices.createDraft(claims.sub, dto);
  }

  @Get()
  list(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Query() q: ListInvoicesDto,
  ): Promise<{ items: Invoice[]; nextCursor: string | null }> {
    return this.invoices.listForSeller(claims.sub, {
      ...(q.status ? { status: q.status } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
  }

  @Get(':id')
  async get(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Invoice> {
    const invoice = await this.invoices.getById(id);
    if (invoice.sellerId !== claims.sub && claims.appRole !== 'ADMIN') {
      throw new ForbiddenException('Not the owner of this invoice');
    }
    return invoice;
  }

  @Patch(':id')
  edit(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateInvoiceDto,
  ): Promise<Invoice> {
    return this.invoices.edit(claims.sub, id, dto);
  }

  @Post(':id/send')
  send(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Invoice> {
    return this.invoices.send(claims.sub, id);
  }

  @Post(':id/void')
  void(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Invoice> {
    return this.invoices.void(claims.sub, id);
  }

  @Post(':id/remind')
  async remind(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    const invoice = await this.invoices.getById(id);
    if (invoice.sellerId !== claims.sub) {
      throw new ForbiddenException('Not the owner of this invoice');
    }
    await this.invoices.remind(claims.sub, id);
    return { ok: true };
  }
}
```

- [ ] **Step 2: Add the `remind` method to the service**

In `src/modules/invoices/invoices.service.ts`, add:
```ts
  /** Re-deliver a sent invoice (throttled at the route). No-op for non-sent states. */
  async remind(sellerId: string, id: string): Promise<void> {
    const invoice = await this.loadOwned(sellerId, id);
    if (
      ![InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.OVERDUE].includes(invoice.status)
    ) {
      throw new BadRequestException('Only a sent, unpaid invoice can be reminded');
    }
    await this.notifications.enqueueInvoice({ invoiceId: id });
    await this.writeAudit(sellerId, id, 'invoice.reminded', invoice.status, invoice.status);
  }
```

- [ ] **Step 3: Write the list DTO**

`src/modules/invoices/dto/list-invoices.dto.ts`:
```ts
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { InvoiceStatus } from '@prisma/client';

export class ListInvoicesDto {
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
```

- [ ] **Step 4: Write the public controller**

`src/modules/invoices/public-invoices.controller.ts`:
```ts
import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@/modules/auth';
import { InvoicesService, type PublicInvoiceView } from './invoices.service';

/** Unauthenticated buyer-facing invoice view, keyed on the unguessable publicViewId. */
@Controller('public/invoices')
export class PublicInvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':publicViewId')
  get(@Param('publicViewId') publicViewId: string): Promise<PublicInvoiceView> {
    return this.invoices.getPublicView(publicViewId);
  }
}
```

- [ ] **Step 5: Write the module**

`src/modules/invoices/invoices.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { TransactionsModule } from '@/modules/transactions/transactions.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';
import { PublicInvoicesController } from './public-invoices.controller';
import { InvoiceOverdueService } from './invoice-overdue.service';

/**
 * Invoicing (Phase 1): itemized formal invoices that fund a protected Transaction.
 * Depends on TransactionsModule (to mint + publish the tx and drive CANCEL) and
 * NotificationsModule (delivery queue). Exports the service so the payments
 * protect path can derive invoice PAID.
 */
@Module({
  imports: [TransactionsModule, NotificationsModule],
  controllers: [InvoicesController, PublicInvoicesController],
  providers: [InvoicesService, InvoiceOverdueService],
  exports: [InvoicesService, InvoiceOverdueService],
})
export class InvoicesModule {}
```

(`InvoiceOverdueService` is created in Task 10. If executing strictly in order, add it to the module here and create the file in Task 10 before the next build; or temporarily omit it from providers/exports and add it in Task 10. The plan assumes you add the file in Task 10 immediately after.)

- [ ] **Step 6: Register in `app.module.ts`**

Add the import:
```ts
import { InvoicesModule } from './modules/invoices/invoices.module';
```
Add `InvoicesModule` to the `imports` array under `// domain` (e.g. after `WaitlistModule`).

Confirm `TransactionsModule` exports `TransactionsService` (needed by InvoicesModule). If it does not already, add `exports: [TransactionsService]` to `src/modules/transactions/transactions.module.ts`.

- [ ] **Step 7: Verify build + full unit suite**

Run: `npm run build && npm test`
Expected: build clean; all unit suites pass (including the payments spec updated in Task 6).

- [ ] **Step 8: Commit**

```bash
git add src/modules/invoices src/app.module.ts src/modules/transactions/transactions.module.ts
git commit -m "feat(invoices): controllers, list DTO, remind, module wiring"
```

---

## Task 10: Overdue cron scan

**Files:**
- Create: `src/modules/invoices/invoice-overdue.service.ts`
- Test: `src/modules/invoices/invoice-overdue.service.spec.ts`
- Modify: `src/cron.ts`

- [ ] **Step 1: Write the failing test**

`src/modules/invoices/invoice-overdue.service.spec.ts`:
```ts
import type { PrismaService } from '@/prisma/prisma.service';
import { InvoiceOverdueService } from './invoice-overdue.service';

describe('InvoiceOverdueService.scanAndMarkOverdue', () => {
  it('flips past-due SENT/VIEWED invoices to OVERDUE and reports the count', async () => {
    const prisma = {
      invoice: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    } as unknown as PrismaService;
    const service = new InvoiceOverdueService(prisma);

    const count = await service.scanAndMarkOverdue();

    expect(count).toBe(3);
    const call = (prisma.invoice.updateMany as jest.Mock).mock.calls[0][0];
    expect(call.where.status).toEqual({ in: ['SENT', 'VIEWED'] });
    expect(call.where.dueDate.lt).toBeInstanceOf(Date);
    expect(call.data.status).toBe('OVERDUE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- invoice-overdue`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/modules/invoices/invoice-overdue.service.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Marks past-due unpaid invoices OVERDUE. OVERDUE is a soft, reversible display
 * state — it never blocks payment, and reaching PAYMENT_PROTECTED still derives
 * PAID from it. Run by the cron entrypoint.
 */
@Injectable()
export class InvoiceOverdueService {
  private readonly logger = new Logger(InvoiceOverdueService.name);

  constructor(private readonly prisma: PrismaService) {}

  async scanAndMarkOverdue(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.invoice.updateMany({
      where: {
        status: { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED] },
        dueDate: { lt: now },
      },
      data: { status: InvoiceStatus.OVERDUE },
    });
    if (result.count > 0) {
      this.logger.log(`Marked ${result.count} invoice(s) OVERDUE`);
    }
    return result.count;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- invoice-overdue`
Expected: PASS.

- [ ] **Step 5: Wire into the cron entrypoint**

In `src/cron.ts`, resolve `InvoiceOverdueService` from the Nest application context and call `scanAndMarkOverdue()` alongside the existing `AutoReleaseService.scanAndRelease()` call. Follow the existing pattern in that file — e.g. after the auto-release block:
```ts
const invoiceOverdue = app.get(InvoiceOverdueService);
const overdueCount = await invoiceOverdue.scanAndMarkOverdue();
logger.log(`Invoice overdue scan marked ${overdueCount} invoice(s)`);
```
Add the import at the top:
```ts
import { InvoiceOverdueService } from './modules/invoices/invoice-overdue.service';
```
(Read `src/cron.ts` first to match its exact app-context bootstrap and logger usage.)

- [ ] **Step 6: Verify build + tests**

Run: `npm run build && npm test -- invoice-overdue`
Expected: build clean, test passes.

- [ ] **Step 7: Commit**

```bash
git add src/modules/invoices/invoice-overdue.service.ts src/modules/invoices/invoice-overdue.service.spec.ts src/cron.ts
git commit -m "feat(invoices): overdue cron scan"
```

---

## Task 11: E2e money-safety spec

**Files:**
- Create: `test/invoicing-money-safety.e2e-spec.ts`

Follow the harness in `test/utils/` and the shape of `test/chat-money-safety.e2e-spec.ts` (real app + Prisma against real Postgres; Paystack/auth/Redis faked). Read those first to reuse the exact setup helpers.

- [ ] **Step 1: Write the e2e spec**

`test/invoicing-money-safety.e2e-spec.ts` — cover, using the shared harness:

```ts
// Skip unless DATABASE_URL is set (mirrors the other money-safety e2e specs).
const describeIf = process.env.DATABASE_URL ? describe : describe.skip;

describeIf('Invoicing money safety (e2e)', () => {
  // 1. Sending an invoice mints exactly ONE transaction and one pay link.
  it('send creates exactly one linked transaction with amount == invoice total', async () => {
    // create draft with lines totalling 537_50; POST /invoices/:id/send;
    // assert invoice.transactionId set, tx.amount === 537_50, tx.status === LINK_ACTIVE,
    // and only one transaction exists for that invoice.
  });

  // 2. A client can NEVER mark an invoice PAID directly (no such endpoint; PAID
  //    only via the protect path).
  it('has no route to set PAID and stays SENT until the tx is protected', async () => {
    // send, then assert GET /invoices/:id status is SENT/VIEWED, not PAID.
  });

  // 3. Paying the invoice's transaction via the protect path derives PAID exactly once.
  it('reaching PAYMENT_PROTECTED flips the invoice to PAID (idempotent)', async () => {
    // drive the tx through the real protect path (faked Paystack verify + exact
    // amount), assert invoice PAID and paidAt set; re-run the protect no-op and
    // assert still PAID with the same paidAt.
  });

  // 4. Voiding a sent-unpaid invoice cancels its transaction; a paid invoice can't be voided.
  it('void cancels the linked tx; a paid invoice cannot be voided', async () => {
    // POST /void on a SENT invoice -> tx CANCELLED, invoice VOID.
    // On a PAID invoice -> 400, tx untouched.
  });
});
```

Fill each `it` body using the harness helpers (seed a seller/user, obtain a faked JWT, call the HTTP endpoints, assert DB rows). Keep amounts in kobo. Do not hit any network.

- [ ] **Step 2: Bring up the DB and run the e2e suite**

Run: `npm run db:up && npm run db:migrate:test && npm run test:e2e`
Expected: the invoicing e2e specs pass alongside the existing money-safety suites.

- [ ] **Step 3: Commit**

```bash
git add test/invoicing-money-safety.e2e-spec.ts
git commit -m "test(invoices): e2e money-safety specs for Phase 1 invoicing"
```

---

## Task 12: Final verification + status doc

**Files:**
- Modify: `CLAUDE.md` (Status section)

- [ ] **Step 1: Full verification gate**

Run: `npm run lint && npm run build && npm test`
Expected: all clean/green.

- [ ] **Step 2: Update the Status section in `CLAUDE.md`**

Add an `invoices/` bullet summarizing Phase 1: itemized formal invoices as a front-end onto one protected Transaction; server-owned totals + seller-sequential number; DRAFT→SENT→VIEWED→PAID→(OVERDUE)→VOID lifecycle; PAID derived from the protect path; new migration `20260803000000_invoicing_phase1`; delivery over the notification queue; public view. Note Phases 2 (direct/non-escrow) and 3 (recurring/batch) as deferred.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record Phase 1 invoicing in project status"
```

---

## Self-Review Notes

- **Spec coverage:** data model (T1), money math + client-can't-set-total (T2/T4), number allocation (T5), lifecycle guards edit/send/void (T4/T5), PAID derivation (T6), public non-leak view + VIEWED (T7), delivery (T8), endpoints (T9), overdue cron (T10), audit rows (T4/T5/T6/T9), e2e money-safety (T11). All spec sections map to a task.
- **Known Phase-1 limitation (documented in spec):** a crash between minting the tx and flipping the invoice in `send` can orphan a LINK_ACTIVE transaction with no buyer — harmless (never payable to completion), swept by the existing link-expiry path. Not worth a distributed transaction in Phase 1.
- **Type consistency:** `markPaidByTransaction`, `getPublicView`, `PublicInvoiceView`, `computeTotals`, `allocateNumber`, `scanAndMarkOverdue`, `enqueueInvoice`/`deliverInvoice`, `INVOICE_DELIVERY_JOB` used identically across tasks.
- **Dependency direction:** invoices → transactions, notifications; payments → invoices. No cycle (invoices never imports payments).
```
