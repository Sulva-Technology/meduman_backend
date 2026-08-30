import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActorType, FeeModel, PayoutStatus } from '@prisma/client';
import type { PrismaService } from '@/prisma/prisma.service';
import type { PaystackService } from '@/common/paystack/paystack.service';
import type { TransactionsService } from '@/modules/transactions/transactions.service';
import type { AuditService } from '@/modules/audit/audit.service';
import { PayoutsService } from './payouts.service';

function makeDeps(opts: {
  tx?: Record<string, unknown> | null;
  existingPayout?: Record<string, unknown> | null;
  createThrowsP2002?: boolean;
  /** undefined = an onboarded seller; null = no seller profile at all. */
  sellerProfile?: Record<string, unknown> | null;
  openDisputes?: number;
  transferRejectsWith?: Error;
  verifiedTransfer?: Record<string, unknown> | null;
}) {
  const prisma = {
    transaction: { findUnique: jest.fn().mockResolvedValue(opts.tx ?? null) },
    sellerProfile: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.sellerProfile === undefined
            ? { userId: 'seller-1', providerRecipientCode: 'RCP_seller_1' }
            : opts.sellerProfile,
        ),
    },
    dispute: { count: jest.fn().mockResolvedValue(opts.openDisputes ?? 0) },
    payout: {
      findUnique: jest.fn().mockResolvedValue(opts.existingPayout ?? null),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        if (opts.createThrowsP2002) {
          return Promise.reject(Object.assign(new Error('unique'), { code: 'P2002' }));
        }
        return Promise.resolve({ id: 'payout-1', status: PayoutStatus.PENDING, ...data });
      }),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'payout-1', ...opts.existingPayout, ...data }),
        ),
    },
  };
  const transactions = { apply: jest.fn().mockResolvedValue({}) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const paystack = {
    initiateTransfer: opts.transferRejectsWith
      ? jest.fn().mockRejectedValue(opts.transferRejectsWith)
      : jest.fn().mockResolvedValue({
          transferCode: 'TRF_1',
          status: 'pending',
          reference: 'release:tx-1',
        }),
    verifyTransfer: jest.fn().mockResolvedValue(opts.verifiedTransfer ?? null),
  };
  return {
    prisma: prisma as unknown as PrismaService,
    transactions: transactions as unknown as TransactionsService,
    paystack: paystack as unknown as PaystackService,
    audit: audit as unknown as AuditService,
    spies: { prisma, transactions, paystack, audit },
  };
}

const releasingTx = {
  id: 'tx-1',
  sellerId: 'seller-1',
  status: 'RELEASE_PROCESSING',
  amount: 500000,
  currency: 'NGN',
  feeModel: 'BUYER_PAYS',
  feeAmount: 25000,
};

describe('FeeModel contract (decision D-3)', () => {
  it('offers exactly two fee models: SPLIT was removed because it under-collected the fee', () => {
    expect(Object.values(FeeModel).sort()).toEqual(['BUYER_PAYS', 'SELLER_PAYS']);
  });
});

