import type { Job } from 'bullmq';
import {
  CHAT_INBOUND_JOB,
  CHAT_OUTBOUND_JOB,
  type ChatInboundJobData,
  type ChatOutboundJobData,
} from '@/modules/queue/queue.constants';
import type { ChatInboundService } from './gateway/chat-inbound.service';
import type { ChatOutboundService } from './outbound/chat-outbound.service';

/**
 * Build the BullMQ processor for the chat queue. Pure factory (no Nest/Worker
 * wiring) so job→service routing is unit-testable. The worker entrypoint
 * instantiates the BullMQ Worker with this function.
 */
export function createChatProcessor(inbound: ChatInboundService, outbound: ChatOutboundService) {
  return async function process(job: Job<ChatInboundJobData | ChatOutboundJobData>): Promise<void> {
    if (job.name === CHAT_INBOUND_JOB) {
      await inbound.processInbound(job.data as ChatInboundJobData);
      return;
    }
    if (job.name === CHAT_OUTBOUND_JOB) {
      await outbound.deliver(job.data as ChatOutboundJobData);
    }
  };
}
