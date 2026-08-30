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
