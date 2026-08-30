import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { ApiKeyGuard, type MerchantContext } from './api-key.guard';
import { CurrentMerchant } from './decorators/current-merchant.decorator';
import { MerchantSellersService } from './merchant-sellers.service';
import { TransactionsService } from '@/modules/transactions/transactions.service';
import { CreateV1TransactionDto } from './dto/create-v1-transaction.dto';
import { ListV1TransactionsDto } from './dto/list-v1-transactions.dto';
import type { Env } from '@/config/env.validation';

/**
 * Public /v1 API — gated by ApiKeyGuard, NOT the global Supabase JWT guard.
 * @Public() makes SupabaseJwtGuard skip this controller; ApiKeyGuard is the
 * real gate. The state machine stays the sole owner of TransactionStatus:
 * `publish` drives an intent through `apply()`, never a direct status write
 * (money rule 1). Every handler is merchant-scoped via @CurrentMerchant +
 * an ownership gate (assertOwnedSeller / getByIdForMerchant) before touching
 * a row belonging to another merchant.
 */
@Public()
@UseGuards(ApiKeyGuard)
@Controller('v1/transactions')
export class V1TransactionsController {
  private readonly appUrl: string;
  constructor(
    private readonly transactions: TransactionsService,
    private readonly sellers: MerchantSellersService,
    config: ConfigService<Env, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  @Post()
  async create(@CurrentMerchant() m: MerchantContext, @Body() dto: CreateV1TransactionDto) {
    await this.sellers.assertOwnedSeller(m.id, dto.sellerId); // 404 if not this merchant's seller
    const tx = await this.transactions.createDraft({
      merchantId: m.id,
      sellerId: dto.sellerId,
      title: dto.title,
      amount: dto.amount,
      ...(dto.description ? { description: dto.description } : {}),
      ...(dto.currency ? { currency: dto.currency } : {}),
      ...(dto.releaseRule ? { releaseRule: dto.releaseRule } : {}),
    });
    return this.view(tx);
  }

  @Get()
  async list(@CurrentMerchant() m: MerchantContext, @Query() q: ListV1TransactionsDto) {
    const { items, nextCursor } = await this.transactions.listForMerchant(m.id, q);
    return { items: items.map((tx) => this.view(tx)), nextCursor };
  }

  @Get(':id')
  async get(@CurrentMerchant() m: MerchantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.view(await this.transactions.getByIdForMerchant(m.id, id));
  }

  @Post(':id/publish')
  async publish(
    @CurrentMerchant() m: MerchantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.transactions.getByIdForMerchant(m.id, id); // ownership gate (404 otherwise)
    const tx = await this.transactions.apply({
      transactionId: id,
      event: { type: 'SELLER_PUBLISH' },
      actor: { id: m.id, type: 'SYSTEM', role: 'MERCHANT' },
    });
    return this.view(tx);
  }

  /** Lean, merchant-safe projection (no internal secrets); adds the hosted pay link. */
  private view(tx: {
    id: string;
    publicLinkId: string;
    status: string;
    amount: number;
    currency: string;
    title: string;
  }) {
    return {
      id: tx.id,
      status: tx.status,
      amount: tx.amount,
      currency: tx.currency,
      title: tx.title,
      payLinkUrl: `${this.appUrl}/pay/${tx.publicLinkId}`,
    };
  }
}
