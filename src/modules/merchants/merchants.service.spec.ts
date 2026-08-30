import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MerchantsService } from './merchants.service';
import { PrismaService } from '@/prisma/prisma.service';
import { hashApiKey } from './api-key.crypto';

const SECRET = 'unit-secret-0000000000';

function makeConfig() {
  return { get: () => SECRET } as never;
}

function makePrisma() {
  const merchantCreate = jest.fn();
  const merchantUpdate = jest.fn();
  const apiKeyCreate = jest.fn();
  const apiKeyFindUnique = jest.fn();
  const apiKeyUpdate = jest.fn();
  const apiKeyUpdateMany = jest.fn();

  const prisma = {
    merchant: { create: merchantCreate, update: merchantUpdate },
    merchantApiKey: {
      create: apiKeyCreate,
      findUnique: apiKeyFindUnique,
      update: apiKeyUpdate,
      updateMany: apiKeyUpdateMany,
    },
  } as unknown as PrismaService;

  return {
    prisma,
    merchantCreate,
    merchantUpdate,
    apiKeyCreate,
    apiKeyFindUnique,
    apiKeyUpdate,
    apiKeyUpdateMany,
  };
}

async function build(prisma: PrismaService) {
  const mod = await Test.createTestingModule({
    providers: [
      MerchantsService,
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: makeConfig() },
    ],
  }).compile();
  return mod.get(MerchantsService);
}

describe('MerchantsService', () => {
  it('createMerchant returns a one-time plaintext key and stores only its hash', async () => {
    const { prisma, merchantCreate, apiKeyCreate } = makePrisma();
    merchantCreate.mockResolvedValue({ id: 'm1', name: 'Acme' });
    apiKeyCreate.mockResolvedValue({ id: 'k1' });
    const svc = await build(prisma);

    const { merchant, apiKey } = await svc.createMerchant('Acme');

    expect(merchant.id).toBe('m1');
    expect(apiKey.startsWith('sk_test_')).toBe(true); // new merchant starts in test mode
    const stored = apiKeyCreate.mock.calls[0][0].data;
    expect(stored.keyHash).toBe(hashApiKey(apiKey, SECRET));
    expect(JSON.stringify(stored)).not.toContain(apiKey); // plaintext never persisted
  });

  it('verifyKey resolves the merchant for a known, non-revoked key and stamps lastUsedAt', async () => {
    const { prisma, apiKeyFindUnique, apiKeyUpdate } = makePrisma();
    const svc = await build(prisma);
    const plaintext = 'sk_live_' + 'a'.repeat(40);
    apiKeyFindUnique.mockResolvedValue({
      id: 'k1',
      merchantId: 'm1',
      livemode: true,
      revokedAt: null,
      merchant: { id: 'm1', status: 'ACTIVE', livemodeEnabled: true },
    });

    const res = await svc.verifyKey(plaintext);

    expect(apiKeyFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { keyHash: hashApiKey(plaintext, SECRET) } }),
    );
    expect(res?.merchant.id).toBe('m1');
    expect(res?.livemode).toBe(true);
    expect(apiKeyUpdate).toHaveBeenCalled(); // lastUsedAt stamped
  });

  it('verifyKey returns null for a revoked key', async () => {
    const { prisma, apiKeyFindUnique } = makePrisma();
    const svc = await build(prisma);
    apiKeyFindUnique.mockResolvedValue({
      id: 'k1',
      merchantId: 'm1',
      livemode: true,
      revokedAt: new Date(),
      merchant: { id: 'm1', status: 'ACTIVE', livemodeEnabled: true },
    });
    expect(await svc.verifyKey('sk_live_' + 'a'.repeat(40))).toBeNull();
  });

  it('verifyKey returns null for a suspended merchant', async () => {
    const { prisma, apiKeyFindUnique } = makePrisma();
    const svc = await build(prisma);
    apiKeyFindUnique.mockResolvedValue({
      id: 'k1',
      merchantId: 'm1',
      livemode: false,
      revokedAt: null,
      merchant: { id: 'm1', status: 'SUSPENDED', livemodeEnabled: false },
    });
    expect(await svc.verifyKey('sk_test_' + 'a'.repeat(40))).toBeNull();
  });
});
