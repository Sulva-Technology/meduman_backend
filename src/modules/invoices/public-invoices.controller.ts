import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@/modules/auth';
import { InvoicesService } from './invoices.service';
import type { PublicInvoiceView } from './public-invoice-view';

/**
 * Unauthenticated buyer-facing invoice read, keyed on the unguessable
 * publicViewId (a 32-char hex string — NOT a uuid, so no ParseUUIDPipe).
 * Returns only the allow-listed projection and only for a sent invoice (a DRAFT
 * 404s). The buyer is never an authenticated participant here, so this is the
 * one deliberate public invoice read.
 */
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
