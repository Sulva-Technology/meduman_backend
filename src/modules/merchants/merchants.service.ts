import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Merchant, MerchantStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import type { Env } from '@/config/env.validation';
import { generateApiKey, hashApiKey } from './api-key.crypto';

@Injectable()
export class MerchantsService {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('EAAS_API_KEY_SECRET', { infer: true });
  }

  async createMerchant(name: string): Promise<{ merchant: Merchant; apiKey: string }> {
    const merchant = await this.prisma.merchant.create({ data: { name } });
    const { apiKey } = await this.issueKey(merchant.id, false); // start in test mode
    return { merchant, apiKey };
  }

  async issueKey(
    merchantId: string,
    livemode: boolean,
  ): Promise<{ apiKey: string; keyId: string }> {
    const { plaintext, prefix } = generateApiKey(livemode);
    const created = await this.prisma.merchantApiKey.create({
      data: {
        merchantId,
        keyPrefix: prefix,
        keyHash: hashApiKey(plaintext, this.secret),
        livemode,
      },
    });
    return { apiKey: plaintext, keyId: created.id };
  }

  async revokeKey(merchantId: string, keyId: string): Promise<void> {
    await this.prisma.merchantApiKey.updateMany({
      where: { id: keyId, merchantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async verifyKey(plaintext: string): Promise<{ merchant: Merchant; livemode: boolean } | null> {
    const keyHash = hashApiKey(plaintext, this.secret);
    const row = await this.prisma.merchantApiKey.findUnique({
      where: { keyHash },
      include: { merchant: true },
    });
    if (!row || row.revokedAt || row.merchant.status !== 'ACTIVE') return null;
    await this.prisma.merchantApiKey.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    });
    return { merchant: row.merchant, livemode: row.livemode };
  }

  setLivemodeEnabled(merchantId: string, enabled: boolean): Promise<Merchant> {
    return this.prisma.merchant.update({
      where: { id: merchantId },
      data: { livemodeEnabled: enabled },
    });
  }

  setStatus(merchantId: string, status: MerchantStatus): Promise<Merchant> {
    return this.prisma.merchant.update({ where: { id: merchantId }, data: { status } });
  }
}
