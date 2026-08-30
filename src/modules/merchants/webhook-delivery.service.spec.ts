/* eslint-disable @typescript-eslint/no-explicit-any */
import { WebhookDeliveryService } from './webhook-delivery.service';

function build(event: any, endpoint: any, fetchImpl: any) {
  const prisma = {
    outboundEvent: {
      findUnique: jest.fn().mockResolvedValue(event),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
  const endpoints = { resolveForDelivery: jest.fn().mockResolvedValue(endpoint) } as any;
  const config = { get: (k: string) => (k === 'WEBHOOK_DELIVERY_TIMEOUT_MS' ? 5000 : 5) } as any;
  global.fetch = fetchImpl;
  return { svc: new WebhookDeliveryService(prisma, endpoints, config), prisma };
}

const event = {
  id: 'ev1',
  merchantId: 'm1',
  type: 'transaction.protected',
  payload: { transactionId: 't1' },
  status: 'PENDING',
  attemptCount: 0,
};
const endpoint = { url: 'https://hooks.example.com/x', secret: 'whsec_x', livemode: true };

describe('WebhookDeliveryService.deliver', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('marks DELIVERED on a 2xx response', async () => {
    const { svc, prisma } = build(
      event,
      endpoint,
      jest.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
    await svc.deliver('ev1');
    expect(prisma.outboundEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DELIVERED' }) }),
    );
  });

  it('is idempotent — skips an already DELIVERED event', async () => {
    const { svc, prisma } = build({ ...event, status: 'DELIVERED' }, endpoint, jest.fn());
    await svc.deliver('ev1');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.outboundEvent.update).not.toHaveBeenCalled();
  });

  it('marks FAILED when there is no active endpoint', async () => {
    const { svc, prisma } = build(event, null, jest.fn());
    await svc.deliver('ev1');
    expect(prisma.outboundEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('throws on a 500 (BullMQ will retry) and records the attempt', async () => {
    const { svc } = build(event, endpoint, jest.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(svc.deliver('ev1')).rejects.toBeTruthy();
  });

  it('marks FAILED without throwing when the endpoint URL fails the SSRF check', async () => {
    const { svc, prisma } = build(
      event,
      { url: 'http://169.254.169.254/latest/meta-data', secret: 'whsec_x', livemode: false },
      jest.fn(),
    );
    await expect(svc.deliver('ev1')).resolves.toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.outboundEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('marks FAILED once attempts are exhausted', async () => {
    const { svc, prisma } = build(
      { ...event, attemptCount: 4 },
      endpoint,
      jest.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    await expect(svc.deliver('ev1')).resolves.toBeUndefined(); // no throw on final attempt
    expect(prisma.outboundEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });
});
