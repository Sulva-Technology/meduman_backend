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
import { toPublicInvoiceView, type PublicInvoiceView } from './public-invoice-view';
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

    // Recompute totals whenever the lines OR the tax rate change — a tax-only
    // edit must not leave stale totals (server owns the math, rule 1). When no
    // new lines are supplied, recompute against the invoice's current lines.
    if (lines !== undefined || dto.taxRatePctBp !== undefined) {
      const rate = dto.taxRatePctBp ?? invoice.taxRatePctBp ?? null;
      const effectiveLines =
        lines ??
        (await this.prisma.invoiceLineItem.findMany({
          where: { invoiceId: id },
          orderBy: { position: 'asc' },
        }));
      const totals = computeTotals(
        effectiveLines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice })),
        rate,
      );
      data.subtotal = totals.subtotal;
      data.taxAmount = totals.taxAmount;
      data.total = totals.total;
      if (lines) {
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

  /**
   * Buyer-facing public view keyed on the unguessable publicViewId. Marks a
   * first open as VIEWED (SENT -> VIEWED). 404s a DRAFT (never sent) or missing
   * invoice. Returns only the allow-listed projection — no internal ids.
   */
  async getPublicView(publicViewId: string): Promise<PublicInvoiceView> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { publicViewId },
      include: {
        lineItems: { orderBy: { position: 'asc' } },
        transaction: { select: { publicLinkId: true } },
        seller: {
          select: {
            fullName: true,
            sellerProfile: { select: { businessName: true, badgeSlug: true } },
          },
        },
      },
    });
    if (!invoice || invoice.status === InvoiceStatus.DRAFT) {
      throw new NotFoundException('Invoice not found');
    }
    // Mark first open as VIEWED (only from SENT). Reflect it in the response.
    if (invoice.status === InvoiceStatus.SENT) {
      await this.prisma.invoice.updateMany({
        where: { id: invoice.id, status: InvoiceStatus.SENT },
        data: { status: InvoiceStatus.VIEWED, viewedAt: new Date() },
      });
      invoice.status = InvoiceStatus.VIEWED;
    }
    return toPublicInvoiceView(invoice);
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
   * Re-deliver a live invoice to its buyer contact. Allowed only once sent and
   * before settlement (SENT / VIEWED / OVERDUE). Route-level throttling caps the
   * rate (see the controller). Writes an audit row.
   */
  async remind(sellerId: string, id: string): Promise<void> {
    const invoice = await this.loadOwned(sellerId, id);
    const remindable: InvoiceStatus[] = [
      InvoiceStatus.SENT,
      InvoiceStatus.VIEWED,
      InvoiceStatus.OVERDUE,
    ];
    if (!remindable.includes(invoice.status)) {
      throw new BadRequestException(`Cannot remind an invoice in status ${invoice.status}`);
    }
    await this.writeAudit(sellerId, id, 'invoice.reminded', invoice.status, invoice.status);
    await this.notifications.enqueueInvoice({ invoiceId: id });
  }

  /**
   * Cron: flip past-due unpaid invoices to OVERDUE. OVERDUE is a soft, reversible
   * display state — it does not block payment; a buyer can still pay and the
   * protect hook moves it to PAID. Idempotent (already-OVERDUE rows are excluded
   * by the status filter). Returns the number flipped.
   */
  async scanOverdue(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.invoice.updateMany({
      where: {
        status: { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED] },
        dueDate: { lt: now },
      },
      data: { status: InvoiceStatus.OVERDUE },
    });
    return result.count;
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
