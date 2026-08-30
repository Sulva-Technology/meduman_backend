import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@/modules/auth';
import { TransactionsService, type PublicTransactionView } from './transactions.service';

/**
 * Unauthenticated pay-page read. Returns only an allow-listed projection and
 * only for payable statuses (see TransactionsService.getPublicByLinkId). The
 * buyer is never a participant yet at this point, so the authed `/transactions/:id`
 * read can't serve this — this is the one deliberate public transaction read.
 */
@Controller('public/transactions')
export class PublicTransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':publicLinkId')
  get(@Param('publicLinkId') publicLinkId: string): Promise<PublicTransactionView> {
    return this.transactions.getPublicByLinkId(publicLinkId);
  }
}
