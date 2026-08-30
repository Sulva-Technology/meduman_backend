import type { InvoiceStatus } from '@prisma/client';

/** A public invoice line — pricing only, no internal ids. */
export interface PublicInvoiceLine {
  title: string;
  description: string | null;
  quantity: number;
  unitPrice: number; // kobo
  lineTotal: number; // kobo
}

/**
 * Allow-listed buyer-facing invoice projection. Contains ONLY fields safe to
 * show a buyer. It deliberately omits transactionId, sellerId, buyer auth id,
 * and every payout/idempotency field (money-safety non-leak).
 */
export interface PublicInvoiceView {
  number: string;
  status: InvoiceStatus;
  issueDate: Date;
  dueDate: Date | null;
  currency: string;
  buyerName: string | null;
  lineItems: PublicInvoiceLine[];
  subtotal: number;
  taxAmount: number;
  total: number;
  notes: string | null;
  terms: string | null;
  sellerName: string | null;
  sellerBadgeSlug: string | null;
  /** The pay link (publicLinkId) once the invoice has been sent; null otherwise. */
  payLinkId: string | null;
}

/** Shape this mapper needs — a subset of the Invoice row with relations loaded. */
export interface InvoiceForPublicView {
  number: string;
  status: InvoiceStatus;
  issueDate: Date;
  dueDate: Date | null;
  currency: string;
  buyerName: string | null;
  subtotal: number;
  taxAmount: number;
  total: number;
  notes: string | null;
  terms: string | null;
  lineItems: {
    title: string;
    description: string | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
  transaction: { publicLinkId: string } | null;
  seller: {
    fullName: string | null;
    sellerProfile: { businessName: string | null; badgeSlug: string | null } | null;
  } | null;
}

/** Map a loaded Invoice row to the allow-listed public view. Pure. */
export function toPublicInvoiceView(invoice: InvoiceForPublicView): PublicInvoiceView {
  return {
    number: invoice.number,
    status: invoice.status,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    buyerName: invoice.buyerName,
    lineItems: invoice.lineItems.map((l) => ({
      title: l.title,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
    })),
    subtotal: invoice.subtotal,
    taxAmount: invoice.taxAmount,
    total: invoice.total,
    notes: invoice.notes,
    terms: invoice.terms,
    sellerName: invoice.seller?.sellerProfile?.businessName ?? invoice.seller?.fullName ?? null,
    sellerBadgeSlug: invoice.seller?.sellerProfile?.badgeSlug ?? null,
    payLinkId: invoice.transaction?.publicLinkId ?? null,
  };
}
