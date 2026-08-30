import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import { PrismaService } from '@/prisma/prisma.service';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { buildSignatureHeader } from './webhook-signing';
import { assertPublicUrl } from './webhook-ssrf';

/**
 * Delivers one OutboundEvent to the merchant's configured webhook endpoint.
 * Idempotent (skips an already-DELIVERED event), SSRF-checked at send time
 * (not just at endpoint-registration time), signed, timed out, and never
 * follows redirects. Failed attempts are recorded; once attempts are
 * exhausted the event is dead-lettered (FAILED) instead of retried forever —
 * BullMQ retries in between via a re-thrown error.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly endpoints: WebhookEndpointsService,
    config: ConfigService<Env, true>,
  ) {
    this.timeoutMs = config.get('WEBHOOK_DELIVERY_TIMEOUT_MS', { infer: true });
    this.maxAttempts = config.get('WEBHOOK_MAX_ATTEMPTS', { infer: true });
  }

  async deliver(eventId: string): Promise<void> {
    const event = await this.prisma.outboundEvent.findUnique({ where: { id: eventId } });
    if (!event || event.status === 'DELIVERED') return;

    const endpoint = await this.endpoints.resolveForDelivery(event.merchantId);
    if (!endpoint) {
      await this.prisma.outboundEvent.update({
        where: { id: eventId },
        data: { status: 'FAILED', lastError: 'no active endpoint' },
      });
      return;
    }

    try {
      assertPublicUrl(endpoint.url, { allowHttp: !endpoint.livemode });
      const rawBody = JSON.stringify({ id: event.id, type: event.type, data: event.payload });
      const ts = Math.floor(Date.now() / 1000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: { ok: boolean; status: number };
      try {
        res = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Meduman-Event-Id': event.id,
            'X-Meduman-Signature': buildSignatureHeader(endpoint.secret, ts, rawBody),
          },
          body: rawBody,
          redirect: 'error',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      await this.prisma.outboundEvent.update({
        where: { id: eventId },
        data: {
          status: 'DELIVERED',
          deliveredAt: new Date(),
          attemptCount: { increment: 1 },
          lastError: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = event.attemptCount + 1;

      // A blocked/private URL is a permanent failure (SSRF guard), not a
      // transient delivery error — dead-letter immediately, never retry.
      if (err instanceof BadRequestException) {
        await this.prisma.outboundEvent.update({
          where: { id: eventId },
          data: { attemptCount: attempts, lastError: message, status: 'FAILED' },
        });
        this.logger.warn(`webhook ${eventId} rejected (unsafe URL), not retrying: ${message}`);
        return;
      }

      const exhausted = attempts >= this.maxAttempts;
      await this.prisma.outboundEvent.update({
        where: { id: eventId },
        data: {
          attemptCount: attempts,
          lastError: message,
          ...(exhausted ? { status: 'FAILED' } : {}),
        },
      });
      if (!exhausted) throw err; // let BullMQ retry
      this.logger.warn(`webhook ${eventId} failed permanently after ${attempts}: ${message}`);
    }
  }
}