describe('PayoutsService.executeRelease', () => {
  it('authorizes one idempotent payout keyed per transaction, full amount when the buyer pays the fee', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({ tx: releasingTx });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.executeRelease('tx-1');

    expect(spies.prisma.payout.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          transactionId: 'tx-1',
          sellerId: 'seller-1',
          idempotencyKey: 'release:tx-1',
          amount: 500000,
          status: PayoutStatus.PENDING,
        }),
      }),
    );
  });

  it('inherits the owning merchant from the transaction so an EaaS payout stays tenant-scoped', async () => {
    const { prisma, transactions, paystack, audit } = makeDeps({
      tx: { ...releasingTx, merchantId: 'merchant-1' },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.executeRelease('tx-1');

    expect((prisma.payout.create as jest.Mock).mock.calls[0][0].data.merchantId).toBe('merchant-1');
  });

  it('leaves merchantId unset for a first-party transaction', async () => {
    const { prisma, transactions, paystack, audit } = makeDeps({ tx: releasingTx });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.executeRelease('tx-1');

    expect((prisma.payout.create as jest.Mock).mock.calls[0][0].data.merchantId).toBeUndefined();
  });

  it('deducts the platform fee from the seller settlement when the seller pays the fee', async () => {
    const { prisma, transactions, paystack, audit } = makeDeps({
      tx: { ...releasingTx, feeModel: 'SELLER_PAYS' },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.executeRelease('tx-1');

    expect((prisma.payout.create as jest.Mock).mock.calls[0][0].data.amount).toBe(475000);
  });

  it('is idempotent: a duplicate release reuses the existing payout, never creating a second (rule 4)', async () => {
    const existing = {
      id: 'payout-1',
      idempotencyKey: 'release:tx-1',
      status: PayoutStatus.PROCESSING,
      providerTransferCode: 'TRF_1',
    };
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      tx: releasingTx,
      existingPayout: existing,
      createThrowsP2002: true,
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    const payout = await service.executeRelease('tx-1');

    expect(payout.id).toBe('payout-1');
    expect(spies.prisma.payout.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: 'release:tx-1' },
    });
  });

  it('refuses to authorize a payout unless the transaction is in RELEASE_PROCESSING (rule 3)', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      tx: { ...releasingTx, status: 'PAYMENT_PROTECTED' },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await expect(service.executeRelease('tx-1')).rejects.toThrow(/RELEASE_PROCESSING/);
    expect(spies.prisma.payout.create).not.toHaveBeenCalled();
  });

  it('throws NotFound for an unknown transaction', async () => {
    const { prisma, transactions, paystack, audit } = makeDeps({ tx: null });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await expect(service.executeRelease('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PayoutsService.executeRelease transfer initiation (decision D-0)', () => {
  it('sends the transfer to the seller recipient using the idempotency key as the Paystack reference', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({ tx: releasingTx });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.executeRelease('tx-1');

    expect(spies.paystack.initiateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 500000,
        recipient: 'RCP_seller_1',
        reference: 'release:tx-1',
      }),
    );
    expect(spies.prisma.payout.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: 'release:tx-1' },
        data: expect.objectContaining({
          providerTransferCode: 'TRF_1',
          status: PayoutStatus.PROCESSING,
        }),
      }),
    );
  });

  it('never sends a second transfer for a payout that already carries a transfer code (rule 4)', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      tx: releasingTx,
      existingPayout: {
        id: 'payout-1',
        idempotencyKey: 'release:tx-1',
        status: PayoutStatus.PROCESSING,
        providerTransferCode: 'TRF_already_sent',
      },
      createThrowsP2002: true,
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.executeRelease('tx-1');

    expect(spies.paystack.initiateTransfer).not.toHaveBeenCalled();
  });

  it('never sends a transfer for a payout already marked SUCCESS (rule 4)', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      tx: releasingTx,
      existingPayout: {
        id: 'payout-1',
        idempotencyKey: 'release:tx-1',
        status: PayoutStatus.SUCCESS,
      },
      createThrowsP2002: true,
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.executeRelease('tx-1');

    expect(spies.paystack.initiateTransfer).not.toHaveBeenCalled();
  });

  it('refuses to transfer when the seller has no onboarded payout destination', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      tx: releasingTx,
      sellerProfile: { userId: 'seller-1', providerRecipientCode: null },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await expect(service.executeRelease('tx-1')).rejects.toThrow(/payout destination/i);
    expect(spies.paystack.initiateTransfer).not.toHaveBeenCalled();
  });

  it('refuses to transfer while a dispute is open on the transaction (rule 5)', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      tx: releasingTx,
      openDisputes: 1,
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await expect(service.executeRelease('tx-1')).rejects.toBeInstanceOf(ConflictException);
    expect(spies.paystack.initiateTransfer).not.toHaveBeenCalled();
  });

  it('recovers the transfer code from Paystack when the reference was already used (crash after send)', async () => {
    // Sent to Paystack, then we died before persisting the code. The retry must
    // adopt the existing transfer rather than treat the duplicate-reference
    // error as a failure, and must certainly not pay twice.
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      tx: releasingTx,
      transferRejectsWith: new Error('Transfer reference has been used before'),
      verifiedTransfer: { transferCode: 'TRF_recovered', status: 'success' },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.executeRelease('tx-1');

    expect(spies.paystack.verifyTransfer).toHaveBeenCalledWith('release:tx-1');
    expect(spies.prisma.payout.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ providerTransferCode: 'TRF_recovered' }),
      }),
    );
  });

  it('records the failure on the payout and rethrows when Paystack rejects the transfer outright', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      tx: releasingTx,
      transferRejectsWith: new Error('Insufficient balance'),
      verifiedTransfer: null,
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await expect(service.executeRelease('tx-1')).rejects.toThrow(/Insufficient balance/);
    expect(spies.prisma.payout.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: expect.stringContaining('Insufficient balance'),
        }),
      }),
    );
    expect(spies.transactions.apply).not.toHaveBeenCalled();
  });
});

