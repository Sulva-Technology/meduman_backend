import { ForbiddenException } from '@nestjs/common';
import { ActorType, OtpPurpose } from '@prisma/client';
import type { SupabaseJwtClaims } from '@/modules/auth';
import type { TransactionsService } from '@/modules/transactions/transactions.service';
import type { QueueService } from '@/modules/queue/queue.service';
import { OtpController } from './otp.controller';
import type { OtpService } from './otp.service';

const buyer: SupabaseJwtClaims = {
  sub: 'buyer-1',
  email: 'b@example.com',
  role: 'authenticated',
  appRole: 'BUYER',
  raw: { sub: 'buyer-1' },
};

const stranger: SupabaseJwtClaims = { ...buyer, sub: 'someone-else' };

function makeController(txRow: Record<string, unknown> = { id: 'tx-1', buyerId: 'buyer-1' }) {
  const otp = {
    issue: jest.fn().mockResolvedValue({ otpId: 'otp-1', code: '424242', expiresAt: new Date() }),
    verify: jest.fn().mockResolvedValue(undefined),
  };
  const transactions = {
    getById: jest.fn().mockResolvedValue(txRow),
    apply: jest.fn().mockResolvedValue({ id: 'tx-1', status: 'RELEASE_PROCESSING' }),
  };
  const queue = { enqueueRelease: jest.fn().mockResolvedValue(undefined) };
  const controller = new OtpController(
    otp as unknown as OtpService,
    transactions as unknown as TransactionsService,
    queue as unknown as QueueService,
  );
  return { controller, otp, transactions, queue };
}

describe('OtpController.request', () => {
  it('issues a delivery-confirmation code for the buyer and never returns the code', async () => {
    const { controller, otp } = makeController();

    const res = await controller.request(buyer, 'tx-1');

    expect(otp.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx-1',
        purpose: OtpPurpose.DELIVERY_CONFIRMATION,
        actor: expect.objectContaining({ id: 'buyer-1', type: ActorType.USER, role: 'BUYER' }),
      }),
    );
    expect(res).toHaveProperty('otpId', 'otp-1');
    expect(res).not.toHaveProperty('code');
  });

  it('forbids a non-buyer from requesting a code', async () => {
    const { controller, otp } = makeController();

    await expect(controller.request(stranger, 'tx-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(otp.issue).not.toHaveBeenCalled();
  });
});

describe('OtpController.confirm', () => {
  it('verifies the code, drives BUYER_CONFIRM, then enqueues release', async () => {
    const { controller, otp, transactions, queue } = makeController();

    const res = await controller.confirm(buyer, 'tx-1', { code: '424242' });

    expect(otp.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx-1',
        purpose: OtpPurpose.DELIVERY_CONFIRMATION,
        code: '424242',
      }),
    );
    expect(transactions.apply).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-1', event: { type: 'BUYER_CONFIRM' } }),
    );
    expect(queue.enqueueRelease).toHaveBeenCalledWith('tx-1');
    expect(res).toMatchObject({ status: 'RELEASE_PROCESSING' });
  });

  it('does not confirm or enqueue if OTP verification fails', async () => {
    const { controller, otp, transactions, queue } = makeController();
    otp.verify.mockRejectedValueOnce(new Error('bad code'));

    await expect(controller.confirm(buyer, 'tx-1', { code: '000000' })).rejects.toThrow('bad code');
    expect(transactions.apply).not.toHaveBeenCalled();
    expect(queue.enqueueRelease).not.toHaveBeenCalled();
  });

  it('forbids a non-buyer from confirming', async () => {
    const { controller, otp } = makeController();

    await expect(controller.confirm(stranger, 'tx-1', { code: '424242' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(otp.verify).not.toHaveBeenCalled();
  });
});
