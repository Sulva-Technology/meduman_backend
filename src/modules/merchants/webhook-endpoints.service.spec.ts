/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { decryptSecret } from './webhook-secret.crypto';

const KEY = 'test-eaas-webhook-signing-key-0000000000';

function build(store: any = {}) {
  const prisma = {
    webhookEndpoint: {
      upsert: jest.fn(async ({ create }: any) => {
        store.row = { id: 'we1', ...create };
        return store.row;
      }),
      findUnique: jest.fn(async () => store.row ?? null),
      update: jest.fn(async ({ data }: any) => {
        store.row = { ...store.row, ...data };
        return store.row;
      }),
    },
  } as any;
  const config = { get: () => KEY } as any;
  return { svc: new WebhookEndpointsService(prisma, config), store, prisma };
}

describe('WebhookEndpointsService', () => {
  it('stores the secret encrypted and returns the plaintext once', async () => {
    const { svc, store } = build();
    const res = await svc.setEndpoint('m1', true, 'https://hooks.example.com/x');
    expect(res.secret.startsWith('whsec_')).toBe(true);
    expect(store.row.secretEnc).not.toContain(res.secret); // encrypted at rest
    expect(decryptSecret(store.row.secretEnc, KEY)).toBe(res.secret);
    expect(store.row.livemode).toBe(true);
  });

  it('rejects an http URL for a live endpoint (SSRF/https rule)', async () => {
    const { svc } = build();
    await expect(svc.setEndpoint('m1', true, 'http://hooks.example.com')).rejects.toBeTruthy();
  });

  it('allows http for a test endpoint', async () => {
    const { svc } = build();
    await expect(svc.setEndpoint('m1', false, 'http://hooks.example.com')).resolves.toBeTruthy();
  });

  it('resolveForDelivery decrypts and get never returns the secret', async () => {
    const { svc } = build();
    await svc.setEndpoint('m1', true, 'https://hooks.example.com/x');
    const got: any = await svc.get('m1');
    expect(got.secret).toBeUndefined();
    expect(got.secretEnc).toBeUndefined();
    const del = await svc.resolveForDelivery('m1');
    expect(del?.secret.startsWith('whsec_')).toBe(true);
  });
});
