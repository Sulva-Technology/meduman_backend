import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Invoice } from '@prisma/client';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { ListInvoicesDto } from './dto/list-invoices.dto';

/**
 * Authenticated seller invoicing surface. Protected by the global guard; every
 * route is ownership-scoped to the calling seller (`claims.sub`). The service
 * enforces ownership on edit/send/void/remind via loadOwned; the plain GET/:id
 * read gets an explicit owner guard here.
 */
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  /** Create a DRAFT invoice owned by the calling seller. */
  @Post()
  create(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Body() dto: CreateInvoiceDto,
  ): Promise<Invoice> {
    return this.invoices.createDraft(claims.sub, dto);
  }

  /** Seller-scoped list. Declared before `:id` so the static path wins. */
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

  /** Ownership-checked read. getById does not check ownership — guard here. */
  @Get(':id')
  async get(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Invoice> {
    const invoice = await this.invoices.getById(id);
    if (invoice.sellerId !== claims.sub) {
      throw new ForbiddenException('Not the owner of this invoice');
    }
    return invoice;
  }

  /** Edit a DRAFT invoice (service asserts ownership + DRAFT). */
  @Patch(':id')
  edit(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateInvoiceDto,
  ): Promise<Invoice> {
    return this.invoices.edit(claims.sub, id, dto);
  }

  /** Send a DRAFT invoice: mint the protected tx, allocate number, deliver. */
  @Post(':id/send')
  send(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Invoice> {
    return this.invoices.send(claims.sub, id);
  }

  /** Void a pre-PAID invoice (cancels the linked tx if any). */
  @Post(':id/void')
  void(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Invoice> {
    return this.invoices.void(claims.sub, id);
  }

  /** Re-deliver a live invoice to its buyer contact. Rate-limited — re-delivery
   * is abuse-sensitive (mirrors the OTP request route's tight cap). */
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post(':id/remind')
  @HttpCode(HttpStatus.NO_CONTENT)
  remind(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.invoices.remind(claims.sub, id);
  }
}
