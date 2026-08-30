import { UnauthorizedException } from '@nestjs/common';
import type { PrismaService } from '@/prisma/prisma.service';
import type { PaystackService } from '@/common/paystack';
import type { PaymentsService } from '@/modules/payments/payments.service';
import type { PayoutsService } from '@/modules/payouts/payouts.service';
import { WebhooksService } from './webhooks.service';

function makeDeps(opts: { validSig?: boolean; duplicate?: boolean; maxAge?: number } = {}) {
  const paystack = {
    verifyWebhookSignature: jest.fn().mockReturnValue(opts.validSig ?? true),
  } as unknown as PaystackService;

  const config = { get: () => opts.maxAge ?? 86_400 } as never;

  const create = opts.duplicate
    ? jest.fn().mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
    : jest.fn().mockResolvedValue({ id: 'we-1' });

  const prisma = {
    webhookEvent: {
      create,
      update: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;

  const handleChargeSuccess = jest.fn().mockResolvedValue({});
  const payments = { handleChargeSuccess } as unknown as PaymentsService;

  const markPaid = jest.fn().mockResolvedValue({});
  const markFailed = jest.fn().mockResolvedValue({});
  const payouts = { markPaid, markFailed } as unknown as PayoutsService;

  const service = new WebhooksService(prisma, paystack, payments, payouts, config);
  return { service, create, handleChargeSuccess, markPaid, markFailed };
}

function body(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj));
}

describe('WebhooksService.handlePaystackEvent', () => {
  it('rejects an invalid signature and neither records nor processes', async () => {
    const { service, create, handleChargeSuccess } = makeDeps({ validSig: false });

    await expect(
      service.handlePaystackEvent(body({ event: 'charge.success' }), 'bad'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(create).not.toHaveBeenCalled();
    expect(handleChargeSuccess).not.toHaveBeenCalled();
  });

  it('records the event and protects the payment on charge.success', async () => {
    const { service, create, handleChargeSuccess } = makeDeps();
    const raw = body({ event: 'charge.success', data: { id: 99, reference: 'mdn_ref' } });

    await service.handlePaystackEvent(raw, 'sig');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'charge.success' }),
      }),
    );
    expect(handleChargeSuccess).toHaveBeenCalledWith({ reference: 'mdn_ref' }, 'WEBHOOK');
  });

  it('marks the payout FAILED on transfer.failed, never completing the transaction', async () => {
    const { service, markFailed, markPaid } = makeDeps();
    const raw = body({
      event: 'transfer.failed',
      data: {
        id: 7,
        reference: 'release:tx-1',
        transfer_code: 'TRF_1',
        status: 'failed',
        reason: 'account closed',
      },
    });

    await service.handlePaystackEvent(raw, 'sig');

    expect(markFailed).toHaveBeenCalledWith('release:tx-1', 'FAILED', expect.any(String));
    expect(markPaid).not.toHaveBeenCalled();
  });

  it('marks the payout REVERSED on transfer.reversed', async () => {
    const { service, markFailed } = makeDeps();
    const raw = body({
      event: 'transfer.reversed',
      data: { id: 8, reference: 'release:tx-1', transfer_code: 'TRF_1', status: 'reversed' },
    });

    await service.handlePaystackEvent(raw, 'sig');

    expect(markFailed).toHaveBeenCalledWith('release:tx-1', 'REVERSED', expect.any(String));
  });

  it('is idempotent — a re-delivered event (unique violation) is not processed again', async () => {
    const { service, handleChargeSuccess } = makeDeps({ duplicate: true });
    const raw = body({ event: 'charge.success', data: { id: 99, reference: 'mdn_ref' } });

    const result = await service.handlePaystackEvent(raw, 'sig');

    expect(result).toEqual(expect.objectContaining({ duplicate: true }));
    expect(handleChargeSuccess).not.toHaveBeenCalled();
  });

  it('completes the payout on transfer.success using the transfer reference as the idempotency key', async () => {
    const { service, markPaid } = makeDeps();
    const raw = body({
      event: 'transfer.success',
      data: { id: 7, reference: 'release:tx-1', transfer_code: 'TRF_abc' },
    });

    await service.handlePaystackEvent(raw, 'sig');

    expect(markPaid).toHaveBeenCalledWith('release:tx-1', 'TRF_abc');
  });

  it('records but does not touch payments for an unhandled event type', async () => {
    const { service, create, handleChargeSuccess } = makeDeps();
    const raw = body({ event: 'customer.created', data: { id: 1 } });

    await service.handlePaystackEvent(raw, 'sig');

    expect(create).toHaveBeenCalled();
    expect(handleChargeSuccess).not.toHaveBeenCalled();
  });

  it('rejects a signed-but-stale event older than the window without recording or processing', async () => {
    const { service, create, handleChargeSuccess } = makeDeps({ maxAge: 300 });
    const old = new Date(Date.now() - 3600_000).toISOString(); // 1h ago, window 5m
    const raw = body({
      event: 'charge.success',
      data: { id: 99, reference: 'mdn_ref', paid_at: old },
    });

    const result = await service.handlePaystackEvent(raw, 'sig');

    expect(result).toEqual(expect.objectContaining({ received: true, stale: true }));
    expect(create).not.toHaveBeenCalled();
    expect(handleChargeSuccess).not.toHaveBeenCalled();
  });

  it('processes a fresh event whose payload timestamp is within the window', async () => {
    const { service, handleChargeSuccess } = makeDeps({ maxAge: 300 });
    const fresh = new Date(Date.now() - 10_000).toISOString(); // 10s ago
    const raw = body({
      event: 'charge.success',
      data: { id: 99, reference: 'mdn_ref', created_at: fresh },
    });

    await service.handlePaystackEvent(raw, 'sig');

    expect(handleChargeSuccess).toHaveBeenCalledWith({ reference: 'mdn_ref' }, 'WEBHOOK');
  });

  it('processes normally when the payload carries no timestamp (nothing to age-check)', async () => {
    const { service, handleChargeSuccess } = makeDeps({ maxAge: 300 });
    const raw = body({ event: 'charge.success', data: { id: 99, reference: 'mdn_ref' } });

    await service.handlePaystackEvent(raw, 'sig');

    expect(handleChargeSuccess).toHaveBeenCalledWith({ reference: 'mdn_ref' }, 'WEBHOOK');
  });
});
