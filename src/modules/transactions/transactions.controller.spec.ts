import { ForbiddenException } from '@nestjs/common';
import type { SupabaseJwtClaims } from '@/modules/auth';
import type { QueueService } from '@/modules/queue/queue.service';
import { TransactionsController } from './transactions.controller';
import type { TransactionsService } from './transactions.service';

function claims(sub: string, appRole = 'SELLER'): SupabaseJwtClaims {
  return { sub, email: `${sub}@x.com`, role: 'authenticated', appRole, raw: { sub } };
}

function makeCtl(
  tx: Record<string, unknown> = { id: 'tx-1', sellerId: 'seller-1', buyerId: 'buyer-1' },
) {
  const transactions = {
    createDraft: jest.fn().mockResolvedValue({ id: 'tx-1', status: 'DRAFT' }),
    getById: jest.fn().mockResolvedValue(tx),
    apply: jest.fn().mockResolvedValue({ id: 'tx-1', status: 'RELEASE_PROCESSING' }),
  };
  const queue = { enqueueRelease: jest.fn().mockResolvedValue(undefined) };
  const controller = new TransactionsController(
    transactions as unknown as TransactionsService,
    queue as unknown as QueueService,
  );
  return { controller, transactions, queue };
}

describe('TransactionsController.create', () => {
  it('creates a draft owned by the calling seller', async () => {
    const { controller, transactions } = makeCtl();

    await controller.create(claims('seller-1'), { title: 'Item', amount: 100000 });

    expect(transactions.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ sellerId: 'seller-1', title: 'Item', amount: 100000 }),
    );
  });
});

describe('TransactionsController seller lifecycle', () => {
  it('publish drives SELLER_PUBLISH for the owner', async () => {
    const { controller, transactions } = makeCtl();

    await controller.publish(claims('seller-1'), 'tx-1');

    expect(transactions.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx-1',
        event: { type: 'SELLER_PUBLISH' },
        actor: expect.objectContaining({ id: 'seller-1', role: 'SELLER' }),
      }),
    );
  });

  it('rejects a seller action from someone who is not the seller', async () => {
    const { controller, transactions } = makeCtl();

    await expect(controller.publish(claims('intruder'), 'tx-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(transactions.apply).not.toHaveBeenCalled();
  });
});

describe('TransactionsController.confirm', () => {
  it('lets the buyer confirm and enqueues the release', async () => {
    const { controller, transactions, queue } = makeCtl();

    await controller.confirm(claims('buyer-1', 'BUYER'), 'tx-1');

    expect(transactions.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx-1',
        event: { type: 'BUYER_CONFIRM' },
        actor: expect.objectContaining({ id: 'buyer-1', role: 'BUYER' }),
      }),
    );
    expect(queue.enqueueRelease).toHaveBeenCalledWith('tx-1');
  });

  it('rejects confirmation from someone who is not the buyer', async () => {
    const { controller, transactions, queue } = makeCtl();

    await expect(controller.confirm(claims('intruder', 'BUYER'), 'tx-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(transactions.apply).not.toHaveBeenCalled();
    expect(queue.enqueueRelease).not.toHaveBeenCalled();
  });

  it('does not enqueue a release if confirmation is refused by the machine', async () => {
    const { controller, transactions, queue } = makeCtl();
    transactions.apply.mockRejectedValueOnce(new Error('dispute open'));

    await expect(controller.confirm(claims('buyer-1', 'BUYER'), 'tx-1')).rejects.toThrow(
      'dispute open',
    );
    expect(queue.enqueueRelease).not.toHaveBeenCalled();
  });
});

describe('TransactionsController.get', () => {
  it('returns the transaction for a participant', async () => {
    const { controller } = makeCtl();

    await expect(controller.get(claims('buyer-1', 'BUYER'), 'tx-1')).resolves.toEqual(
      expect.objectContaining({ id: 'tx-1' }),
    );
  });

  it('forbids a non-participant, non-admin caller', async () => {
    const { controller } = makeCtl();

    await expect(controller.get(claims('stranger', 'BUYER'), 'tx-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows an admin to read any transaction', async () => {
    const { controller } = makeCtl();

    await expect(controller.get(claims('admin-9', 'ADMIN'), 'tx-1')).resolves.toEqual(
      expect.objectContaining({ id: 'tx-1' }),
    );
  });
});
