import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { QueueService } from '@/modules/queue/queue.service';

/**
 * Cron-driven recovery for the outbound-webhook fast path. Enqueueing after
 * commit (`OutboundEventsService.dispatch`) can be lost (process crash,
 * transient Redis blip) and is swallowed rather than retried inline — this
 * relay is the backstop that finds PENDING rows stranded past a grace window
 * and re-enqueues them.
 */
@Injectable()
export class OutboundEventRelay {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Re-enqueue delivery for PENDING rows older than the grace window (fast-path lost). */
  async redispatchPending(graceSeconds = 60): Promise<number> {
    const cutoff = new Date(Date.now() - graceSeconds * 1000);
    const rows = await this.prisma.outboundEvent.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      select: { id: true },
      take: 500,
    });
    for (const r of rows) await this.queue.enqueueWebhookDelivery(r.id);
    return rows.length;
  }
}
