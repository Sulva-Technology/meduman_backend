/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */
import { OutboundEventsService } from './outbound-events.service';

const tx = {
  id: 't1',
  status: 'PAYMENT_PROTECTED',
  amount: 1000,
  currency: 'NGN',
  title: 'X',
  merchantId: 'm1',
};

describe('OutboundEventsService.recordForTransition', () => {
  it('inserts an OutboundEvent via the tx client and returns its id', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'ev1' });
    const db = { outboundEvent: { create } } as any;
    const svc = new OutboundEventsService({} as any, { enqueueWebhookDelivery: jest.fn() } as any);
    const id = await svc.recordForTransition(db, 'PAYMENT_VERIFIED', tx);
    expect(id).toBe('ev1');
    expect(create.mock.calls[0][0].data).toMatchObject({
      merchantId: 'm1',
      type: 'transaction.protected',
    });
  });

  it('returns null (no insert) when merchantId is null', async () => {
    const create = jest.fn();
    const db = { outboundEvent: { create } } as any;
    const svc = new OutboundEventsService({} as any, {} as any);
    const id = await svc.recordForTransition(db, 'PAYMENT_VERIFIED', { ...tx, merchantId: null });
    expect(id).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('returns null when the transition maps to no event', async () => {
    const create = jest.fn();
    const db = { outboundEvent: { create } } as any;
    const svc = new OutboundEventsService({} as any, {} as any);
    expect(await svc.recordForTransition(db, 'SELLER_PUBLISH', tx)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
