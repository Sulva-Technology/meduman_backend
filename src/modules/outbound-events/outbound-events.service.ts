import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, OutboundEventStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { QueueService } from '@/modules/queue/queue.service';
import { buildOutboundEvent, type OutboundTxView } from './outbound-event.builder';

@Injectable()
export class OutboundEventsService {
  private readonly logger = new Logger(OutboundEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Write the outbox row INSIDE the caller's $transaction. Returns the event id or null. */
  async recordForTransition(
    db: Prisma.TransactionClient,
    eventType: string,
    tx: OutboundTxView,
  ): Promise<string | null> {
    if (!tx.merchantId) return null;
    const built = buildOutboundEvent(eventType, tx);
    if (!built) return null;
    const row = await db.outboundEvent.create({
      data: {
        merchantId: tx.merchantId,
        type: built.type,
        payload: built.payload as unknown as Prisma.InputJsonValue,
      },
    });
    return row.id;
  }

  /** Fast-path enqueue after commit. Swallow — the cron relay re-dispatches PENDING rows. */
  async dispatch(eventId: string): Promise<void> {
    try {
      await this.queue.enqueueWebhookDelivery(eventId);
    } catch (err) {
      this.logger.warn(
        `enqueue webhook delivery ${eventId} failed; relay will retry: ${String(err)}`,
      );
    }
  }

  async listForMerchant(
    merchantId: string,
    opts: { status?: OutboundEventStatus; cursor?: string; limit?: number },
  ): Promise<{
    items: Array<{
      id: string;
      type: string;
      status: OutboundEventStatus;
      attemptCount: number;
      createdAt: Date;
      deliveredAt: Date | null;
    }>;
    nextCursor: string | null;
  }> {
    const take = opts.limit ?? 20;
    const rows = await this.prisma.outboundEvent.findMany({
      where: { merchantId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, take).map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      attemptCount: r.attemptCount,
      createdAt: r.createdAt,
      deliveredAt: r.deliveredAt,
    }));
    const last = items.at(-1);
    const nextCursor = rows.length > take && last ? last.id : null;
    return { items, nextCursor };
  }
}
