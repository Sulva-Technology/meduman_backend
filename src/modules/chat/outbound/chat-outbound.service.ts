import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import type { ChatOutboundJobData } from '@/modules/queue/queue.constants';
import { ChatAdapterRegistry } from '../adapters/chat-adapter.registry';
import { renderChatTemplate } from './chat-templates';

/**
 * Delivers an outbound push to a chat user. Resolves the user's ChatIdentity,
 * renders the template, and sends via that platform's adapter. Runs in the
 * worker (driven by the chat queue), so webhook-originated pushes (DVA assigned,
 * payment protected) never do transport I/O inside an HTTP request.
 *
 * A user with no chat identity — or on a platform with no registered adapter —
 * is a silent no-op: website-only users simply don't get chat pushes.
 */
@Injectable()
export class ChatOutboundService {
  private readonly logger = new Logger(ChatOutboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChatAdapterRegistry,
  ) {}

  async deliver(job: ChatOutboundJobData): Promise<void> {
    const identity = await this.prisma.chatIdentity.findFirst({
      where: { userId: job.userId },
      orderBy: { createdAt: 'asc' },
    });
    if (!identity) return; // No chat surface for this user — nothing to do.

    const adapter = this.registry.get(identity.platform);
    if (!adapter) {
      this.logger.warn(`No adapter for ${identity.platform} — outbound dropped`);
      return;
    }

    const message = renderChatTemplate(job.templateKey, job.data);
    await adapter.send(identity.platformUserId, message);
  }
}