describe('PayoutsService.retryTransfer (operator recovery)', () => {
  const failedPayout = {
    id: 'payout-1',
    transactionId: 'tx-1',
    sellerId: 'seller-1',
    idempotencyKey: 'release:tx-1',
    providerTransferReference: 'release:tx-1',
    providerTransferCode: 'TRF_dead',
    amount: 500000,
    attemptCount: 1,
    status: PayoutStatus.FAILED,
  };

  it('sends a fresh provider reference, because Paystack refuses to reuse the failed one', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      existingPayout: failedPayout,
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.retryTransfer('release:tx-1', 'admin-1');

    expect(spies.paystack.initiateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 500000,
        recipient: 'RCP_seller_1',
        reference: 'release:tx-1:r2',
      }),
    );
  });

  it('adopts a prior transfer that actually succeeded instead of paying a second time (rule 4)', async () => {
    // The failure webhook and reality disagreed — Paystack says the original
    // transfer went through. Paying again would double-release.
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      existingPayout: failedPayout,
      verifiedTransfer: { transferCode: 'TRF_dead', status: 'success' },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.retryTransfer('release:tx-1', 'admin-1');

    expect(spies.paystack.initiateTransfer).not.toHaveBeenCalled();
    expect(spies.transactions.apply).toHaveBeenCalledWith(
      expect.objectContaining({ event: { type: 'PAYOUT_SUCCEEDED' } }),
    );
  });

  it('refuses to retry a payout that already settled (rule 4)', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      existingPayout: { ...failedPayout, status: PayoutStatus.SUCCESS },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await expect(service.retryTransfer('release:tx-1', 'admin-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(spies.paystack.initiateTransfer).not.toHaveBeenCalled();
  });

  it('refuses to retry a transfer that is still in flight', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      existingPayout: { ...failedPayout, status: PayoutStatus.PROCESSING },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await expect(service.retryTransfer('release:tx-1', 'admin-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(spies.paystack.initiateTransfer).not.toHaveBeenCalled();
  });

  it('records the retry against the admin who ordered it (rule 6)', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      existingPayout: failedPayout,
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.retryTransfer('release:tx-1', 'admin-1');

    expect(spies.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payout.transfer_retried',
        actorId: 'admin-1',
        actorType: ActorType.ADMIN,
        targetId: 'payout-1',
      }),
    );
  });
});

describe('Payout audit trail (rule 6)', () => {
  it('writes an audit row when the transfer is sent, carrying the provider transfer code', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({ tx: releasingTx });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.executeRelease('tx-1');

    expect(spies.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payout.transfer_sent',
        targetType: 'Payout',
        actorType: ActorType.SYSTEM,
        metadata: expect.objectContaining({
          transactionId: 'tx-1',
          amount: 500000,
          providerTransferCode: 'TRF_1',
        }),
      }),
    );
  });

  it('writes an audit row when Paystack rejects the transfer outright', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      tx: releasingTx,
      transferRejectsWith: new Error('Insufficient balance'),
      verifiedTransfer: null,
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await expect(service.executeRelease('tx-1')).rejects.toThrow(/Insufficient balance/);

    expect(spies.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payout.transfer_send_failed',
        reason: expect.stringContaining('Insufficient balance'),
      }),
    );
  });

  it('writes an audit row when a signed webhook reports the transfer failed or reversed', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      existingPayout: {
        id: 'payout-1',
        transactionId: 'tx-1',
        idempotencyKey: 'release:tx-1',
        status: PayoutStatus.PROCESSING,
      },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.markFailed('release:tx-1', PayoutStatus.REVERSED, 'reversed by bank');

    expect(spies.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payout.transfer_reversed',
        targetType: 'Payout',
        targetId: 'payout-1',
        reason: 'reversed by bank',
      }),
    );
  });

  it('writes no audit row when a late failure webhook is ignored for a settled payout', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      existingPayout: {
        id: 'payout-1',
        transactionId: 'tx-1',
        idempotencyKey: 'release:tx-1',
        status: PayoutStatus.SUCCESS,
      },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.markFailed('release:tx-1', PayoutStatus.FAILED, 'late failure webhook');

    expect(spies.audit.log).not.toHaveBeenCalled();
  });
});

