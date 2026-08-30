import { buildOutboundEvent } from './outbound-event.builder';

const tx = {
  id: 't1',
  status: 'PAYMENT_PROTECTED',
  amount: 1000,
  currency: 'NGN',
  title: 'X',
  merchantId: 'm1',
};

describe('buildOutboundEvent', () => {
  it('maps PAYMENT_VERIFIED to transaction.protected with a lean payload', () => {
    const out = buildOutboundEvent('PAYMENT_VERIFIED', tx);
    expect(out?.type).toBe('transaction.protected');
    expect(out?.payload).toEqual({
      transactionId: 't1',
      status: 'PAYMENT_PROTECTED',
      amount: 1000,
      currency: 'NGN',
      title: 'X',
    });
  });

  it('maps the money + dispute transitions', () => {
    expect(buildOutboundEvent('PAYOUT_SUCCEEDED', tx)?.type).toBe('funds.released');
    expect(buildOutboundEvent('CANCEL', tx)?.type).toBe('transaction.cancelled');
    expect(buildOutboundEvent('RAISE_DISPUTE', tx)?.type).toBe('dispute.opened');
    expect(buildOutboundEvent('RESOLVE_DISPUTE_FOR_SELLER', tx)?.type).toBe('dispute.resolved');
    expect(buildOutboundEvent('RESOLVE_DISPUTE_FOR_BUYER', tx)?.type).toBe('dispute.resolved');
  });

  it('returns null for transitions that emit nothing', () => {
    expect(buildOutboundEvent('SELLER_PUBLISH', tx)).toBeNull();
    expect(buildOutboundEvent('BUYER_CONFIRM', tx)).toBeNull();
  });
});
