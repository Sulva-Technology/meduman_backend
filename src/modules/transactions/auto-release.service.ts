import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActorType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { QueueService } from '@/modules/queue/queue.service';
import type { Env } from '@/config/env.validation';
import { TransactionsService } from './transactions.service';

/**
 * Auto-release scan (cron). Finds AUTO_AFTER_WINDOW transactions whose
 * confirmation window has elapsed, drives AUTO_CONFIRM through the machine (which
 * refuses if a dispute is open — money rule 5), and enqueues the release job.
 * Never releases inline; it only enqueues (money rule: retryable work off-request).
 */
@Injectable()
export class AutoReleaseService {
  private readonly logger = new Logger(AutoReleaseService.name);
  private readonly windowMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
    private readonly queue: QueueService,
    config: ConfigService<Env, true>,
  ) {
    this.windowMs = config.get('AUTO_RELEASE_WINDOW_HOURS', { infer: true }) * 3_600_000;
  }

  async scanAndRelease(now: Date = new Date()): Promise<{ released: number }> {
    const candidates = await this.prisma.transaction.findMany({
      where: { status: 'CONFIRMATION_PENDING', releaseRule: 'AUTO_AFTER_WINDOW' },
      include: {
        timeline: {
          where: { newState: 'CONFIRMATION_PENDING' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    let released = 0;
    for (const tx of candidates) {
      const enteredAt = tx.timeline[0]?.createdAt;
      if (!enteredAt) continue;
      if (now.getTime() - enteredAt.getTime() < this.windowMs) continue;

      try {
        await this.transactions.apply({
          transactionId: tx.id,
          event: { type: 'AUTO_CONFIRM' },
          actor: { type: ActorType.SYSTEM, role: 'SYSTEM' },
          reason: 'auto-release window elapsed',
          context: { autoConfirmWindowElapsed: true },
        });
        await this.queue.enqueueRelease(tx.id);
        released++;
      } catch (err) {
        // Refused (dispute open / concurrent change) or enqueue failure — skip and
        // keep scanning; the next tick retries.
        this.logger.warn(`Auto-release skipped ${tx.id}: ${(err as Error).message}`);
      }
    }

    return { released };
  }
}