describe('PayoutsService.markPaid', () => {
  it('marks the payout SUCCESS and drives PAYOUT_SUCCEEDED to complete the transaction', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      existingPayout: {
        id: 'payout-1',
        transactionId: 'tx-1',
        idempotencyKey: 'release:tx-1',
        status: PayoutStatus.PROCESSING,
      },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.markPaid('release:tx-1', 'TRF_abc123');

    expect(spies.prisma.payout.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PayoutStatus.SUCCESS,
          providerTransferCode: 'TRF_abc123',
        }),
      }),
    );
    expect(spies.transactions.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx-1',
        event: { type: 'PAYOUT_SUCCEEDED' },
        actor: expect.objectContaining({ type: ActorType.SYSTEM }),
      }),
    );
  });

  it('is idempotent: an already-SUCCESS payout never re-drives the machine (rule 4)', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      existingPayout: {
        id: 'payout-1',
        transactionId: 'tx-1',
        idempotencyKey: 'release:tx-1',
        status: PayoutStatus.SUCCESS,
      },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.markPaid('release:tx-1', 'TRF_abc123');

    expect(spies.transactions.apply).not.toHaveBeenCalled();
    expect(spies.prisma.payout.update).not.toHaveBeenCalled();
  });

  it('throws NotFound when no payout matches the idempotency key', async () => {
    const { prisma, transactions, paystack, audit } = makeDeps({ existingPayout: null });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await expect(service.markPaid('release:missing', 'TRF_x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('PayoutsService.markFailed', () => {
  it('marks the payout FAILED with the provider reason and leaves the transaction frozen', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      existingPayout: {
        id: 'payout-1',
        transactionId: 'tx-1',
        idempotencyKey: 'release:tx-1',
        status: PayoutStatus.PROCESSING,
      },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.markFailed('release:tx-1', PayoutStatus.FAILED, 'account closed');

    expect(spies.prisma.payout.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PayoutStatus.FAILED,
          lastError: 'account closed',
        }),
      }),
    );
    // No state transition: the money did not move, so the transaction stays in
    // RELEASE_PROCESSING for an operator to retry. Never silently completed.
    expect(spies.transactions.apply).not.toHaveBeenCalled();
  });

  it('records a reversal distinctly from an outright failure', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      existingPayout: {
        id: 'payout-1',
        transactionId: 'tx-1',
        idempotencyKey: 'release:tx-1',
        status: PayoutStatus.PROCESSING,
      },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.markFailed('release:tx-1', PayoutStatus.REVERSED, 'reversed by bank');

    expect(spies.prisma.payout.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PayoutStatus.REVERSED }),
      }),
    );
  });

  it('never downgrades a payout that already settled successfully (rule 4)', async () => {
    const { prisma, transactions, paystack, audit, spies } = makeDeps({
      existingPayout: {
        id: 'payout-1',
        transactionId: 'tx-1',
        idempotencyKey: 'release:tx-1',
        status: PayoutStatus.SUCCESS,
      },
    });
    const service = new PayoutsService(prisma, transactions, paystack, audit);

    await service.markFailed('release:tx-1', PayoutStatus.FAILED, 'late failure webhook');

    expect(spies.prisma.payout.update).not.toHaveBeenCalled();
  });
});
