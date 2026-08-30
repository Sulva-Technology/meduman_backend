import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.validation';
import type { WebhookEndpointStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { generateWebhookSecret, encryptSecret, decryptSecret } from './webhook-secret.crypto';
import { assertPublicUrl } from './webhook-ssrf';

@Injectable()
export class WebhookEndpointsService {
  private readonly key: string;
  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.key = config.get('EAAS_WEBHOOK_SIGNING_KEY', { infer: true });
  }

  async setEndpoint(
    merchantId: string,
    livemode: boolean,
    url: string,
  ): Promise<{ id: string; url: string; secret: string }> {
    assertPublicUrl(url, { allowHttp: !livemode });
    const secret = generateWebhookSecret();
    const secretEnc = encryptSecret(secret, this.key);
    const row = await this.prisma.webhookEndpoint.upsert({
      where: { merchantId },
      create: { merchantId, url, secretEnc, livemode, status: 'ACTIVE' },
      update: { url, secretEnc, livemode, status: 'ACTIVE' },
    });
    return { id: row.id, url: row.url, secret };
  }

  async get(merchantId: string): Promise<{
    id: string;
    url: string;
    livemode: boolean;
    status: WebhookEndpointStatus;
    createdAt: Date;
  } | null> {
    const row = await this.prisma.webhookEndpoint.findUnique({ where: { merchantId } });
    if (!row) return null;
    return {
      id: row.id,
      url: row.url,
      livemode: row.livemode,
      status: row.status,
      createdAt: row.createdAt,
    };
  }

  async rotateSecret(merchantId: string): Promise<{ secret: string }> {
    const existing = await this.prisma.webhookEndpoint.findUnique({ where: { merchantId } });
    if (!existing) throw new NotFoundException('No webhook endpoint configured');
    const secret = generateWebhookSecret();
    await this.prisma.webhookEndpoint.update({
      where: { merchantId },
      data: { secretEnc: encryptSecret(secret, this.key) },
    });
    return { secret };
  }

  async disable(merchantId: string): Promise<void> {
    await this.prisma.webhookEndpoint.updateMany({
      where: { merchantId },
      data: { status: 'DISABLED' },
    });
  }

  /** Delivery-only: decrypt the secret for an ACTIVE endpoint. */
  async resolveForDelivery(
    merchantId: string,
  ): Promise<{ url: string; secret: string; livemode: boolean } | null> {
    const row = await this.prisma.webhookEndpoint.findUnique({ where: { merchantId } });
    if (!row || row.status !== 'ACTIVE') return null;
    return { url: row.url, secret: decryptSecret(row.secretEnc, this.key), livemode: row.livemode };
  }
}
