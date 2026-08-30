import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ActorType, type Dispute, type TimelineEvent, type Transaction } from '@prisma/client';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import type { SupabaseJwtClaims } from '@/modules/auth';
import { QueueService } from '@/modules/queue/queue.service';
import { TransactionsService, type PayoutView } from './transactions.service';
import type { TransactionEvent } from './state-machine';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';

@Controller('transactions')
export class TransactionsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly queue: QueueService,
  ) {}

  /** Seller creates a DRAFT transaction. */
  @Post()
  async create(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Body() dto: CreateTransactionDto,
  ): Promise<Transaction> {
    return this.transactions.createDraft({
      sellerId: claims.sub,
      title: dto.title,
      amount: dto.amount,
      ...(dto.description ? { description: dto.description } : {}),
      ...(dto.releaseRule ? { releaseRule: dto.releaseRule } : {}),
      ...(dto.feeModel ? { feeModel: dto.feeModel } : {}),
      ...(dto.feeAmount !== undefined ? { feeAmount: dto.feeAmount } : {}),
    });
  }

  /** Role-scoped list for the caller's dashboard. Declared before `:id` so the
   * static path wins the route match. */
  @Get()
  list(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Query() q: ListTransactionsDto,
  ): Promise<{ items: Transaction[]; nextCursor: string | null }> {
    return this.transactions.listForUser(claims.sub, {
      role: q.role,
      ...(q.status ? { status: q.status } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
  }

  @Get(':id')
  async get(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Transaction> {
    const tx = await this.transactions.getById(id);
    this.assertParticipant(tx, claims);
    return tx;
  }

  @Get(':id/timeline')
  async timeline(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TimelineEvent[]> {
    const tx = await this.transactions.getById(id);
    this.assertParticipant(tx, claims);
    return this.transactions.getTimeline(id);
  }

  @Get(':id/disputes')
  async disputes(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Dispute[]> {
    const tx = await this.transactions.getById(id);
    this.assertParticipant(tx, claims);
    return this.transactions.getDisputesForTx(id);
  }

  @Get(':id/payouts')
  async payouts(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PayoutView[]> {
    const tx = await this.transactions.getById(id);
    this.assertParticipant(tx, claims);
    return this.transactions.getPayoutsForTx(id);
  }

  @Post(':id/publish')
  async publish(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Transaction> {
    return this.sellerAction(claims, id, { type: 'SELLER_PUBLISH' });
  }

  @Post(':id/start-delivery')
  async startDelivery(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Transaction> {
    return this.sellerAction(claims, id, { type: 'SELLER_START_DELIVERY' });
  }

  @Post(':id/mark-delivered')
  async markDelivered(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Transaction> {
    return this.sellerAction(claims, id, { type: 'SELLER_MARK_DELIVERED' });
  }

  /**
   * Buyer confirms delivery — enters RELEASE_PROCESSING (unless a dispute freezes
   * it) and enqueues the idempotent payout. The release runs off-request.
   */
  @Post(':id/confirm')
  async confirm(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Transaction> {
    const tx = await this.transactions.getById(id);
    if (tx.buyerId !== claims.sub) {
      throw new ForbiddenException('Only the buyer can confirm this transaction');
    }

    const updated = await this.transactions.apply({
      transactionId: id,
      event: { type: 'BUYER_CONFIRM' },
      actor: { id: claims.sub, type: ActorType.USER, role: 'BUYER' },
    });

    await this.queue.enqueueRelease(id);
    return updated;
  }

  /** Seller aborts a DRAFT / LINK_ACTIVE before any funds are protected. The
   * machine rejects CANCEL from every protected/released state, so no money can
   * move; the transition still writes a timeline + audit row (rule 6). */
  @Post(':id/cancel')
  cancel(
    @CurrentUser() claims: SupabaseJwtClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Transaction> {
    return this.sellerAction(claims, id, { type: 'CANCEL' });
  }

  /** Allow only a participant (buyer/seller) or an ADMIN to read a transaction. */
  private assertParticipant(tx: Transaction, claims: SupabaseJwtClaims): void {
    const isParticipant = tx.sellerId === claims.sub || tx.buyerId === claims.sub;
    if (!isParticipant && claims.appRole !== 'ADMIN') {
      throw new ForbiddenException('Not a participant of this transaction');
    }
  }

  /** Load, assert seller ownership, then drive the given seller-sourced event. */
  private async sellerAction(
    claims: SupabaseJwtClaims,
    id: string,
    event: TransactionEvent,
  ): Promise<Transaction> {
    const tx = await this.transactions.getById(id);
    if (tx.sellerId !== claims.sub) {
      throw new ForbiddenException('Only the seller can perform this action');
    }
    return this.transactions.apply({
      transactionId: id,
      event,
      actor: { id: claims.sub, type: ActorType.USER, role: 'SELLER' },
    });
  }
}
