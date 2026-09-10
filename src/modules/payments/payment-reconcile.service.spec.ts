import { PaymentStatus } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '@/prisma/prisma.service';
import type { Env } from '@/config/env.validation';
import { PaymentReconcileService } from './payment-reconcile.service';
import type { PaymentsService } from './payments.service';

const THRESHOLD_SECONDS = 900;

function makeConfig(): ConfigService<Env, true> {
  return {
    get: jest.fn().mockReturnValue(THRESHOLD_SECONDS),
  } as unknown as ConfigService<Env, true>;
}

function makePrisma(pending: Array<{ id: string }>) {
  const payment = { findMany: jest.fn().mockResolvedValue(pending) };
  return { prisma: { payment } as unknown as PrismaService, payment };
}

function makePayments() {
  const reconcilePayment = jest.fn();
  return {
    payments: { reconcilePayment } as unknown as PaymentsService,
    reconcilePayment,
  };
}

describe('PaymentReconcileService', () => {
  it('re-verifies only PENDING payments older than the threshold', async () => {
    const { prisma, payment } = makePrisma([]);
    const { payments } = makePayments();
    const service = new PaymentReconcileService(prisma, payments, makeConfig());
    const now = new Date('2026-09-10T12:00:00Z');

    await service.reconcilePending(now);

    const where = payment.findMany.mock.calls[0][0].where;
    expect(where.status).toBe(PaymentStatus.PENDING);
    expect(where.createdAt.lt).toEqual(
      new Date(now.getTime() - THRESHOLD_SECONDS * 1000),
    );
  });

  it('counts a payment that reconciles to SUCCESS', async () => {
    const { prisma } = makePrisma([{ id: 'pay-1' }, { id: 'pay-2' }]);
    const { payments, reconcilePayment } = makePayments();
    reconcilePayment
      .mockResolvedValueOnce({ status: PaymentStatus.SUCCESS })
      .mockResolvedValueOnce({ status: PaymentStatus.PENDING });

    const service = new PaymentReconcileService(prisma, payments, makeConfig());
    const result = await service.reconcilePending();

    expect(reconcilePayment).toHaveBeenCalledWith('pay-1');
    expect(reconcilePayment).toHaveBeenCalledWith('pay-2');
    expect(result).toEqual({ checked: 2, protected: 1 });
  });

  it('skips a payment whose reconcile throws (amount mismatch / Paystack outage) and keeps scanning', async () => {
    const { prisma } = makePrisma([{ id: 'pay-1' }, { id: 'pay-2' }]);
    const { payments, reconcilePayment } = makePayments();
    reconcilePayment
      .mockRejectedValueOnce(new Error('amount mismatch'))
      .mockResolvedValueOnce({ status: PaymentStatus.SUCCESS });

    const service = new PaymentReconcileService(prisma, payments, makeConfig());
    const result = await service.reconcilePending();

    expect(result).toEqual({ checked: 2, protected: 1 });
  });

  it('never releases funds — it only drives the protect path', async () => {
    const { prisma } = makePrisma([{ id: 'pay-1' }]);
    const { payments, reconcilePayment } = makePayments();
    reconcilePayment.mockResolvedValue({ status: PaymentStatus.SUCCESS });
    const service = new PaymentReconcileService(prisma, payments, makeConfig());

    await service.reconcilePending();

    // The only collaborator touched is the verify+protect seam.
    expect(reconcilePayment).toHaveBeenCalledTimes(1);
  });
});
